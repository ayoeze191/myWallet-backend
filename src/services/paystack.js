const axios = require("axios");
const crypto = require("crypto");
require("dotenv").config();

const paystackClient = axios.create({
  baseURL: process.env.PAYSTACK_BASE_URL || "https://api.paystack.co",
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
});

/**
 * Start a deposit. Paystack returns an authorization_url the client
 * redirects the user to. We do NOT credit the wallet here — that only
 * happens once Paystack's webhook confirms the charge succeeded.
 */
async function initializeTransaction({ email, amount, reference }) {
  const response = await paystackClient.post("/transaction/initialize", {
    email,
    amount: Math.round(Number(amount) * 100), // Paystack expects kobo (amount * 100)
    reference,
    callback_url: `${process.env.APP_BASE_URL}/wallets/fund/callback`,
  });
  return response.data.data; // { authorization_url, access_code, reference }
}

/**
 * Never trust a webhook body on its own. Paystack signs every webhook
 * with HMAC-SHA512 of the raw request body, using your secret key.
 * If the signature doesn't match, the request did not come from Paystack.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

module.exports = { initializeTransaction, verifyWebhookSignature };
