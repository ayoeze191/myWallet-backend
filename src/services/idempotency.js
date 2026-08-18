const { pool } = require('../db/pool');

/**
 * Reserve an idempotency key by inserting a transaction row up front.
 * If the key already exists (unique constraint), this is a retried
 * request — we return the existing transaction instead of processing again.
 *
 * Pass `client` to run inside a caller's transaction. The Ajo engine does
 * this so the transaction row and the ledger entries it produces commit or
 * roll back together.
 */
async function reserveTransaction({ idempotencyKey, type, metadata = {}, client }) {
  const db = client || pool;

  const existing = await db.query(
    'SELECT * FROM transactions WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  if (existing.rows.length > 0) {
    return { transaction: existing.rows[0], isDuplicate: true };
  }

  const inserted = await db.query(
    `INSERT INTO transactions (type, idempotency_key, metadata)
     VALUES ($1, $2, $3) RETURNING *`,
    [type, idempotencyKey, metadata]
  );
  return { transaction: inserted.rows[0], isDuplicate: false };
}

async function markTransactionStatus(transactionId, status, client) {
  const db = client || pool;
  await db.query(
    'UPDATE transactions SET status = $1, updated_at = now() WHERE id = $2',
    [status, transactionId]
  );
}

module.exports = { reserveTransaction, markTransactionStatus };
