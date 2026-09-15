const axios = require("axios");
const crypto = require("crypto");
const { APP_BASE_URL } = require("../config");

const paystackClient = axios.create({
  baseURL: process.env.PAYSTACK_BASE_URL || "https://api.paystack.co",
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

function verifyWebhookSignature(rawBody, signatureHeader) {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signatureHeader;
}

module.exports = { initializeTransaction, verifyWebhookSignature };
