import pg from "pg";

const { Pool } = pg;

const isRender = (process.env.DATABASE_URL || "").includes("render.com");

if (isRender) {
  console.warn("[db] SSL with rejectUnauthorized:false — acceptable inside Render network, revisit for stricter prod");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRender ? { rejectUnauthorized: false } : false,
});

export default pool;
