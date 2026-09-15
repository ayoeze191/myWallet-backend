const express = require("express");
const { creditFunding } = require("../services/funding");
const { settleWithdrawal } = require("../services/withdrawals");
const { verifyWebhookSignature } = require("../services/paystack");
const { asyncRoute } = require("../middleware/asyncRoute");

const router = express.Router();

const TRANSFER_OUTCOMES = {
  "transfer.success": "success",
  "transfer.failed": "failed",
  "transfer.reversed": "failed",
};

router.post("/webhooks/paystack", asyncRoute(async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const rawBody = req.body;

  if (!signature || !Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(rawBody.toString("utf8"));

  if (event.event === "charge.success") {
    await creditFunding({
      reference: event.data.reference,
      amountKobo: event.data.amount,
    });
  }

  if (TRANSFER_OUTCOMES[event.event]) {
    await settleWithdrawal(event.data.reference, TRANSFER_OUTCOMES[event.event], event.event);
  }

  res.sendStatus(200);
}));

module.exports = router;
