# Wallet System

A small backend for saving money in wallets and sending money between them.
Deposits are funded via Paystack; internal transfers happen wallet-to-wallet.

## Setup

### Backend
```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and PAYSTACK_SECRET_KEY
npm run migrate         # creates tables
npm run dev             # starts server on PORT (default 4000)
```

### Frontend
```bash
cd frontend
npm install
cp .env.example .env   # set VITE_API_BASE_URL if backend isn't on localhost:4000
npm run dev             # starts on http://localhost:5173
```

You'll need a local Postgres running and a free Paystack test account
(dashboard.paystack.com) for the secret key.

## Frontend design notes

The UI is deliberately built to look like the thing it represents: a ledger.
It borrows from classic green-bar continuous-feed accounting paper —
striped rows, tabular monospace numbers, and ink-stamp style badges for
credit/debit — rather than a generic dark-mode fintech dashboard. The
perforated left edge on the ledger table is the one intentional flourish;
everything else stays quiet so that detail can stand out.

## Auth

Every wallet/transfer route requires a JWT from `/auth/register` or
`/auth/login`, sent as `Authorization: Bearer <token>`. Each user gets
exactly one wallet, created atomically at registration — there's no way
for a user to exist without a wallet or vice versa.

Key design point: which wallet a request affects is **never** taken from
the request body. `/wallets/me`, `/wallets/me/fund`, and `POST /transfers`
all resolve the wallet from `req.userId` (set by the auth middleware from
the verified token). A user cannot fund or transfer out of a wallet that
isn't theirs, no matter what they put in the JSON body.

Sending money is done by the recipient's **email**, not their wallet ID —
`/users/lookup?email=` resolves a name for a confirmation UI but
deliberately never returns balance or wallet ID, so it can't be used to
snoop on other users' accounts.

## Endpoints

| Method | Path                | Auth required | Purpose                          |
|--------|---------------------|:---:|-----------------------------------|
| POST   | /auth/register      | No  | Create account + wallet, get a token |
| POST   | /auth/login         | No  | Get a token                        |
| GET    | /wallets/me         | Yes | My wallet + balance                |
| GET    | /wallets/me/ledger  | Yes | My transaction history             |
| GET    | /users/lookup       | Yes | Look up a recipient's name by email |
| POST   | /wallets/me/fund    | Yes | Start a Paystack deposit           |
| POST   | /webhooks/paystack  | No* | Paystack calls this — signature-verified instead of auth'd |
| POST   | /transfers          | Yes | Send money to another user by email |

`POST /wallets/me/fund` and `POST /transfers` both **require** an
`Idempotency-Key` header (any unique string per attempt — a UUID from
your client is fine). Retrying the same key returns the original result
instead of processing again.

## The concepts this project is built to teach

**1. Money is NUMERIC, never FLOAT.**
`schema.sql` stores all amounts as `NUMERIC(18,2)`. Floats introduce
rounding errors that compound over thousands of transactions — never use
them for currency.

**2. The ledger is the source of truth, not the balance column.**
`ledger_entries` is append-only: every credit and debit gets its own row,
and rows are never edited or deleted. `wallets.balance` is a cache for
fast reads. If it ever looks wrong, you can rebuild it by summing the
ledger. This is the "double-entry" idea — every transfer writes both a
debit row and a credit row, so money is never created or destroyed, only
moved.

**3. Row locking prevents race conditions.**
`SELECT ... FOR UPDATE` inside a transaction (`ledger.js`) locks a
wallet's row for the duration of the operation. Without this, two
simultaneous requests could both read the same starting balance and
both "succeed," silently losing one of the updates. Transfers lock both
wallets in a consistent sorted order to avoid deadlocking against an
opposite-direction transfer happening at the same time.

**4. Idempotency keys prevent double-processing.**
`idempotency.js` reserves a unique key before doing any work. A network
timeout that causes a client to retry a "Send Money" request will hit
the same key twice — the second attempt returns the first result instead
of moving money again.

**5. Webhooks are verified, not trusted.**
`webhooks.js` recomputes the HMAC-SHA512 signature Paystack sent and
compares it before treating the payload as real. The wallet is only
credited here — never from the client-side payment redirect, which a
user could reach without actually paying.

**6. Everything money-related happens inside a DB transaction.**
`withTransaction` in `pool.js` ensures that if any step of a
multi-step money operation fails, all of it rolls back — you never end
up with a debit that happened but a credit that didn't.

## What's intentionally left out (for a "small" version)

- Authentication/authorization on the API itself
- Reconciliation job to compare `wallets.balance` against summed ledger
- Currency conversion / multi-currency transfers
- Rate limiting on the webhook endpoint
- Retry/backoff on the Paystack API call itself

Happy to add any of these next.
