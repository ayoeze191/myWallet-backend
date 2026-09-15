require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { APP_BASE_URL, FRONTEND_BASE_URL } = require("./src/config");
const authRoutes = require("./src/routes/auth");
const walletRoutes = require("./src/routes/wallets");
const transferRoutes = require("./src/routes/transfers");
const webhookRoutes = require("./src/routes/webhooks");
const fundCallbackRoutes = require("./src/routes/fundCallback");
const {
  publicContributionRoutes,
  contributionRoutes,
} = require("./src/routes/contributions");
const { startAjoScheduler } = require("./src/services/scheduler");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set in .env — refusing to start.");
  process.exit(1);
}

const app = express();
const allowedOrigins = [
  "http://localhost:5173",
  "https://neon-salmiakki-04c60d.netlify.app",
  ...(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
];
app.use(
  cors({
    origin: allowedOrigins,
  }),
);

app.use("/webhooks/paystack", express.raw({ type: "application/json" }));
app.use(webhookRoutes);

app.use(express.json());
app.use(fundCallbackRoutes);
app.use(authRoutes);
app.use(publicContributionRoutes);
app.use(walletRoutes);
app.use(transferRoutes);
app.use(contributionRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Ajo wallet system running on port ${PORT}`);
  console.log(`Invite links:     ${FRONTEND_BASE_URL}/join/<code>`);
  console.log(`Paystack returns: ${APP_BASE_URL}/wallets/fund/callback`);
  startAjoScheduler();
});
