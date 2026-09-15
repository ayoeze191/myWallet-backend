const { withTransaction } = require('../db/pool');
const { getFeeWalletId } = require('./fees');

async function creditWallet({ client, walletId, amount, transactionId, memo = null }) {
  const { rows } = await client.query(
    'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE',
    [walletId]
  );
  if (rows.length === 0) throw new WalletError('WALLET_NOT_FOUND', 'Wallet not found');

  const newBalance = Number(rows[0].balance) + Number(amount);

  await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [
    newBalance,
    walletId,
  ]);

  await client.query(
    `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after, memo)
     VALUES ($1, $2, 'credit', $3, $4, $5)`,
    [transactionId, walletId, amount, newBalance, memo]
  );

  return newBalance;
}

async function debitWallet({ client, walletId, amount, transactionId, memo = null }) {
  const { rows } = await client.query(
    'SELECT balance FROM wallets WHERE id = $1 FOR UPDATE',
    [walletId]
  );
  if (rows.length === 0) throw new WalletError('WALLET_NOT_FOUND', 'Wallet not found');

  const currentBalance = Number(rows[0].balance);
  if (currentBalance < Number(amount)) {
    throw new WalletError('INSUFFICIENT_FUNDS', 'Wallet does not have enough balance');
  }

  const newBalance = currentBalance - Number(amount);

  await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [
    newBalance,
    walletId,
  ]);

  await client.query(
    `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after, memo)
     VALUES ($1, $2, 'debit', $3, $4, $5)`,
    [transactionId, walletId, amount, newBalance, memo]
  );

  return newBalance;
}

// The fee wallet is always locked after any user wallet in the same
// transaction, so concurrent transfers can't deadlock on it.
async function chargeFee({ client, walletId, fee, transactionId }) {
  await debitWallet({ client, walletId, amount: fee, transactionId, memo: 'fee' });
  await creditWallet({
    client,
    walletId: await getFeeWalletId(client),
    amount: fee,
    transactionId,
    memo: 'fee',
  });
}

async function refundFee({ client, walletId, fee, transactionId }) {
  await creditWallet({ client, walletId, amount: fee, transactionId, memo: 'fee refund' });
  await debitWallet({
    client,
    walletId: await getFeeWalletId(client),
    amount: fee,
    transactionId,
    memo: 'fee refund',
  });
}

async function transferBetweenWallets({ fromWalletId, toWalletId, amount, fee = 0, transactionId }) {
  return withTransaction(async (client) => {
    const [firstId, secondId] = [fromWalletId, toWalletId].sort();
    await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [firstId]);
    await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [secondId]);

    await debitWallet({ client, walletId: fromWalletId, amount, transactionId });
    await creditWallet({ client, walletId: toWalletId, amount, transactionId });
    if (Number(fee) > 0) {
      await chargeFee({ client, walletId: fromWalletId, fee, transactionId });
    }
  });
}

class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = {
  creditWallet,
  debitWallet,
  chargeFee,
  refundFee,
  transferBetweenWallets,
  WalletError,
};
