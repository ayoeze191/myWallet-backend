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

// Paystack's own record of a charge, or null if it has no transaction with
// this reference (e.g. initialize never reached it).
async function verifyTransaction(reference) {
  try {
    const response = await paystackClient.get(
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return response.data.data;
  } catch (err) {
    if (err.response && [400, 404].includes(err.response.status)) return null;
    throw err;
  }
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature };
