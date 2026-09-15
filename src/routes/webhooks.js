const express = require("express");
const { withTransaction } = require("../db/pool");
const { creditWallet } = require("../services/ledger");
const { markTransactionStatus } = require("../services/idempotency");
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
    const { reference, amount } = event.data;

    // Lock the row so a retried or duplicate delivery waits here, then sees
    // "success" and skips — the credit and the status flip commit together.
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM transactions WHERE paystack_reference = $1 AND type = 'fund' FOR UPDATE",
        [reference],
      );
      const transaction = rows[0];
      if (!transaction || transaction.status === "success") return;

      await creditWallet({
        client,
        walletId: transaction.metadata.walletId,
        amount: amount / 100,
        transactionId: transaction.id,
      });
      await markTransactionStatus(transaction.id, "success", client);
    });
  }

  res.sendStatus(200);
}));

module.exports = router;
