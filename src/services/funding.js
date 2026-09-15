const { pool, withTransaction } = require('../db/pool');
const { creditWallet } = require('./ledger');
const { markTransactionStatus } = require('./idempotency');
const { verifyTransaction } = require('./paystack');

// An abandoned checkout can still be completed for a while, so it only
// counts as failed once it has sat unpaid this long.
const GIVE_UP_AFTER = '24 hours';

// Credits a fund transaction exactly once, however many times the same
// successful charge is reported: webhook, webhook retry, or reconciliation.
async function creditFunding({ reference, amountKobo }) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM transactions WHERE paystack_reference = $1 AND type = 'fund' FOR UPDATE",
      [reference]
    );
    const transaction = rows[0];
    if (!transaction || transaction.status === 'success') return;

    await creditWallet({
      client,
      walletId: transaction.metadata.walletId,
      amount: amountKobo / 100,
      transactionId: transaction.id,
    });
    await markTransactionStatus(transaction.id, 'success', client);
  });
}

// Asks Paystack directly how a charge ended, for when its webhook never
// reached us (server asleep or down, or the network dropped it).
async function reconcileFunding(reference) {
  const charge = await verifyTransaction(reference);

  if (charge?.status === 'success') {
    return creditFunding({ reference, amountKobo: charge.amount });
  }

  const definitelyFailed = ['failed', 'reversed'].includes(charge?.status);
  const stillInProgress = charge && !definitelyFailed && charge.status !== 'abandoned';
  if (stillInProgress) return;

  await pool.query(
    `UPDATE transactions SET status = 'failed', updated_at = now()
     WHERE paystack_reference = $1 AND type = 'fund' AND status = 'pending'
       AND ($2 OR created_at < now() - $3::interval)`,
    [reference, definitelyFailed, GIVE_UP_AFTER]
  );
}

// Skips the first minute so the webhook gets a chance to land on its own.
async function reconcilePendingFunding() {
  const { rows } = await pool.query(
    `SELECT paystack_reference FROM transactions
     WHERE type = 'fund' AND status = 'pending' AND paystack_reference IS NOT NULL
       AND created_at < now() - interval '1 minute'
     ORDER BY created_at
     LIMIT 50`
  );

  for (const { paystack_reference: reference } of rows) {
    try {
      await reconcileFunding(reference);
    } catch (err) {
      console.error(`[funding] could not reconcile ${reference}:`, err.message);
    }
  }
}

module.exports = { creditFunding, reconcileFunding, reconcilePendingFunding };
