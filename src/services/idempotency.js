const { pool } = require('../db/pool');

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
