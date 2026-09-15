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

ALTER TABLE wallets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE wallets ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_user_id_key;
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_kind_check;
ALTER TABLE wallets ADD CONSTRAINT wallets_kind_check CHECK (
  (kind = 'user' AND user_id IS NOT NULL) OR
  (kind IN ('escrow', 'fees') AND user_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_personal_wallet_per_user
  ON wallets(user_id) WHERE kind = 'user';

-- One platform wallet collects transfer and withdrawal fees.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fees_wallet ON wallets(kind) WHERE kind = 'fees';
INSERT INTO wallets (user_id, owner_name, currency, kind)
SELECT NULL, 'Platform fees', 'NGN', 'fees'
WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE kind = 'fees');

-- 'fee' / 'fee refund' marks fee lines so the app can label them.
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS memo TEXT;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (
  type IN ('fund', 'transfer', 'contribution', 'payout', 'withdrawal')
);

CREATE TABLE IF NOT EXISTS contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES users(id),
  escrow_wallet_id UUID NOT NULL REFERENCES wallets(id),
  name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'NGN',
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

CREATE TABLE IF NOT EXISTS contribution_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  round_number INT NOT NULL,
  recipient_member_id UUID NOT NULL REFERENCES contribution_members(id),
  due_date DATE NOT NULL,
  expected_total NUMERIC(18,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'collecting', 'paid')),
  collected_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  UNIQUE (contribution_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_rounds_contribution ON contribution_rounds(contribution_id);

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
