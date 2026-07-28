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
