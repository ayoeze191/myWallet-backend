# Ajo — backend

Express + PostgreSQL API for **Ajo**, a rotating-savings (esusu) app. Users
fund a wallet with Paystack, send money to each other, withdraw to a bank, and
join savings groups where one member collects the pot each round.

## Setup

```bash
docker compose up -d      # Postgres
npm install
cp .env.example .env      # set DATABASE_URL, JWT_SECRET, PAYSTACK_SECRET_KEY
npm run migrate
npm run dev
```
