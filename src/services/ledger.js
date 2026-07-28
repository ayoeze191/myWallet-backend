const { withTransaction } = require('../db/pool');

/**
 * Credit a wallet (money coming in — e.g. a Paystack funding).
 * Locks the wallet row so no concurrent operation can read a stale balance.
 */
async function creditWallet({ client, walletId, amount, transactionId }) {
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
    `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
     VALUES ($1, $2, 'credit', $3, $4)`,
    [transactionId, walletId, amount, newBalance]
  );

  return newBalance;
}

/**
 * Debit a wallet (money going out — e.g. sending to another wallet).
 * Throws INSUFFICIENT_FUNDS rather than allowing balance to go negative —
 * the DB CHECK constraint (balance >= 0) is a second line of defense.
 */
async function debitWallet({ client, walletId, amount, transactionId }) {
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
    `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
     VALUES ($1, $2, 'debit', $3, $4)`,
    [transactionId, walletId, amount, newBalance]
  );

  return newBalance;
}

/**
 * Move money from one wallet to another as ONE atomic operation.
 * Both the debit and the credit either both happen or neither does.
 *
 * Wallets are locked in a consistent order (sorted by id) to avoid
 * deadlocks when two transfers happen in opposite directions at once.
 */
async function transferBetweenWallets({ fromWalletId, toWalletId, amount, transactionId }) {
  return withTransaction(async (client) => {
    const [firstId, secondId] = [fromWalletId, toWalletId].sort();
    await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [firstId]);
    await client.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [secondId]);

    await debitWallet({ client, walletId: fromWalletId, amount, transactionId });
    await creditWallet({ client, walletId: toWalletId, amount, transactionId });
  });
}

class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { creditWallet, debitWallet, transferBetweenWallets, WalletError };
