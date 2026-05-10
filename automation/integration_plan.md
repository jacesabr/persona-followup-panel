# Integration plan — HISTORICAL / SUPERSEDED

> **Status as of 2026-05-10:** This file describes the dormant
> server-side generator path (Gemini / Anthropic via
> `server/generators/run.js`). That path is **no longer how
> production resumes are produced.** The live workflow is the
> Claude-Code-driven runbook in
> [`instructions_autofill_plus_generate.md`](instructions_autofill_plus_generate.md):
> the dev opens this repo locally in Claude Code on notification,
> the agent reads context, authors artifacts in-head, and POSTs
> them to `/api/admin/ai/dispatch`. The API generator path remains
> in the codebase as a fallback but is not the recommended route.
>
> Keep this file for reference if/when the API path is reactivated.
> For the current state-of-the-art resume generation flow, read:
>   1. `automation/instructions_autofill_plus_generate.md` (runbook)
>   2. `automation/resume_schema_v2.md` (payload shape + render)
>   3. `automation/example_payloads/sample_resume_v2.json` (concrete example)
>   4. `automation/resume_corpus/README.md` (style anchor source)

---

## Why this file exists

On 2026-05-09 the live deploy could not auto-generate Pratham Aggarwal's resume / SOP / counsellor-task list because the production Gemini key is throttled to free-tier `limit:0` (every call returns 429) and no `ANTHROPIC_API_KEY` is set on Render — so the automatic failover at [`server/llm/index.js:62`](server/llm/index.js#L62) had no secondary to dispatch to.

Rather than block the user, three artefacts were authored manually by Claude Opus 4.7 and written straight into the database via one-shot scripts:

| Artifact | Row(s) | Authoring script |
|---|---|---|
| Profile resume (label `profile-summary (handwritten)`) | `intake_resumes.id = 6` | [`server/scripts/set-pratham-resume.js`](server/scripts/set-pratham-resume.js) |
| SOP draft | `intake_required_docs.id = 30` (kind=`sop`) | [`server/scripts/seed-pratham-sop-and-tasks.js`](server/scripts/seed-pratham-sop-and-tasks.js) |
| 5 counsellor tasks for admin Suhas | `counsellor_tasks.id = 13..17` | same script |

This file is the recipe for switching back to the API path the codebase was originally designed around, the moment a funded LLM key exists.

## What to do when an LLM key is available

### Path A — fund the existing Gemini key

1. In Google AI Studio, attach a billing account to the project that owns `GEMINI_API_KEY` (currently `AIzaSyB6iVgfdd9LBpmXRDlFnOJmc5FGhQNok5I`). The key value does not change.
2. No code changes. The pipeline will start succeeding on the next attempt — every resume regen + SOP draft generation flows through [`server/llm/gemini.js`](server/llm/gemini.js) via [`generateStructured()`](server/llm/index.js).
3. Trigger a regen on existing rows by hitting `POST /api/students/<id>/resumes/<rid>/regenerate` (admin login required).

### Path B — set `ANTHROPIC_API_KEY` on Render (recommended fallback)

The codebase already has automatic failover wired: when Gemini 429s and `ANTHROPIC_API_KEY` is set, the call transparently routes to Claude via [`generateWithAnthropic()`](server/llm/anthropic.js).

1. Generate an Anthropic API key with sufficient credit at https://console.anthropic.com/settings/keys.
2. Set it on Render via per-key PUT (never bulk PUT — wipes other vars):
   ```bash
   curl -X PUT \
     -H "Authorization: Bearer $RENDER_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"value":"sk-ant-..."}' \
     "https://api.render.com/v1/services/srv-d7o7vlr7uimc73bmbsb0/env-vars/ANTHROPIC_API_KEY"
   ```
3. Render auto-redeploys on env-var change. Verify the boot log shows `[storage] backend = s3` (still) and that the next failed-resume regen succeeds with `provider: "anthropic"` in its response.
4. Optional: set `LLM_PROVIDER=anthropic` to bypass Gemini entirely if the Gemini quota is permanently capped. Otherwise leave it as `gemini` and rely on the failover.

### Path C — switch the project to the funded DeepSeek key

There is a `DEEPSEEK_API_KEY` in the local `.env` (used by some scripts only). If the project decides to standardise on DeepSeek:

