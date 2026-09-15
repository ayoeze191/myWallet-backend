const { pool, withTransaction } = require('../db/pool');
const { creditWallet, debitWallet, chargeFee, refundFee } = require('./ledger');
const { reserveTransaction, markTransactionStatus } = require('./idempotency');
const { comparePassword } = require('./auth');
const { feeFor } = require('./fees');
const paystack = require('./paystack');

const MIN_WITHDRAWAL = 100;
const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000;
// If Paystack still has no record of a transfer this long after we asked for
// it, the request never reached it and the held money goes back.
const NOT_FOUND_GRACE = '10 minutes';
const FAILED_TRANSFER = ['failed', 'reversed', 'abandoned', 'blocked', 'rejected'];

class WithdrawalError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let bankCache = { at: 0, banks: [] };

async function listBanks() {
  if (bankCache.banks.length && Date.now() - bankCache.at < BANK_LIST_TTL_MS) {
    return bankCache.banks;
  }
  const banks = (await paystack.listBanks())
    .filter((b) => b.active !== false)
    .map((b) => ({ name: b.name, code: b.code }));
  bankCache = { at: Date.now(), banks };
  return banks;
}

async function resolveAccount({ accountNumber, bankCode }) {
  if (!/^\d{10}$/.test(String(accountNumber || ''))) {
    throw new WithdrawalError('INVALID_ACCOUNT_NUMBER', 'Account number must be 10 digits', 400);
  }
  if (!bankCode) throw new WithdrawalError('INVALID_BANK', 'Choose a bank', 400);

  const account = await paystack.resolveAccount(accountNumber, bankCode);
  if (!account) {
    throw new WithdrawalError('ACCOUNT_NOT_FOUND', 'We could not find that account at that bank', 400);
  }
  return { account_name: account.account_name, account_number: account.account_number };
}

function present(tx) {
  const m = tx.metadata;
  return {
    id: tx.id,
    reference: tx.paystack_reference,
    status: tx.status,
    amount: m.amount,
    fee: m.fee ?? 0,
    bank_name: m.bankName,
    bank_code: m.bankCode,
    account_number: m.accountNumber,
    account_name: m.accountName,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
  };
}

async function getWithdrawal(reference) {
  const { rows } = await pool.query(
    "SELECT * FROM transactions WHERE paystack_reference = $1 AND type = 'withdrawal'",
    [reference]
  );
  return rows[0];
}

async function requestWithdrawal({ userId, amount, bankCode, accountNumber, password, idempotencyKey }) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(amount ?? '')) || Number(amount) < MIN_WITHDRAWAL) {
    throw new WithdrawalError(
      'INVALID_AMOUNT',
      `Minimum withdrawal is ₦${MIN_WITHDRAWAL}, with at most 2 decimal places`,
      400
    );
  }
  const value = Number(amount);
  const fee = feeFor('withdrawal', value);

  // Money leaving the platform is the one action a stolen token must not be
  // able to do on its own.
  const { rows: users } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!users[0] || !password || !(await comparePassword(password, users[0].password_hash))) {
    throw new WithdrawalError('WRONG_PASSWORD', 'Password is incorrect', 403);
  }

  const { rows: wallets } = await pool.query(
    "SELECT id FROM wallets WHERE user_id = $1 AND kind = 'user'",
    [userId]
  );
  if (!wallets[0]) throw new WithdrawalError('WALLET_NOT_FOUND', 'You do not have a wallet yet', 404);
  const walletId = wallets[0].id;

  const { account_name: accountName } = await resolveAccount({ accountNumber, bankCode });
  const bankName = (await listBanks()).find((b) => b.code === bankCode)?.name || bankCode;
  const recipient = await paystack.createTransferRecipient({ name: accountName, accountNumber, bankCode });

  // Hold the money (and the fee) before asking Paystack to send it. Reserve
  // + debit commit together, so an insufficient balance leaves nothing behind.
  const { transaction, isDuplicate } = await withTransaction(async (client) => {
    const reserved = await reserveTransaction({
      client,
      idempotencyKey,
      type: 'withdrawal',
      metadata: {
        userId,
        walletId,
        amount: value,
        fee,
        bankCode,
        bankName,
        accountNumber,
        accountName,
        recipientCode: recipient.recipient_code,
      },
    });
    if (reserved.isDuplicate) return reserved;

    const { id } = reserved.transaction;
    await debitWallet({ client, walletId, amount: value, transactionId: id });
    if (fee > 0) await chargeFee({ client, walletId, fee, transactionId: id });
    const { rows } = await client.query(
      'UPDATE transactions SET paystack_reference = $1 WHERE id = $2 RETURNING *',
      [`wd_${id}`, id]
    );
    return { transaction: rows[0], isDuplicate: false };
  });

  if (isDuplicate) {
    if (transaction.type !== 'withdrawal') {
      throw new WithdrawalError('IDEMPOTENCY_KEY_REUSED', 'That Idempotency-Key belongs to another request', 409);
    }
    return present(transaction);
  }

  const reference = transaction.paystack_reference;
  try {
    const transfer = await paystack.initiateTransfer({
      amountKobo: Math.round(value * 100),
      recipient: recipient.recipient_code,
      reference,
      reason: 'Wallet withdrawal',
    });
    if (transfer.status === 'success') await settleWithdrawal(reference, 'success');
    if (FAILED_TRANSFER.includes(transfer.status)) await settleWithdrawal(reference, 'failed', transfer.status);
    if (transfer.status === 'otp') {
      console.error(`[withdrawal] ${reference} is waiting for an OTP — turn off transfer OTP in the Paystack dashboard`);
    }
  } catch (err) {
    const status = err.response?.status;
    if (status >= 400 && status < 500) {
      // Paystack refused outright, so no transfer exists: release the hold.
      const reason = err.response.data?.message || `rejected (${status})`;
      console.error(`[withdrawal] ${reference} rejected by Paystack: ${reason}`);
      await settleWithdrawal(reference, 'failed', reason);
      throw new WithdrawalError(
        'TRANSFER_REJECTED',
        'The bank transfer could not be started. Your money is back in your wallet.',
        502
      );
    }
    // No clear answer (timeout, dropped connection, Paystack 5xx): the
    // transfer may exist. Keep the money held; the sweep asks Paystack later.
    console.error(`[withdrawal] ${reference} outcome unknown, will reconcile: ${err.message}`);
  }

  return present(await getWithdrawal(reference));
}

