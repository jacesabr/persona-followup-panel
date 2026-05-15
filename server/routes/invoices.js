import express from "express";
import { randomUUID } from "node:crypto";
import pool from "../db.js";
import { requireAdmin } from "../middleware/auth.js";
import { getStorage } from "../storage.js";

const router = express.Router();

// Heavier JSON parser scoped to the company-settings PUT endpoint so a
// logo + signature PNG (base64) doesn't get truncated by the app-level
// 1mb default. Two ~500KB binary PNGs encode to ~1.4MB combined; 4mb
// gives generous headroom without inviting arbitrary blob dumps on the
// general API surface.
const heavyJson = express.json({ limit: "4mb" });

// Raw-body parser for the PDF upload endpoint. 10mb gives headroom
// for very long multi-page invoices while still capping abuse.
const rawPdf = express.raw({ type: "application/pdf", limit: "10mb" });

// Append-only R2 backup of an invoice mutation. Every event lands at
// a unique key — never overwrites — so the bucket itself is the
// audit trail. Memory rule: "never delete R2 blobs even when deleting
// rows." If the storage write fails we surface the error to the
// admin: rather than silently lose audit data, the operator sees the
// problem and can retry once R2 is reachable.
async function backupInvoiceEvent(event, invoice) {
  if (!invoice) return;
  const storage = await getStorage();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fy = invoice.fy;
  const num = (invoice.invoiceNumber || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
  const key = `invoices/${fy}/${num}/${event}-${ts}.json`;
  const body = Buffer.from(JSON.stringify({ event, at: new Date().toISOString(), invoice }, null, 2));
  await storage.putBlob({ key, body, contentType: "application/json" });
}

async function backupCompanySettings(snapshot) {
  const storage = await getStorage();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `company-settings/${ts}.json`;
  const body = Buffer.from(JSON.stringify({ at: new Date().toISOString(), snapshot }, null, 2));
  await storage.putBlob({ key, body, contentType: "application/json" });
}

const VALID_TYPES = new Set(["retail", "b2b", "b2b_lut", "b2b_intl"]);

// Compute FY (April → March) for a date string YYYY-MM-DD. Matches the
// numberToFinancialYear logic the frontend used so the invoice number
// suggestion stays stable across both sides.
function fyFor(isoDate) {
  if (!isoDate) {
    const d = new Date();
    return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  }
  const [y, m] = isoDate.split("-").map((v) => parseInt(v, 10));
  // m is 1-12; FY starts in April (m=4).
  return m >= 4 ? y : y - 1;
}

// Returns true when the invoice type needs both company state and
// customer state to choose between CGST+SGST (same state) and IGST
// (different state). LUT + International are GST-zero so they don't
// care about either side's state.
function needsStateForTax(type) {
  return type === "retail" || type === "b2b";
}

// Recompute totals server-side from line items + customer state so the
// client cannot drift the stored amounts away from what the tax rules
// imply. The frontend computes the same thing for live UI, but the DB
// trusts the server's recomputation only.
//
// Defensive: if either side's state is missing, return tax_type='unset'
// rather than silently picking IGST. Without this clause, an unset
// company state would compare unequal to any customer state and the
// fall-through path would slap 18% IGST on every retail/B2B invoice —
// wrong, and only self-corrects after the operator notices. The
// POST/PUT handlers also reject the call up front when company state
// is missing on a GST-bearing type; this clause is the second line of
// defence.
function recomputeTotals(type, customer, lineItems, companyState) {
  const sub = lineItems.reduce((acc, li) => {
    if (type === "retail") return acc + (Number(li.amount) || 0);
    return acc + (Number(li.commission) || 0);
  }, 0);
  if (type === "b2b_lut" || type === "b2b_intl") {
    return { subtotal: sub, cgst: 0, sgst: 0, igst: 0, tax_type: "none", grand_total: sub };
  }
  const custState = (customer?.state || "").trim().toLowerCase();
  const coState = (companyState || "").trim().toLowerCase();
  if (!custState || !coState) {
    return { subtotal: sub, cgst: 0, sgst: 0, igst: 0, tax_type: "unset", grand_total: sub };
  }
  if (custState === coState) {
    const c = +(sub * 0.09).toFixed(2);
    const s = +(sub * 0.09).toFixed(2);
    return { subtotal: sub, cgst: c, sgst: s, igst: 0, tax_type: "intra", grand_total: +(sub + c + s).toFixed(2) };
  }
  const i = +(sub * 0.18).toFixed(2);
  return { subtotal: sub, cgst: 0, sgst: 0, igst: i, tax_type: "inter", grand_total: +(sub + i).toFixed(2) };
}

function rowToInvoice(row, lineItems) {
  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    type: row.invoice_type,
    date: row.invoice_date instanceof Date ? row.invoice_date.toISOString().slice(0, 10) : row.invoice_date,
    fy: row.fy,
    customer: row.customer || {},
    currency: row.currency || null,
    notes: row.notes || "",
    subtotal: Number(row.subtotal),
    cgst: Number(row.cgst),
    sgst: Number(row.sgst),
    igst: Number(row.igst),
    grandTotal: Number(row.grand_total),
    taxType: row.tax_type,
    lutN: row.lut_n_snapshot || null,
    lutDate: row.lut_date_snapshot || null,
    approved: row.approved,
    approvedAt: row.approved_at,
    approvedByAdmin: row.approved_by_admin,
    createdByAdmin: row.created_by_admin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lineItems: lineItems.map((li) => ({
      id: String(li.id),
      position: li.position,
      amount: Number(li.amount),
      commission: Number(li.commission),
      ...(li.data || {}),
    })),
  };
}