1. Add a `server/llm/deepseek.js` adapter mirroring the shape of `anthropic.js` (system prompt + structured-output coercion).
2. Wire it into [`server/llm/index.js`'s `generateStructured`](server/llm/index.js#L42) under `provider === "deepseek"`.
3. Set `LLM_PROVIDER=deepseek` and `DEEPSEEK_API_KEY=...` on Render.

This requires actual code work; A and B don't.

## How to regenerate the three hand-authored artefacts via the API

Once any of the paths above is live, replace the manual content in this order:

### 1. Resume

```bash
# Login as admin
curl -c /tmp/cj -X POST https://persona-followup-panel.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin123","password":"admin123"}'

# Trigger regen — same row id, same student
curl -b /tmp/cj -X POST \
  https://persona-followup-panel.onrender.com/api/students/s_moy17coj_7ab6d5bb6e39/resumes/6/regenerate
```

Poll status with `node server/scripts/poll-resume.js 6`. The script writes the new content into the same row, overwriting the handwritten draft. Old content is recoverable from the JSON backup at `backups/db-2026-05-09T11-22-13-273Z-pre-sop-tasks.json`.

### 2. SOP

There isn't currently a "regenerate SOP" admin action — staff edit `staff_draft` directly via the panel. To get the LLM to author it on top:

- **Today**: read the SOP draft from `intake_required_docs WHERE id = 30`, hand it to the LLM with `voice_notes` from the corpus example (`intake_examples.id = 1`), and PATCH `staff_draft` with the result.
- **Future cleanup**: add a `POST /api/required-docs/:id/auto-draft` endpoint that calls `generateStructured({ purpose: 'sop', ... })` and writes the response into `staff_draft` only when the column is empty (idempotent — won't clobber a counsellor's hand edit). Mirror the regen-resume route's authentication + ownership check.

### 3. Counsellor tasks

Tasks are not auto-generated by any current code path. To make them auto-generate from intake answers:

- Add a server-side trigger when `intake_phase` flips to `done`: enumerate the standing checklist (program-confirmation, IELTS verification, LOR collection, marksheet upload, SOP review) and INSERT into `counsellor_tasks` keyed on `student_name + text` for idempotency. Hardcoded bullets are probably fine — these are operational steps, not creative output, so they don't need an LLM.
- Alternative: run them through `generateStructured({ purpose: 'tasks', ... })` with a JSON-schema response so the LLM picks the *priority* and *due-date offsets* based on the intake content, but keeps the wording deterministic. Not worth the cost unless task lists meaningfully diverge across student profiles.

## Pitfalls to avoid

- **Don't bulk-PUT env vars on Render.** `PUT /env-vars` (no key) silently wipes every other var. Always use the per-key endpoint above. Memory note `feedback_render_env_vars.md` covers this.
- **Don't drop `STORAGE_BACKEND=s3` while testing.** `initStorage()` will refuse to boot in production with any other backend ([`server/storage.js:144`](server/storage.js#L144)) — that guard is load-bearing, leave it.
- **Don't delete the manual drafts on Pratham's row when retrying.** The regen route already replaces `content_md` / `staff_draft` when it succeeds; if the LLM call fails, the existing draft stays in place. Backup files in `./backups/` and R2 prefix `_backups/` are the rollback path of last resort.
- **The voice anchor in `intake_examples.id = 1` is a LOR / internship letter, not a resume.** Its `voice_notes` ("Mirror its overall shape, tone, and density when generating any 300-word summary.") is the only generation guideline in the corpus. If/when richer anchors are added (real student SOPs, full resumes), drop them in via `server/scripts/import-examples.js` and the existing `generateStructured` calls pick them up automatically.

## Verification checklist after switching to API

- [ ] `[storage] backend = s3` in the Render boot log.
- [ ] `POST /api/students/<id>/resumes/<rid>/regenerate` returns 202 + `status: pending`.
- [ ] `node server/scripts/poll-resume.js <rid>` ends in `succeeded` with `content_len > 0` and `error = null`.
- [ ] `intake_resumes.label` no longer contains `(handwritten)`.
- [ ] `intake_required_docs.staff_draft` has been updated through the panel or the new auto-draft endpoint, *not* by re-running `seed-pratham-sop-and-tasks.js`.
- [ ] `counsellor_tasks` for Pratham still match the seeded checklist or have been edited / completed by admin Suhas.

That's the whole loop. Until then, the hand-authored artefacts are live, durable in R2 + Postgres, and visible in the admin panel exactly as the API-generated ones would be.
