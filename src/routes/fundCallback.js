const express = require("express");
const { pool } = require("../db/pool");

const router = express.Router();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Paystack sends users back here after its hosted payment page. This is a
 * receipt/status page only: a redirect is not evidence that funds arrived.
 * The signed Paystack webhook remains the only path that credits a wallet.
 */
router.get("/wallets/fund/callback", async (req, res, next) => {
  try {
    const malformedQuery =
      typeof req.query[""] === "string"
        ? new URLSearchParams(req.query[""]).get("trxref")
        : null;
    const reference = req.query.reference || req.query.trxref || malformedQuery;
    let status = "missing";

    if (typeof reference === "string" && reference.startsWith("fund_")) {
      const { rows } = await pool.query(
        "SELECT status FROM transactions WHERE paystack_reference = $1 AND type = 'fund'",
        [reference],
      );
      status = rows[0]?.status || "not_found";
    }

    const copy = {
      success: {
        title: "Wallet funded",
        message:
          "Your payment has been confirmed and your wallet balance is updated.",
        icon: "✓",
      },
      pending: {
        title: "Payment is processing",
        message:
          "We received your return from Paystack. Your wallet will update once the payment is confirmed.",
        icon: "…",
      },
      failed: {
        title: "Payment was not completed",
        message:
          "No money was added to your wallet. You can return and try funding it again.",
        icon: "!",
      },
      missing: {
        title: "Payment reference missing",
        message:
          "We could not identify this funding attempt. Return to your wallet and start again.",
        icon: "!",
      },
      not_found: {
        title: "Funding attempt not found",
        message: "This reference does not match a wallet funding attempt.",
        icon: "!",
      },
    }[status];

    const safeReference = reference ? escapeHtml(reference) : "Not provided";
    const refresh =
      status === "pending" ? '<meta http-equiv="refresh" content="8">' : "";

    res
      .status(status === "missing" || status === "not_found" ? 400 : 200)
      .type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${refresh}
    <title>${copy.title} · Wallet</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f5f8f5; color: #152018; }
      main { width: min(92vw, 480px); padding: 42px 34px; text-align: center; background: #fff; border: 1px solid #dce6dd; border-radius: 20px; box-shadow: 0 18px 50px #28453014; }
      .icon { width: 58px; height: 58px; margin: 0 auto 20px; display: grid; place-items: center; border-radius: 50%; background: ${status === "success" ? "#e4f5e7" : "#fff2db"}; color: ${status === "success" ? "#16733b" : "#9a5a00"}; font-size: 31px; font-weight: 700; }
      h1 { margin: 0; font-size: 25px; letter-spacing: -.5px; }
      p { margin: 13px 0 24px; color: #57615a; line-height: 1.55; }
      .reference { padding: 12px; overflow-wrap: anywhere; background: #f3f6f3; border-radius: 8px; color: #3d4b40; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
      small { display: block; margin-bottom: 6px; color: #78827a; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
      button { margin-top: 25px; padding: 12px 18px; border: 0; border-radius: 9px; background: #176b39; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <div class="icon" aria-hidden="true">${copy.icon}</div>
      <h1>${copy.title}</h1>
      <p>${copy.message}</p>
      <small>Transaction reference</small>
      <div class="reference">${safeReference}</div>
      ${status === "pending" ? "<p><small>This page refreshes automatically while confirmation arrives.</small></p>" : ""}
      <button type="button" onclick="history.length > 1 ? history.back() : location.assign('/')">Return to wallet</button>
    </main>
  </body>
</html>`);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
