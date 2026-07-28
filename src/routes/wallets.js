const express = require('express');
const { pool } = require('../db/pool');
const { reserveTransaction } = require('../services/idempotency');
const { initializeTransaction } = require('../services/paystack');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

// Every route below requires a valid logged-in user.
router.use(requireAuth);

async function getWalletForUser(userId) {
  const { rows } = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

// Get my own wallet + balance
router.get('/wallets/me', async (req, res) => {
  const wallet = await getWalletForUser(req.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  res.json(wallet);
});

// My own ledger history
router.get('/wallets/me/ledger', async (req, res) => {
  const wallet = await getWalletForUser(req.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const { rows } = await pool.query(
    'SELECT * FROM ledger_entries WHERE wallet_id = $1 ORDER BY created_at DESC',
    [wallet.id]
  );
  res.json(rows);
});

/**
 * Look up a potential transfer recipient by email. Deliberately returns
 * only their name — never their balance or wallet id — so this can't be
 * used to snoop on other users' account details before sending them money.
 */
router.get('/users/lookup', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param is required' });

  const { rows } = await pool.query(
    `SELECT u.name FROM users u
     JOIN wallets w ON w.user_id = u.id
     WHERE u.email = $1`,
    [email.toLowerCase()]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'No user found with that email' });
  res.json({ name: rows[0].name });
});

/**
 * Start funding MY wallet via Paystack. Requires an Idempotency-Key header
 * so a retried "Fund" click never starts two separate charges.
 */
router.post('/wallets/me/fund', async (req, res) => {
  const { amount, email } = req.body;
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });
  if (!amount || !email) return res.status(400).json({ error: 'amount and email are required' });

  const wallet = await getWalletForUser(req.userId);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

  const { transaction, isDuplicate } = await reserveTransaction({
    idempotencyKey,
    type: 'fund',
    metadata: { walletId: wallet.id, amount, email },
  });

  if (isDuplicate) {
    return res.json({ message: 'Duplicate request, returning original', transaction });
  }

  const reference = `fund_${transaction.id}`;
  await pool.query('UPDATE transactions SET paystack_reference = $1 WHERE id = $2', [
    reference,
    transaction.id,
  ]);

  const paystackData = await initializeTransaction({ email, amount, reference });

  res.status(202).json({
    message: 'Redirect the user to authorization_url to complete payment',
    authorization_url: paystackData.authorization_url,
    reference,
  });
});

module.exports = router;
