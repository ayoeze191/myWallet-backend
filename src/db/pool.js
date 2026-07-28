const { Pool } = require('pg');
require('dotenv').config();

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
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
