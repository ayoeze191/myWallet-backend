const axios = require("axios");
const crypto = require("crypto");
const { APP_BASE_URL } = require("../config");

const paystackClient = axios.create({
  baseURL: process.env.PAYSTACK_BASE_URL || "https://api.paystack.co",
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
});

async function initializeTransaction({ email, amount, reference }) {
  const response = await paystackClient.post("/transaction/initialize", {
    email,
    amount: Math.round(Number(amount) * 100),
    reference,
    callback_url: `${APP_BASE_URL}/wallets/fund/callback`,
  });
  return response.data.data;
}

// A GET where "Paystack has no such thing" resolves to null, not an error.
async function getOrNull(path, params) {
  try {
    const response = await paystackClient.get(path, { params });
    return response.data.data;
  } catch (err) {
    if (err.response && [400, 404, 422].includes(err.response.status)) return null;
    throw err;
  }
}

// Paystack's own record of a charge, or null if it has no transaction with
// this reference (e.g. initialize never reached it).
function verifyTransaction(reference) {
  return getOrNull(`/transaction/verify/${encodeURIComponent(reference)}`);
}

function verifyTransfer(reference) {
  return getOrNull(`/transfer/verify/${encodeURIComponent(reference)}`);
}

// { account_number, account_name }, or null if the bank has no such account.
function resolveAccount(accountNumber, bankCode) {
  return getOrNull("/bank/resolve", {
    account_number: accountNumber,
    bank_code: bankCode,
  });
}

async function listBanks() {
  const banks = [];
  let next;
  for (let page = 0; page < 20; page++) {
    const response = await paystackClient.get("/bank", {
      params: { country: "nigeria", use_cursor: true, perPage: 100, next },
    });
    banks.push(...response.data.data);
    next = response.data.meta?.next;
    if (!next) break;
  }
  return banks;
}

async function createTransferRecipient({ name, accountNumber, bankCode }) {
  const response = await paystackClient.post("/transferrecipient", {
    type: "nuban",
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: "NGN",
  });
  return response.data.data;
}

async function initiateTransfer({ amountKobo, recipient, reference, reason }) {
  const response = await paystackClient.post("/transfer", {
    source: "balance",
    amount: amountKobo,
    recipient,
    reference,
    reason,
  });
  return response.data.data;
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  verifyTransfer,
  resolveAccount,
  listBanks,
  createTransferRecipient,
  initiateTransfer,
  verifyWebhookSignature,
};
