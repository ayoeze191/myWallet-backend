require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRoutes = require("./src/routes/auth");
const walletRoutes = require("./src/routes/wallets");
const transferRoutes = require("./src/routes/transfers");
const webhookRoutes = require("./src/routes/webhooks");
const fundCallbackRoutes = require("./src/routes/fundCallback");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set in .env — refusing to start.");
  process.exit(1);
}

const app = express();
app.use(
  cors({
    origin: "http://localhost:5173",
  }),
);

// IMPORTANT: the Paystack webhook route needs the raw request body to
// verify the HMAC signature, so it is mounted with express.raw()
// BEFORE the general express.json() parser would otherwise touch it.
app.use("/webhooks/paystack", express.raw({ type: "application/json" }));
app.use(webhookRoutes);

// Everything else can safely use normal JSON body parsing.
app.use(express.json());
// This route must remain public: Paystack redirects the user's browser here.
app.use(fundCallbackRoutes);
app.use(authRoutes);
app.use(walletRoutes);
app.use(transferRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Wallet system running on port ${PORT}`));