// ============================================================
// Company settings
// ============================================================

router.get("/company-settings", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT data, logo_base64, signature_base64, updated_at, updated_by_admin
         FROM company_settings WHERE id = 1`
    );
    if (rows.length === 0) {
      return res.json({
        data: {},
        logoBase64: null,
        signatureBase64: null,
        updatedAt: null,
        updatedByAdmin: null,
      });
    }
    const r = rows[0];
    res.json({
      data: r.data || {},
      logoBase64: r.logo_base64,
      signatureBase64: r.signature_base64,
      updatedAt: r.updated_at,
      updatedByAdmin: r.updated_by_admin,
    });
  } catch (e) {
    next(e);
  }
});

// PUT replaces the data blob entirely. Logo + signature are optional:
// pass null to clear, omit the key to leave unchanged. Heavy JSON limit
// (4mb) only applies to this route.
router.put("/company-settings", heavyJson, requireAdmin, async (req, res, next) => {
  try {
    const { data, logoBase64, signatureBase64 } = req.body || {};
    if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) {
      return res.status(400).json({ error: "data must be an object" });
    }
    if (logoBase64 !== undefined && logoBase64 !== null && typeof logoBase64 !== "string") {
      return res.status(400).json({ error: "logoBase64 must be a string or null" });
    }
    if (signatureBase64 !== undefined && signatureBase64 !== null && typeof signatureBase64 !== "string") {
      return res.status(400).json({ error: "signatureBase64 must be a string or null" });
    }
    // Size cap on the base64 strings — guard against a misbehaving
    // client posting a huge file. ~1.5MB encoded each is plenty for
    // logo + signature PNGs.
    if (logoBase64 && logoBase64.length > 1_500_000) {
      return res.status(413).json({ error: "logo too large (max ~1.1MB binary)" });
    }
    if (signatureBase64 && signatureBase64.length > 1_500_000) {
      return res.status(413).json({ error: "signature too large (max ~1.1MB binary)" });
    }

    const adminName = req.user?.adminUsername || null;

    // Fetch existing row so we can do a partial update without losing
    // the columns the caller didn't send.
    const { rows: existingRows } = await pool.query(
      `SELECT data, logo_base64, signature_base64 FROM company_settings WHERE id = 1`
    );
    const existing = existingRows[0] || {};

    const nextData = data === undefined ? (existing.data || {}) : data;
    const nextLogo = logoBase64 === undefined ? (existing.logo_base64 || null) : logoBase64;
    const nextSig = signatureBase64 === undefined ? (existing.signature_base64 || null) : signatureBase64;

    await pool.query(
      `INSERT INTO company_settings (id, data, logo_base64, signature_base64, updated_at, updated_by_admin)
       VALUES (1, $1::jsonb, $2, $3, NOW(), $4)
       ON CONFLICT (id) DO UPDATE
         SET data = EXCLUDED.data,
             logo_base64 = EXCLUDED.logo_base64,
             signature_base64 = EXCLUDED.signature_base64,
             updated_at = NOW(),
             updated_by_admin = EXCLUDED.updated_by_admin`,
      [JSON.stringify(nextData), nextLogo, nextSig, adminName]
    );

    // Backup the full settings snapshot (including base64 logo + signature)
    // to R2 BEFORE returning. Banking-info history is preserved across
    // every change so an old invoice's audit trail still resolves to the
    // bank account that was current at the time. Sync (not fire-and-forget):
    // if R2 is down we'd rather the admin see the error and retry than
    // silently lose the audit row.
    await backupCompanySettings({
      data: nextData,
      logoBase64: nextLogo,
      signatureBase64: nextSig,
      updatedByAdmin: adminName,
    });

    res.json({
      data: nextData,
      logoBase64: nextLogo,
      signatureBase64: nextSig,
      updatedAt: new Date().toISOString(),
      updatedByAdmin: adminName,
    });
  } catch (e) {
    next(e);
  }
});

// ============================================================
// Invoices
// ============================================================

router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { from, to, type } = req.query;
    const conditions = [];
    const params = [];
    if (from) {
      params.push(from);
      conditions.push(`invoice_date >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`invoice_date <= $${params.length}`);
    }
    if (type && VALID_TYPES.has(type)) {
      params.push(type);
      conditions.push(`invoice_type = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT * FROM invoices ${where} ORDER BY invoice_date DESC, created_at DESC`,
      params
    );
    // Return list rows without line items for speed; detail endpoint
    // fetches line items per invoice.
    res.json(rows.map((r) => rowToInvoice(r, [])));
  } catch (e) {
    next(e);
  }
});

