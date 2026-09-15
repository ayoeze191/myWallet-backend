// Fees in naira, charged on top of the amount sent: the recipient always
// gets the full amount. A tier covers amounts up to and including `upTo`.
// Both schedules mirror Paystack's NGN transfer pricing, so a withdrawal at
// least covers what Paystack charges us for it. Use [{ upTo: Infinity, fee: 0 }]
// to make an action free.
const FEE_SCHEDULES = {
  transfer: [
    { upTo: 5000, fee: 10 },
    { upTo: 50000, fee: 25 },
    { upTo: Infinity, fee: 50 },
  ],
  withdrawal: [
    { upTo: 5000, fee: 10 },
    { upTo: 50000, fee: 25 },
    { upTo: Infinity, fee: 50 },
  ],
};

function feeFor(type, amount) {
  return FEE_SCHEDULES[type].find((tier) => Number(amount) <= tier.upTo).fee;
}

async function getFeeWalletId(db) {
  const { rows } = await db.query("SELECT id FROM wallets WHERE kind = 'fees'");
  if (!rows[0]) throw new Error('Platform fee wallet is missing — run `npm run migrate`');
  return rows[0].id;
}

module.exports = { feeFor, getFeeWalletId };
