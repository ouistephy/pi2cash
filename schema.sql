-- Conventions :
--  * PI  : entier en "nano-Pi" (1 Pi = 10^7 unités, précision max du Pi Network)
--  * XOF : entier en francs (pas de décimales)
--  * Aucun float nulle part.

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  pi_uid        TEXT NOT NULL UNIQUE,
  pi_username   TEXT NOT NULL,
  kyc_level     SMALLINT NOT NULL DEFAULT 0,  -- 0 aucun, 1 basique, 2 complet
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id            UUID PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  pi_units      BIGINT NOT NULL CHECK (pi_units > 0),
  rate_xof_per_pi BIGINT NOT NULL CHECK (rate_xof_per_pi > 0),
  fee_bps       INT NOT NULL CHECK (fee_bps >= 0),
  xof_gross     BIGINT NOT NULL,
  xof_fee       BIGINT NOT NULL,
  xof_net       BIGINT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pi_payments (
  pi_payment_id TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  quote_id      UUID NOT NULL UNIQUE REFERENCES quotes(id),
  status        TEXT NOT NULL CHECK (status IN ('approved','completed','failed')),
  txid          TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ledger -----------------------------------------------------------
CREATE TABLE accounts (
  code      TEXT PRIMARY KEY,               -- ex: user:12:xof, platform:fees
  currency  TEXT NOT NULL CHECK (currency IN ('PI','XOF'))
);

CREATE TABLE ledger_tx (
  id              BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,     -- rejoue sans doublon
  kind            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id          BIGSERIAL PRIMARY KEY,
  tx_id       BIGINT NOT NULL REFERENCES ledger_tx(id),
  account     TEXT NOT NULL REFERENCES accounts(code),
  amount      BIGINT NOT NULL CHECK (amount <> 0),  -- >0 débit, <0 crédit
  currency    TEXT NOT NULL CHECK (currency IN ('PI','XOF'))
);
CREATE INDEX ON ledger_entries(account);

-- Payouts ----------------------------------------------------------
CREATE TABLE payouts (
  id              UUID PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  channel         TEXT NOT NULL,            -- ex: wave, orange_money, bank
  destination     TEXT NOT NULL,            -- numéro ou IBAN
  amount_xof      BIGINT NOT NULL CHECK (amount_xof > 0),
  status          TEXT NOT NULL CHECK (status IN ('pending','sent','succeeded','failed')),
  provider_ref    TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO accounts(code, currency) VALUES
  ('platform:pi_treasury','PI'),
  ('platform:pi_sold','PI'),
  ('platform:xof_funding','XOF'),
  ('platform:fees','XOF'),
  ('platform:payout_clearing','XOF');
