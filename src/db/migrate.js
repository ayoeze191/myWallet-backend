const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  // gen_random_uuid() needs pgcrypto on older Postgres (built-in from PG13+ via pgcrypto ext)
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await pool.query(sql);
  console.log("Migration complete.");
  await pool.end();
}
migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
