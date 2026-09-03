# Ajo — backend

The API and rotation engine behind **Ajo**, a rotating-savings app built on a
double-entry wallet ledger.

An **ajo** (also *esusu*, or a ROSCA) is a savings club: a group agrees on an
amount and a rhythm, everybody pays in each round, and each round one member
takes the whole pot. Over a full cycle everyone puts in the same amount and
everyone collects exactly once — the value is getting a lump sum earlier than
you could have saved it alone.

This service does three things:

1. **Wallets** — one per user, funded with Paystack, spendable by transfer.
2. **A ledger** — append-only double-entry rows that are the source of truth
   for every naira in the system.
3. **The Ajo engine** — a background sweep that starts groups when their date
   arrives, pulls each round's contributions out of members' wallets, and pays
   the pot out in turn.

The React client lives in [`frontend/`](frontend/) and is a separate
repository with its own README.

---

## Stack

| Piece | Choice |
|---|---|
| Runtime | Node.js 20+ (developed on 22) |
| Framework | Express 4 |
| Database | PostgreSQL 16 (`pg`, raw SQL — no ORM) |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` |
| Payments | Paystack (`axios` for init, HMAC-SHA512 for webhooks) |
| Scheduling | in-process `setInterval` sweep |

Modules are CommonJS (`"type": "commonjs"`).

---

## Quick start

```bash
# 1. Postgres (or point DATABASE_URL at your own instance)
docker compose up -d

# 2. Dependencies
npm install

# 3. Environment
cp .env.example .env      # then fill in JWT_SECRET and PAYSTACK_SECRET_KEY

# 4. Tables
npm run migrate

# 5. Run
npm run dev               # node --watch, restarts on save
```

The server refuses to start without `JWT_SECRET` — that is deliberate, a
wallet API with a default signing secret is worse than one that won't boot.

`npm run migrate` is safe to re-run against an existing database. `schema.sql`
is replayed whole and every statement is written idempotently (`CREATE TABLE
IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before
each `ADD CONSTRAINT`), so existing users, balances and ledger history survive.

| Script | What it does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with `--watch` |
| `npm run migrate` | Apply `src/db/schema.sql` |

---

## Environment

| Variable | Required | Purpose |
|---|:---:|---|
| `PORT` | no | HTTP port, default `4000` |
| `DATABASE_URL` | **yes** | Postgres connection string |
| `JWT_SECRET` | **yes** | Signs auth tokens; the process exits if unset |
| `PAYSTACK_SECRET_KEY` | **yes** | Used both to call Paystack and to verify its webhook signatures |
| `PAYSTACK_BASE_URL` | no | Defaults to `https://api.paystack.co` |
| `APP_BASE_URL` | no | Origin used to build the Paystack `callback_url` and invite links |
| `AJO_TICK_MS` | no | Sweep interval, default `60000` |

Two caveats worth knowing before you deploy:

- **`APP_BASE_URL` is doing two jobs.** The Paystack callback is a *backend*
  route (`/wallets/fund/callback`), while invite links point at a *frontend*
  route (`/join/:code`). With one variable you can only get one of them right;
  splitting it into `APP_BASE_URL` and a separate `FRONTEND_BASE_URL` is the
  fix and is not done yet.
- **CORS origin is hardcoded** to `http://localhost:5173` in
  [server.js](server.js). Change it (or make it an env var) before hosting the
  frontend anywhere else.

---

## Layout

```
server.js                  route mounting order, error handler, scheduler boot
src/
  db/
    pool.js                pg pool + withTransaction() helper, DATE type parser
    schema.sql             the whole schema, re-runnable
    migrate.js             replays schema.sql
  middleware/
    requireAuth.js         Bearer token -> req.userId
  routes/
    auth.js                register (user + wallet atomically), login
    wallets.js             my wallet, my ledger, recipient lookup, fund
    transfers.js           wallet-to-wallet by recipient email
    webhooks.js            Paystack charge.success — the only place money is credited
    fundCallback.js        HTML receipt page Paystack redirects the user back to
    contributions.js       Ajo routes, public invite preview split out
  services/
    auth.js                bcrypt + JWT
    ledger.js              creditWallet / debitWallet / transferBetweenWallets
    idempotency.js         reserve a transaction by key, mark its status
    paystack.js            initialize a charge, verify a webhook signature
    ajo.js                 the rotation engine
    scheduler.js           60s sweep over live contributions
```

**Mounting order in `server.js` is load-bearing.** The Paystack webhook is
mounted with `express.raw()` *before* `express.json()` so the signature can be
checked against the untouched bytes, and the public routes (`/wallets/fund/
callback`, `/invites/:code`) are mounted before the routers that blanket-apply
`requireAuth`, which would otherwise 401 them.

---

## Data model