router.get("/next-number", requireAdmin, async (req, res, next) => {
  try {
    const fy = parseInt(req.query.fy, 10) || fyFor(null);
    const { rows } = await pool.query(
      `SELECT invoice_number FROM invoices WHERE fy = $1`,
      [fy]
    );
    const re = new RegExp(`^PD-(\\d+)-${fy}$`);
    const nums = rows
      .map((r) => (r.invoice_number || "").match(re))
      .filter(Boolean)
      .map((m) => parseInt(m[1], 10));
    const next = (nums.length ? Math.max(...nums) : 0) + 1;
    res.json({ invoiceNumber: `PD-${next}-${fy}`, fy });
  } catch (e) {
    next(e);
  }
});

router.get("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "invoice not found" });
    const { rows: liRows } = await pool.query(
      `SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position ASC, id ASC`,
      [req.params.id]
    );
    res.json(rowToInvoice(rows[0], liRows));
  } catch (e) {
    next(e);
  }
});

router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const payload = req.body || {};
    const error = validateInvoicePayload(payload, { mode: "create" });
    if (error) return res.status(400).json({ error });

    const { rows: coRows } = await pool.query(
      `SELECT data FROM company_settings WHERE id = 1`
    );
    const companyState = coRows[0]?.data?.state || "";

    // GST-bearing invoices (retail / b2b India) need company state set
    // to choose intra-state (CGST+SGST) vs inter-state (IGST). Without
    // it the comparison silently fails to "unequal" and every invoice
    // defaults to 18% IGST regardless of the actual customer state —
    // wrong, and the operator only catches it after the fact. Refuse
    // up front with a message that points them at the fix.
    if (needsStateForTax(payload.type) && !companyState.trim()) {
      return res.status(400).json({
        error: "Set your company state in Invoice Info → Identity before creating GST-bearing invoices. Tax rules need it to choose between CGST+SGST and IGST.",
        code: "company_state_missing",
      });
    }
    if (needsStateForTax(payload.type) && !(payload.customer?.state || "").trim()) {
      return res.status(400).json({
        error: "Pick the customer's state before saving — GST rules switch between intra-state (CGST+SGST) and inter-state (IGST) based on whether the customer is in your state.",
        code: "customer_state_missing",
      });
    }

    const id = "inv_" + randomUUID().replace(/-/g, "").slice(0, 16);
    const date = payload.date || new Date().toISOString().slice(0, 10);
    const fy = fyFor(date);
    const totals = recomputeTotals(payload.type, payload.customer || {}, payload.lineItems || [], companyState);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO invoices
            (id, invoice_number, invoice_type, invoice_date, fy, customer, currency, notes,
             subtotal, cgst, sgst, igst, grand_total, tax_type, lut_n_snapshot, lut_date_snapshot,
             approved, created_by_admin)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, FALSE, $17)`,
          [
            id, payload.invoiceNumber, payload.type, date, fy,
            JSON.stringify(payload.customer || {}),
            payload.currency || null, payload.notes || "",
            totals.subtotal, totals.cgst, totals.sgst, totals.igst, totals.grand_total, totals.tax_type,
            payload.lutN || null, payload.lutDate || null,
            req.user?.adminUsername || null,
          ]
        );
      } catch (e) {
        if (e.code === "23505") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "invoice number already used" });
        }
        throw e;
      }
      await insertLineItems(client, id, payload.type, payload.lineItems || []);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const fresh = await fetchInvoice(id);
    await backupInvoiceEvent("create", fresh);
    res.status(201).json(fresh);
  } catch (e) {
    next(e);
  }
});

router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT approved FROM invoices WHERE id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: "invoice not found" });
    if (rows[0].approved) {
      return res.status(409).json({ error: "invoice is approved; cannot edit. Clear signature to revert to draft." });
    }

    const payload = req.body || {};
    const error = validateInvoicePayload(payload, { mode: "update" });
    if (error) return res.status(400).json({ error });

    const { rows: coRows } = await pool.query(`SELECT data FROM company_settings WHERE id = 1`);
    const companyState = coRows[0]?.data?.state || "";

    if (needsStateForTax(payload.type) && !companyState.trim()) {
      return res.status(400).json({
        error: "Set your company state in Invoice Info → Identity before saving GST-bearing invoices. Tax rules need it to choose between CGST+SGST and IGST.",
        code: "company_state_missing",
      });
    }
    if (needsStateForTax(payload.type) && !(payload.customer?.state || "").trim()) {
      return res.status(400).json({
        error: "Pick the customer's state before saving — GST rules switch between intra-state (CGST+SGST) and inter-state (IGST) based on whether the customer is in your state.",
        code: "customer_state_missing",
      });
    }

    const date = payload.date;
    const fy = fyFor(date);
    const totals = recomputeTotals(payload.type, payload.customer || {}, payload.lineItems || [], companyState);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(
          `UPDATE invoices
              SET invoice_number = $2, invoice_type = $3, invoice_date = $4, fy = $5,
                  customer = $6::jsonb, currency = $7, notes = $8,
                  subtotal = $9, cgst = $10, sgst = $11, igst = $12, grand_total = $13,
                  tax_type = $14, lut_n_snapshot = $15, lut_date_snapshot = $16,
                  updated_at = NOW()
            WHERE id = $1`,
          [
            req.params.id, payload.invoiceNumber, payload.type, date, fy,
            JSON.stringify(payload.customer || {}),
            payload.currency || null, payload.notes || "",
            totals.subtotal, totals.cgst, totals.sgst, totals.igst, totals.grand_total, totals.tax_type,
            payload.lutN || null, payload.lutDate || null,
          ]
        );
      } catch (e) {
        if (e.code === "23505") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "invoice number already used" });
        }
        throw e;
      }
      await client.query(`DELETE FROM invoice_line_items WHERE invoice_id = $1`, [req.params.id]);
      await insertLineItems(client, req.params.id, payload.type, payload.lineItems || []);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    const fresh = await fetchInvoice(req.params.id);
    await backupInvoiceEvent("update", fresh);
    res.json(fresh);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/approve", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, c.signature_base64 IS NOT NULL AS has_sig
         FROM invoices i, company_settings c
        WHERE i.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      // Two cases: invoice missing, OR company_settings has no row yet.
      // Disambiguate so the UI can prompt the right action.
      const { rows: invRows } = await pool.query(`SELECT 1 FROM invoices WHERE id = $1`, [req.params.id]);
      if (invRows.length === 0) return res.status(404).json({ error: "invoice not found" });
      return res.status(400).json({ error: "company signature not uploaded; go to Invoice Info → upload signature first" });
    }
    const row = rows[0];
    if (!row.has_sig) {
      return res.status(400).json({ error: "company signature not uploaded; go to Invoice Info → upload signature first" });
    }
    if (row.approved) return res.status(409).json({ error: "invoice already approved" });

    await pool.query(
      `UPDATE invoices
          SET approved = TRUE, approved_at = NOW(), approved_by_admin = $2, updated_at = NOW()
        WHERE id = $1`,
      [req.params.id, req.user?.adminUsername || null]
    );
    const fresh = await fetchInvoice(req.params.id);
    // The approve backup also embeds a snapshot of the active company
    // settings so the audit record for THIS invoice is self-contained —
    // future bank/signature changes don't retroactively edit history.
    const { rows: coRows } = await pool.query(
      `SELECT data, logo_base64, signature_base64 FROM company_settings WHERE id = 1`
    );
    await backupInvoiceEvent("approve", {
      ...fresh,
      companySettingsSnapshot: coRows[0] ? {
        data: coRows[0].data || {},
        logoBase64: coRows[0].logo_base64,
        signatureBase64: coRows[0].signature_base64,
      } : null,
    });
    res.json(fresh);
  } catch (e) {
    next(e);
  }
});

router.post("/:id/revert", requireAdmin, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE invoices
          SET approved = FALSE, approved_at = NULL, approved_by_admin = NULL, updated_at = NOW()
        WHERE id = $1`,
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: "invoice not found" });
    const fresh = await fetchInvoice(req.params.id);
    await backupInvoiceEvent("revert", fresh);
    res.json(fresh);
  } catch (e) {
    next(e);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    // Snapshot the row BEFORE deletion so the R2 audit trail records
    // what was deleted. Without this, a DELETE leaves no trace of the
    // contents (the SQL row is gone and earlier R2 snapshots reflect
    // the pre-delete state, but nothing explicitly marks the deletion
    // event itself).
    const snapshot = await fetchInvoice(req.params.id);
    if (!snapshot) return res.status(404).json({ error: "invoice not found" });
    await backupInvoiceEvent("delete", snapshot);
    await pool.query(`DELETE FROM invoices WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

// PDF backup endpoint. After the client renders an invoice PDF via
// @react-pdf/renderer (the existing in-browser path), it POSTs the
// resulting bytes here so a frozen copy lands in R2 next to the JSON
// snapshots. This is the "what the customer actually received"
// artefact. Body parser is express.raw with Content-Type:
// application/pdf — bytes pass through untouched. Same admin-only
// gate; same write-then-HEAD verification via storage.putBlob.
router.post("/:id/pdf", requireAdmin, rawPdf, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT invoice_number, fy FROM invoices WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "invoice not found" });
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: "empty body; POST application/pdf bytes" });
    }
    // Minimal magic-bytes check so a stray JSON or HTML payload doesn't
    // get stored as a fake PDF. %PDF- header is well-known and stable.
    if (body.slice(0, 5).toString("utf8") !== "%PDF-") {
      return res.status(400).json({ error: "body does not look like a PDF (missing %PDF- header)" });
    }
    const storage = await getStorage();
    const num = (rows[0].invoice_number || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    const fy = rows[0].fy;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    // Versioned key so re-renders never overwrite a previous PDF. The
    // most recent file is the one sent to the customer; the earlier
    // ones are kept as audit history.
    const key = `invoices/${fy}/${num}/${num}-${ts}.pdf`;
    const { size } = await storage.putBlob({ key, body, contentType: "application/pdf" });
    res.json({ key, size });
  } catch (e) {
    next(e);
  }
});

// ============================================================
// Helpers
// ============================================================

async function fetchInvoice(id) {
  const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
  if (rows.length === 0) return null;
  const { rows: liRows } = await pool.query(
    `SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position ASC, id ASC`,
    [id]
  );
  return rowToInvoice(rows[0], liRows);
}

async function insertLineItems(client, invoiceId, type, items) {
  for (let i = 0; i < items.length; i += 1) {
    const li = items[i] || {};
    const amount = type === "retail" ? Number(li.amount) || 0 : 0;
    const commission = type !== "retail" ? Number(li.commission) || 0 : 0;
    // Strip the structural fields from data; keep only the
    // type-specific descriptive fields. id is regenerated on read.
    const { id: _stripId, position: _stripPos, amount: _stripAmt, commission: _stripComm, ...rest } = li;
    await client.query(
      `INSERT INTO invoice_line_items (invoice_id, position, amount, commission, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [invoiceId, i + 1, amount, commission, JSON.stringify(rest)]
    );
  }
}

function validateInvoicePayload(p, { mode }) {
  if (!p || typeof p !== "object") return "body must be an object";
  if (!VALID_TYPES.has(p.type)) return "type must be one of retail, b2b, b2b_lut, b2b_intl";
  if (typeof p.invoiceNumber !== "string" || !p.invoiceNumber.trim()) return "invoiceNumber required";
  if (p.invoiceNumber.length > 64) return "invoiceNumber too long";
  if (p.date && !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) return "date must be YYYY-MM-DD";
  if (mode === "update" && !p.date) return "date required on update";
  if (!Array.isArray(p.lineItems)) return "lineItems must be an array";
  if (p.lineItems.length === 0) return "at least one line item required";
  if (p.lineItems.length > 200) return "too many line items";
  if (p.customer && typeof p.customer !== "object") return "customer must be an object";
  return null;
}

export default router;