// Applies a transfer's outcome once. A failed or reversed transfer puts the
// held money and the fee back; repeat reports of the same outcome change nothing.
async function settleWithdrawal(reference, outcome, reason) {
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT * FROM transactions WHERE paystack_reference = $1 AND type = 'withdrawal' FOR UPDATE",
      [reference]
    );
    const tx = rows[0];
    if (!tx) return;

    if (tx.status === 'failed') {
      if (outcome === 'success') {
        console.error(`[withdrawal] ALERT ${reference} reported paid after it was refunded — check Paystack`);
      }
      return;
    }

    if (outcome === 'success') {
      if (tx.status === 'pending') await markTransactionStatus(tx.id, 'success', client);
      return;
    }

    const { walletId, amount, fee } = tx.metadata;
    await creditWallet({ client, walletId, amount, transactionId: tx.id });
    if (Number(fee) > 0) await refundFee({ client, walletId, fee, transactionId: tx.id });
    await client.query(
      `UPDATE transactions
       SET status = 'failed', updated_at = now(),
           metadata = metadata || jsonb_build_object('failureReason', $2::text)
       WHERE id = $1`,
      [tx.id, reason || 'failed']
    );
  });
}

// Asks Paystack how a transfer ended, for when its webhook never reached us.
async function reconcileWithdrawal(reference) {
  const transfer = await paystack.verifyTransfer(reference);
  if (transfer?.status === 'success') return settleWithdrawal(reference, 'success');
  if (FAILED_TRANSFER.includes(transfer?.status)) {
    return settleWithdrawal(reference, 'failed', transfer.status);
  }
  if (transfer) return;

  const { rows } = await pool.query(
    'SELECT created_at < now() - $2::interval AS stale FROM transactions WHERE paystack_reference = $1',
    [reference, NOT_FOUND_GRACE]
  );
  if (rows[0]?.stale) await settleWithdrawal(reference, 'failed', 'never reached Paystack');
}

async function reconcilePendingWithdrawals() {
  const { rows } = await pool.query(
    `SELECT paystack_reference FROM transactions
     WHERE type = 'withdrawal' AND status = 'pending' AND paystack_reference IS NOT NULL
       AND created_at < now() - interval '2 minutes'
     ORDER BY created_at
     LIMIT 50`
  );

  for (const { paystack_reference: reference } of rows) {
    try {
      await reconcileWithdrawal(reference);
    } catch (err) {
      console.error(`[withdrawal] could not reconcile ${reference}:`, err.message);
    }
  }
}

async function listWithdrawals(userId) {
  const { rows } = await pool.query(
    `SELECT t.* FROM transactions t
     JOIN ledger_entries le
       ON le.transaction_id = t.id AND le.direction = 'debit' AND le.memo IS NULL
     JOIN wallets w ON w.id = le.wallet_id
     WHERE t.type = 'withdrawal' AND w.user_id = $1 AND w.kind = 'user'
     ORDER BY t.created_at DESC
     LIMIT 50`,
    [userId]
  );
  return rows.map(present);
}

module.exports = {
  listBanks,
  resolveAccount,
  requestWithdrawal,
  settleWithdrawal,
  reconcilePendingWithdrawals,
  listWithdrawals,
  WithdrawalError,
};
