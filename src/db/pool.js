const { Pool, types } = require("pg");
require("dotenv").config();

// Hand DATE columns back as plain 'YYYY-MM-DD' strings.
// By default node-postgres builds a JS Date at LOCAL midnight, which then
// serialises to the previous day in UTC anywhere east of Greenwich — an Ajo
// due date of the 8th would reach the browser as the 7th. Ajo dates are
// calendar days, not instants, so a string is the honest representation.
types.setTypeParser(types.builtins.DATE, (value) => value);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Run a function inside a single DB transaction.
 * Ensures BEGIN / COMMIT / ROLLBACK is never forgotten,
 * and that every step in a money-moving operation lives or dies together.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