| Table | Holds |
|---|---|
| `users` | account + bcrypt hash |
| `wallets` | one per user (`kind='user'`), plus one pot per contribution (`kind='escrow'`, no `user_id`) |
| `transactions` | one row per money-moving operation, keyed by a unique `idempotency_key` |
| `ledger_entries` | append-only debit/credit rows — the source of truth |
| `contributions` | an Ajo group: amount, frequency, member limit, start date, invite code, status |
| `contribution_members` | who is in, which payout slot they hold, how many rounds they've missed |
| `contribution_rounds` | one row per rotation: recipient, due date, expected pot |
| `round_contributions` | one row per member per round: did their money actually arrive |

All amounts are `NUMERIC(18,2)`. `wallets.balance` is a **cache** derived from
`ledger_entries`; if it ever looks wrong, sum the ledger to reconcile.

---

## Auth

Every wallet, transfer and contribution route needs a JWT from
`/auth/register` or `/auth/login`, sent as `Authorization: Bearer <token>`.
Tokens last 7 days.

Each user gets exactly one wallet, created in the same DB transaction as the
user — there is no way for a user to exist without a wallet.

The key design point: **which wallet a request affects is never taken from the
request body.** `/wallets/me`, `/wallets/me/fund` and `POST /transfers` all
resolve the wallet from `req.userId`, which the auth middleware sets from the
verified token. A user cannot fund or spend from a wallet that isn't theirs no
matter what JSON they send.

Sending money is done by the recipient's **email**, not a wallet ID.
`/users/lookup?email=` resolves a name so the UI can show a confirmation, and
deliberately returns *only* the name — never a balance or wallet ID — so it
can't be used to snoop on other accounts. Login returns the same error for
"no such user" and "wrong password" so emails can't be enumerated.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|:---:|---|
| POST | `/auth/register` | – | Create account + wallet, get a token |
| POST | `/auth/login` | – | Get a token |
| GET | `/wallets/me` | ✓ | My wallet and balance |
| GET | `/wallets/me/ledger` | ✓ | My ledger entries, newest first |
| GET | `/users/lookup?email=` | ✓ | Resolve a recipient's name |
| POST | `/wallets/me/fund` | ✓ | Start a Paystack deposit → `authorization_url` |
| GET | `/wallets/fund/callback` | – | HTML receipt page Paystack redirects back to |
| POST | `/webhooks/paystack` | signature | Paystack calls this; the only path that credits a wallet |
| POST | `/transfers` | ✓ | Send money to another user by email |
| POST | `/contributions` | ✓ | Start an Ajo, returns the invite link |
| GET | `/contributions` | ✓ | Every Ajo I created or joined |
| GET | `/contributions/:id` | ✓ | Members, rounds, my position — members only |
| GET | `/invites/:code` | **–** | Preview an invite before signing up |
| POST | `/invites/:code/join` | ✓ | Accept an invite |
| PUT | `/contributions/:id/payout-order` | ✓ | Creator sets who collects when |
| POST | `/contributions/:id/cancel` | ✓ | Creator cancels — only before it starts |
| POST | `/contributions/:id/leave` | ✓ | Member leaves — only before it starts |
| POST | `/contributions/:id/run` | ✓ | Advance this Ajo now instead of waiting for the sweep |

### Idempotency

`POST /wallets/me/fund` and `POST /transfers` **require** an `Idempotency-Key`
header — any unique string per attempt, a client-side UUID is fine. Retrying
with the same key returns the original result instead of moving money twice.

```bash
curl -X POST localhost:4000/transfers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"toEmail":"ada@example.com","amount":2500}'
```

The Ajo engine can't ask a browser for a key — nobody is holding a tab open
when a round runs at 3am — so it *derives* them from the rows themselves:
`ajo:contribution:<round_contribution_id>` and `ajo:payout:<round_id>`. Those
are stable across retries by construction.

### The public invite route

`GET /invites/:code` is the one deliberately unauthenticated Ajo route —
someone who receives a link on WhatsApp has to be able to see what they're
being invited to before they have an account. It returns the group's name,
amount, rhythm, seats left, and what the pot is worth when full. No member
emails, no current pot balance, no wallet IDs.

### The funding flow

```
POST /wallets/me/fund  ──►  Paystack hosted page  ──►  GET /wallets/fund/callback
                                    │                        (receipt page only)
                                    └──► POST /webhooks/paystack  ──► wallet credited
```

The browser redirect is a **receipt, not evidence**. A user can reach the
callback URL without paying, so it only reads the transaction's current status
and renders it. Only the signature-verified webhook ever writes a credit.

To exercise this locally you need a public URL for the webhook — expose port
4000 with a tunnel (ngrok, cloudflared) and set that as the webhook URL in
your Paystack dashboard. Card `4084 0840 8408 4081` works on test keys.

---

## How an Ajo runs

```
open ──(start date arrives, 2+ members)──► active ──(last round paid)──► completed
  └──(creator cancels)──► cancelled
```

