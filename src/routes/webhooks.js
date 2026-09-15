const express = require("express");
const { creditFunding } = require("../services/funding");
const { verifyWebhookSignature } = require("../services/paystack");
const { asyncRoute } = require("../middleware/asyncRoute");

const router = express.Router();

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

  res.sendStatus(200);
}));

module.exports = router;
