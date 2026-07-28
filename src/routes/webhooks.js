const express = require("express");
const { pool, withTransaction } = require("../db/pool");
const { creditWallet } = require("../services/ledger");
const { markTransactionStatus } = require("../services/idempotency");
const { verifyWebhookSignature } = require("../services/paystack");

const router = express.Router();

/**
 * Paystack webhook — this is the ONLY place a wallet actually gets credited
 * for a funding transaction. We never trust the client-side redirect alone
 * to mean money moved; only a signature-verified webhook does.
 *
 * Must be mounted with express.raw() (see server.js) so req.body here is
 * the untouched byte buffer the signature was computed over.
 */
router.post("/webhooks/paystack", async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const rawBody = req.body; // Buffer

  if (!signature || !verifyWebhookSignature(rawBody, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = JSON.parse(rawBody.toString("utf8"));

  if (event.event === "charge.success") {
    const { reference, amount } = event.data;

    const { rows } = await pool.query(
      "SELECT * FROM transactions WHERE paystack_reference = $1",
      [reference],
    );
    const transaction = rows[0];

    if (!transaction) return res.sendStatus(200); // unknown reference — ignore, don't error
    if (transaction.status === "success") return res.sendStatus(200); // already processed, safe no-op

    const walletId = transaction.metadata.walletId;
    const amountInNaira = amount / 100; // Paystack sends amount in kobo

    await withTransaction(async (client) => {
      await creditWallet({
        client,
        walletId,
        amount: amountInNaira,
        transactionId: transaction.id,
      });
    });

    await markTransactionStatus(transaction.id, "success");
  }

  res.sendStatus(200);
});

module.exports = router;