**While it's open**, anyone with the link can join, up to the member limit.
The creator arranges the payout order. Members can leave, the creator can
cancel. Nothing has moved yet.

**When the start date arrives** the group locks. Membership is frozen and the
whole schedule is written at once: N members means N rounds, one per member,
spaced by the chosen frequency. Slots are renumbered to a clean 1..N here — if
the creator arranged six people and only four turned up, their *ordering*
survives and the gaps are squeezed out.

**Each round** the engine debits every member's wallet and credits the pot,
then pays the whole pot to whoever holds that round's slot. The recipient pays
in too — that's how ajo works, they just take the pot home the same day.

**If someone's wallet is short**, their contribution stays `pending` and is
retried on the next sweep. The round does not pay out until it is fully
collected, so one member being broke *delays* the round rather than shorting
the recipient. Nothing is invented to cover them, and their `missed_rounds`
counter goes up once.

`scheduler.js` runs this over every live group every 60 seconds.
`POST /contributions/:id/run` executes the same code for a single group, which
is what the UI's "Check for due rounds now" button calls — handy for demoing
without waiting on the clock.

---

## The ideas this codebase is built around

**1. Money is `NUMERIC`, never `FLOAT`.** Floats accumulate rounding error
that compounds over thousands of transactions.

**2. The ledger is the source of truth, not the balance column.**
`ledger_entries` is append-only; rows are never edited or deleted. Every
transfer writes both a debit row and a credit row, so money is never created
or destroyed, only moved. `wallets.balance` is a cache for fast reads.

**3. Row locking prevents lost updates.** `SELECT ... FOR UPDATE` inside a
transaction locks the wallet row for the duration of the operation. Without
it, two simultaneous requests could read the same starting balance and both
"succeed", silently losing one. Transfers lock both wallets in sorted-by-id
order so two opposite-direction transfers can't deadlock each other.

**4. Idempotency keys prevent double-processing.** `idempotency.js` reserves
the key by inserting the transaction row *before* any work happens. The unique
constraint on the key *is* the guarantee.

**5. Webhooks are verified, not trusted.** `webhooks.js` recomputes the
HMAC-SHA512 of the raw body with your secret key and compares it before
believing a word of the payload.

**6. Every money operation runs inside one DB transaction.**
`withTransaction()` makes BEGIN/COMMIT/ROLLBACK impossible to forget, so you
never end up with a debit that happened and a credit that didn't.

**7. The group's pot is a real wallet, not a number in a column.** Each
contribution owns a `wallets` row with `kind='escrow'`. Money entering and
leaving the pot writes ordinary double-entry rows, so a contribution is
auditable with the exact same queries as everything else. The "one wallet per
user" rule survives as a *partial* unique index (`WHERE kind = 'user'`), which
exempts escrow wallets without loosening the rule for people.

**8. Expected failures must not poison the transaction.** A member with an
empty wallet is a normal Tuesday, not an error. `debitWallet` checks the
balance in JS and throws *before* issuing SQL that would fail, so the
surrounding transaction stays healthy and can record the miss and carry on
collecting from everyone else. Letting Postgres reject the write via the
`balance >= 0` constraint would poison the transaction and roll back the
members who *did* pay.

**9. Rounds are strictly sequential.** If round 1 can't close, round 2 doesn't
start — the engine breaks out of the loop rather than skipping ahead. Nobody
collects out of turn because someone else was short that week.

**10. Concurrent sweeps are safe.** `FOR UPDATE SKIP LOCKED` means an
overlapping tick moves on rather than queueing up to redo the work, and the
derived idempotency keys mean even a crash-and-resume can't double-debit.

**11. Calendar days are not instants.** `pool.js` parses Postgres `DATE`
columns as plain `'YYYY-MM-DD'` strings. node-postgres would otherwise build a
JS `Date` at *local* midnight, which serialises to the previous day in UTC
anywhere east of Greenwich — in Lagos every due date would reach the browser a
day early. A due date is a day, not a moment, and is carried as one end to end.

---

## Known gaps

Deliberately out of scope for a small version:

- No reconciliation job comparing `wallets.balance` against the summed ledger.
- No multi-currency or conversion — `currency` is stored but never converted.
- No rate limiting on the webhook endpoint, and no retry/backoff around the
  Paystack API call itself.
- **No notifications.** Nobody is told "your round is due in 2 days" or "the
  pot is waiting on you". `missed_rounds` is recorded and shown, but the
  nudging is manual. This is the most valuable next thing to build.
- **No defaulter policy.** A member who never funds their wallet stalls their
  group indefinitely. The engine handles it *safely* — it just keeps waiting —
  but there is no rule for resolving it.
- No auto-debit from a card when the wallet is short.
- **Single-node scheduling.** The sweep is an in-process `setInterval`. It is
  safe to run twice over, but across several instances you'd want a real job
  runner with a shared lock.
- `lucide-react` is listed in `dependencies` here but belongs to the frontend;
  harmless, but it can be dropped.
