const express = require('express');
const { pool } = require('../db/pool');
const { transferBetweenWallets, WalletError } = require('../services/ledger');
const { reserveTransaction, markTransactionStatus } = require('../services/idempotency');
const { feeFor } = require('../services/fees');
const { requireAuth } = require('../middleware/requireAuth');
const { asyncRoute } = require('../middleware/asyncRoute');

const router = express.Router();

router.use(requireAuth);

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

// Lets the app show "fee ₦10, total ₦1,010" before the user confirms.
router.get('/fees', asyncRoute(async (req, res) => {
  const { type, amount } = req.query;
  if (!['transfer', 'withdrawal'].includes(type)) {
    return res.status(400).json({ error: 'type must be transfer or withdrawal' });
  }
  if (!AMOUNT_RE.test(String(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be positive, with at most 2 decimal places' });
  }
  const fee = feeFor(type, amount);
  res.json({ type, amount: Number(amount), fee, total: Math.round((Number(amount) + fee) * 100) / 100 });
}));

router.post('/transfers', asyncRoute(async (req, res) => {
  const { toEmail, amount } = req.body;
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });
  if (!toEmail || !amount) return res.status(400).json({ error: 'toEmail and amount are required' });
  if (!AMOUNT_RE.test(String(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'amount must be positive, with at most 2 decimal places' });
  }

  const senderWallet = await pool.query('SELECT * FROM wallets WHERE user_id = $1', [req.userId]);
  const fromWallet = senderWallet.rows[0];
  if (!fromWallet) return res.status(404).json({ error: 'Your wallet was not found' });

  const recipient = await pool.query(
    `SELECT w.id AS wallet_id, u.email FROM wallets w
     JOIN users u ON u.id = w.user_id
     WHERE u.email = $1`,
    [toEmail.toLowerCase()]
  );
  const toWallet = recipient.rows[0];
  if (!toWallet) return res.status(404).json({ error: 'No user found with that email' });
  if (toWallet.wallet_id === fromWallet.id) {
    return res.status(400).json({ error: 'Cannot transfer to your own wallet' });
  }

  const fee = feeFor('transfer', amount);
  const { transaction, isDuplicate } = await reserveTransaction({
    idempotencyKey,
    type: 'transfer',
    metadata: { fromWalletId: fromWallet.id, toWalletId: toWallet.wallet_id, amount, fee },
  });

  if (isDuplicate) {
    return res.json({ message: 'Duplicate request, returning original', transaction });
  }

  try {
    await transferBetweenWallets({
      fromWalletId: fromWallet.id,
      toWalletId: toWallet.wallet_id,
      amount,
      fee,
      transactionId: transaction.id,
    });
    await markTransactionStatus(transaction.id, 'success');
    res.status(200).json({
      message: 'Transfer successful',
      transactionId: transaction.id,
      amount: Number(amount),
      fee,
    });
  } catch (err) {
    await markTransactionStatus(transaction.id, 'failed');
    if (err instanceof WalletError) {
      return res.status(422).json({ error: err.code, message: err.message });
    }
    throw err;
  }
}));

module.exports = router;
