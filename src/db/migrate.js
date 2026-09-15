const fs = require("fs");
const path = require("path");
const { pool } = require("./pool");

// schema.sql is written to be safe to re-run, so the server applies it on
// every boot: a deploy can never run new code against an old schema.
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await pool.query(sql);
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log("Migration complete.");
      return pool.end();
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

module.exports = { migrate };
