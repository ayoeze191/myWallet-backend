# Ajo — a rotating savings app

An **ajo** (also called *esusu* or a ROSCA) is a savings club: a group agrees
on an amount and a rhythm, everybody pays in each round, and each round one
member takes the whole pot. Over a full cycle everyone puts in the same
amount and everyone collects once — the value is getting a lump sum earlier
than you could have saved it alone.

This app is that, built on a wallet. Users fund a wallet (via Paystack),
start a contribution, share an invite link, and members join before the
start date. From then on the rotation runs itself: contributions are pulled
from members' wallets automatically and the pot is paid out in turn.

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

`APP_BASE_URL` in the backend `.env` is the origin invite links are built
against (default `http://localhost:5173`). Set it to wherever the frontend
is actually served or the links you share will point nowhere.

`npm run migrate` is safe to re-run on an existing wallet database — the Ajo
tables are additive and the changes to `wallets` and `transactions` are
written as idempotent `ALTER`s, so existing users, balances, and ledger
history are preserved.

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
| POST   | /contributions      | Yes | Start an Ajo, returns the invite link |
| GET    | /contributions      | Yes | Every Ajo I created or joined       |
| GET    | /contributions/:id  | Yes | Members, rounds, and my position — members only |
| GET    | /invites/:code      | **No** | Preview an invite before signing up |
| POST   | /invites/:code/join | Yes | Accept an invite                    |
| PUT    | /contributions/:id/payout-order | Yes | Creator sets who collects first |
| POST   | /contributions/:id/cancel | Yes | Creator cancels, only before it starts |
| POST   | /contributions/:id/leave  | Yes | Member leaves, only before it starts |
| POST   | /contributions/:id/run    | Yes | Advance this Ajo now instead of waiting for the sweep |

`POST /wallets/me/fund` and `POST /transfers` both **require** an
`Idempotency-Key` header (any unique string per attempt — a UUID from
your client is fine). Retrying the same key returns the original result
instead of processing again. The Ajo engine generates its own keys instead
(see below), because nobody is holding a browser tab open when a round runs.

`GET /invites/:code` is the one deliberately public Ajo route — someone
receiving a link on WhatsApp has to be able to see what they are being
invited to before they have an account. It returns only what you need to
decide: the group's name, the amount, the rhythm, how many seats are left.
No member emails, no pot balance, no wallet IDs. It is mounted **before**
the routers that blanket-require a token, since those 401 anything that
reaches them.

## How an Ajo runs

```
open ──(start date arrives, 2+ members)──► active ──(last round paid)──► completed
  └──(creator cancels)──► cancelled
```

**While it's open** anyone with the link can join, up to the member limit.
The creator arranges the payout order — who collects in round 1, round 2,
and so on. Members can leave; the creator can cancel. Nothing has moved yet.

**When the start date arrives** the group locks. Membership is frozen and
the whole schedule is written out at once: N members means N rounds, one per
member, spaced by the chosen frequency. Slots get renumbered to a clean
1..N at this point — if the creator arranged six people but only four turned
up, their chosen *ordering* survives and the gaps are squeezed out.

**Each round** the engine debits every member's wallet and credits the pot.
Once the pot is whole it pays out to whoever holds that round's slot. The
recipient pays in too — that's how ajo works; they just take the pot home
the same day.

**If someone's wallet is short**, their payment stays pending and is retried
on the next sweep. The round does not pay out until it is fully collected,
so one member being broke delays the round rather than shorting the
recipient. Nothing is created out of thin air to cover them.

A background sweep (`scheduler.js`, every 60s) does this for every live
group. `POST /contributions/:id/run` triggers the same code for one group,
which is what the "Check for due rounds now" button calls — handy for
demoing without waiting on the clock.

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

**7. The group's pot is a real wallet, not a number in a column.**
Each contribution owns a `wallets` row with `kind='escrow'` and no
`user_id`. Money entering and leaving the pot writes ordinary double-entry
ledger rows, so a contribution is auditable with the exact same queries as
everything else, and the pot's balance is derived rather than tracked
separately. The old "one wallet per user" rule survives as a *partial*
unique index (`WHERE kind = 'user'`) so escrow wallets are exempt without
loosening the rule for people.

**8. Idempotency keys can be derived instead of supplied.**
A browser can generate a UUID per click, but the Ajo engine runs on a timer
with nobody watching. So it derives its keys from the rows themselves —
`ajo:contribution:<round_contribution_id>` and `ajo:payout:<round_id>`.
Those are stable across retries by construction, so a sweep that runs twice,
overlaps itself, or resumes after a crash cannot debit anybody a second
time. The uniqueness of the key *is* the guarantee.

**9. Expected failures must not poison the transaction.**
A member with an empty wallet is a normal Tuesday, not an error. `debitWallet`
checks the balance in JS and throws *before* issuing any SQL that would
fail, which means the surrounding transaction is still healthy and can catch
it, record the miss, and carry on collecting from everyone else. Had it let
Postgres reject the write via the `balance >= 0` constraint, the whole
transaction would be poisoned and the members who *did* pay would be rolled
back with it.

**10. Rounds are strictly sequential.**
If round 1 can't close, round 2 doesn't start — the engine breaks out of the
loop rather than skipping ahead. Nobody collects out of turn because someone
else was short that week.

**11. Calendar days are not instants.**
`pool.js` parses Postgres `DATE` columns as plain `'YYYY-MM-DD'` strings.
node-postgres would otherwise hand back a JS `Date` at *local* midnight,
which serialises to the previous day in UTC anywhere east of Greenwich — in
Lagos (UTC+1) every due date would reach the browser one day early. A due
date is a day, not a moment, and is carried as one end to end.

## What's intentionally left out (for a "small" version)

- Reconciliation job to compare `wallets.balance` against summed ledger
- Currency conversion / multi-currency transfers
- Rate limiting on the webhook endpoint
- Retry/backoff on the Paystack API call itself

On the Ajo side specifically:

- **Notifications.** Nobody is told "your round is due in 2 days" or "the pot
  is waiting on you" — `missed_rounds` is recorded and shown in the UI, but
  the nudging is manual. This is the most valuable next thing to build.
- **A penalty or removal policy for defaulters.** A member who never funds
  their wallet stalls their group indefinitely. The engine handles this
  safely (it just keeps waiting) but there is no rule for resolving it.
- **Auto-debiting from a card** when the wallet is short, rather than only
  from the wallet balance.
- **Multi-node scheduling.** The sweep is an in-process `setInterval`. It is
  safe to run twice over (`SKIP LOCKED` plus derived idempotency keys), but
  across several server instances you'd want a real job runner.
