const { pool } = require('../db/pool');

/**
 * Reserve an idempotency key by inserting a transaction row up front.
 * If the key already exists (unique constraint), this is a retried
 * request — we return the existing transaction instead of processing again.
 */
async function reserveTransaction({ idempotencyKey, type, metadata = {} }) {
  const existing = await pool.query(
    'SELECT * FROM transactions WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  if (existing.rows.length > 0) {
    return { transaction: existing.rows[0], isDuplicate: true };
  }

  const inserted = await pool.query(
    `INSERT INTO transactions (type, idempotency_key, metadata)
     VALUES ($1, $2, $3) RETURNING *`,
    [type, idempotencyKey, metadata]
  );
  return { transaction: inserted.rows[0], isDuplicate: false };
}

async function markTransactionStatus(transactionId, status) {
  await pool.query(
    'UPDATE transactions SET status = $1, updated_at = now() WHERE id = $2',
    [status, transactionId]
  );
}

module.exports = { reserveTransaction, markTransactionStatus };
