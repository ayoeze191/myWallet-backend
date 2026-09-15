const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { WalletError } = require('../services/ledger');
const withdrawals = require('../services/withdrawals');
const { WithdrawalError } = require('../services/withdrawals');

const STATUS_MESSAGE = {
  pending: 'Withdrawal is on its way to your bank',
  success: 'Withdrawal sent to your bank',
  failed: 'Withdrawal failed — the money is back in your wallet',
};

function route(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (err instanceof WithdrawalError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      if (err instanceof WalletError) {
        return res.status(422).json({ error: err.code, message: err.message });
      }
      next(err);
    });
  };
}

const router = express.Router();
router.use(requireAuth);

router.get(
  '/banks',
  route(async (req, res) => {
    res.json(await withdrawals.listBanks());
  })
);

router.get(
  '/banks/resolve',
  route(async (req, res) => {
    const { accountNumber, bankCode } = req.query;
    res.json(await withdrawals.resolveAccount({ accountNumber, bankCode }));
  })
);

router.post(
  '/wallets/me/withdraw',
  route(async (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) return res.status(400).json({ error: 'Idempotency-Key header is required' });

    const { amount, bankCode, accountNumber, password } = req.body;
    const withdrawal = await withdrawals.requestWithdrawal({
      userId: req.userId,
      amount,
      bankCode,
      accountNumber,
      password,
      idempotencyKey,
    });
    res.status(202).json({ message: STATUS_MESSAGE[withdrawal.status], withdrawal });
  })
);

router.get(
  '/wallets/me/withdrawals',
  route(async (req, res) => {
    res.json(await withdrawals.listWithdrawals(req.userId));
  })
);

module.exports = router;
