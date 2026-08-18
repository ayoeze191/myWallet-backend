-- Money is stored as NUMERIC, never FLOAT — floats lose precision on currency.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  owner_name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  balance NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every money-moving operation gets ONE row here, keyed by a client-supplied
-- idempotency key. If the same request is retried, we detect the duplicate
-- and return the original result instead of processing it twice.
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('fund', 'transfer')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  paystack_reference TEXT UNIQUE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The ledger is the source of truth for money movement. It is append-only —
-- rows are never updated or deleted. wallets.balance is a cache derived from
-- this; if it ever looks wrong, sum this table to reconcile.
CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(18,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON ledger_entries(transaction_id);


-- ==========================================================================
-- AJO / ESUSU — rotating savings contributions
-- ==========================================================================
-- Everything below is written to be re-runnable, because migrate.js simply
-- replays this whole file. Existing installs get ALTERed in place.

-- A contribution's pot lives in a real wallet that belongs to the GROUP, not
-- to any user. That keeps every naira inside the same double-entry ledger
-- the rest of the system already trusts. So user_id has to become optional.
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE wallets ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_user_id_key;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_kind_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_kind_check CHECK (
  (kind = 'user'   AND user_id IS NOT NULL) OR
  (kind = 'escrow' AND user_id IS NULL)
);
-- A person still gets exactly one personal wallet; escrow wallets are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personal_wallet_per_user
  ON wallets(user_id) WHERE kind = 'user';

-- Two new money-movement types: a member paying into a round, and the pot
-- paying out to whoever's turn it is.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (
  type IN ('fund', 'transfer', 'contribution', 'payout')
);

-- The contribution group itself.
--
-- Lifecycle: open ──(start_date reached, >=2 members)──► active
--                └──(creator cancels)──► cancelled
--            active ──(final round paid out)──► completed
--
-- While 'open', anyone holding the invite_code can join. Once 'active' the
-- membership is frozen — the payout schedule depends on it not changing.
CREATE TABLE IF NOT EXISTS contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id),
  escrow_wallet_id UUID NOT NULL REFERENCES wallets(id),
  name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'NGN',
  -- What each member pays in, every single round.
  contribution_amount NUMERIC(18,2) NOT NULL CHECK (contribution_amount > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  member_limit INT NOT NULL CHECK (member_limit BETWEEN 2 AND 50),
  start_date DATE NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'active', 'completed', 'cancelled')),
  total_rounds INT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contributions_creator ON contributions(creator_id);
CREATE INDEX IF NOT EXISTS idx_contributions_status ON contributions(status);

-- Who is in the group, and in what position they collect the pot.
-- payout_slot is NULL until the creator assigns it; the engine falls back to
-- join order for anyone still unassigned when the group goes live.
CREATE TABLE IF NOT EXISTS contribution_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  payout_slot INT CHECK (payout_slot > 0),
  missed_rounds INT NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contribution_id, user_id),
  UNIQUE (contribution_id, payout_slot)
);

CREATE INDEX IF NOT EXISTS idx_members_contribution ON contribution_members(contribution_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON contribution_members(user_id);

-- One row per rotation. Round N pays out to whoever holds payout_slot N.
CREATE TABLE IF NOT EXISTS contribution_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  round_number INT NOT NULL,
  recipient_member_id UUID NOT NULL REFERENCES contribution_members(id),
  due_date DATE NOT NULL,
  -- What the pot should hold once everyone has paid in.
  expected_total NUMERIC(18,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'collecting', 'paid')),
  collected_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  UNIQUE (contribution_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_rounds_contribution ON contribution_rounds(contribution_id);

-- One row per member per round: did this person's money actually arrive?
-- The recipient of a round pays in too — that is how esusu works, they just
-- take the whole pot home the same day.
CREATE TABLE IF NOT EXISTS round_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES contribution_rounds(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES contribution_members(id),
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  transaction_id UUID REFERENCES transactions(id),
  paid_at TIMESTAMPTZ,
  UNIQUE (round_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_round_contributions_round ON round_contributions(round_id);
