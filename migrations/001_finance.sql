BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS legacy_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  payload jsonb NOT NULL,
  imported_from text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_config (
  guild_id text PRIMARY KEY,
  finance_mode text NOT NULL DEFAULT 'disabled' CHECK (finance_mode IN ('disabled','shadow','live')),
  business_account_id bigint,
  finance_channel_id text,
  plugin_system text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shareholders (
  id bigserial PRIMARY KEY,
  discord_id text NOT NULL UNIQUE,
  owner_uuid uuid NOT NULL UNIQUE,
  current_ign text NOT NULL,
  account_id bigint UNIQUE,
  key_id bigint UNIQUE,
  token_key_version text,
  token_nonce bytea,
  token_tag bytea,
  token_ciphertext bytea,
  token_expires_at timestamptz,
  webhook_id bigint,
  webhook_secret_key_version text,
  webhook_secret_nonce bytea,
  webhook_secret_tag bytea,
  webhook_secret_ciphertext bytea,
  connected_at timestamptz,
  disconnected_at timestamptz,
  CHECK ((token_ciphertext IS NULL) = (token_nonce IS NULL)),
  CHECK ((token_ciphertext IS NULL) = (token_tag IS NULL)),
  CHECK ((token_ciphertext IS NULL) = (token_key_version IS NULL))
);

CREATE TABLE IF NOT EXISTS properties (
  id bigserial PRIMARY KEY,
  region text NOT NULL UNIQUE CHECK (region = upper(region)),
  landlord_shareholder_id bigint NOT NULL REFERENCES shareholders(id),
  status text NOT NULL CHECK (status IN ('ACTIVE','DISABLED','REVIEW_REQUIRED')),
  property_type text NOT NULL DEFAULT 'STANDARD' CHECK (property_type IN ('STANDARD','PERMANENT_LEASEHOLD')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ownership_versions (
  id bigserial PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES properties(id),
  version integer NOT NULL CHECK (version > 0),
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  reason text NOT NULL,
  UNIQUE(property_id, version)
);

CREATE TABLE IF NOT EXISTS ownership_allocations (
  ownership_version_id bigint NOT NULL REFERENCES ownership_versions(id),
  shareholder_id bigint NOT NULL REFERENCES shareholders(id),
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY (ownership_version_id, shareholder_id)
);

CREATE OR REPLACE FUNCTION ownership_total_is_10000(version_id bigint) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(sum(basis_points),0) = 10000 FROM ownership_allocations WHERE ownership_version_id = version_id
$$;

CREATE TABLE IF NOT EXISTS treasury_subscriptions (
  id bigserial PRIMARY KEY,
  scope text NOT NULL,
  treasury_webhook_id bigint NOT NULL UNIQUE,
  account_id bigint,
  firm_id bigint,
  shareholder_id bigint REFERENCES shareholders(id),
  secret_key_version text NOT NULL,
  secret_nonce bytea NOT NULL,
  secret_tag bytea NOT NULL,
  secret_ciphertext bytea NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id bigserial PRIMARY KEY,
  subscription_id bigint NOT NULL REFERENCES treasury_subscriptions(id),
  delivery_id text NOT NULL,
  event_name text NOT NULL,
  body_event_name text NOT NULL,
  body_delivery_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  UNIQUE(subscription_id, delivery_id),
  CHECK(event_name = body_event_name),
  CHECK(delivery_id = body_delivery_id)
);

CREATE TABLE IF NOT EXISTS treasury_postings (
  id bigserial PRIMARY KEY,
  account_id bigint NOT NULL,
  posting_id bigint NOT NULL,
  txn_id bigint NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  memo text,
  message text,
  settled_at timestamptz NOT NULL,
  initiator_uuid uuid,
  plugin_system text,
  source text NOT NULL CHECK (source IN ('webhook','feed')),
  raw_payload jsonb NOT NULL,
  classification text NOT NULL DEFAULT 'PENDING' CHECK (classification IN ('PENDING','RENT','REFUND','SWEEP','PAYOUT','FUND_LANDLORD','LEASEHOLD','UNCLASSIFIED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, posting_id)
);

CREATE TABLE IF NOT EXISTS rentals (
  id bigserial PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES properties(id),
  ownership_version_id bigint NOT NULL REFERENCES ownership_versions(id),
  landlord_shareholder_id bigint NOT NULL REFERENCES shareholders(id),
  original_account_id bigint NOT NULL,
  business_account_id bigint NOT NULL,
  posting_id bigint NOT NULL REFERENCES treasury_postings(id),
  txn_id bigint NOT NULL,
  gross_cents bigint NOT NULL CHECK (gross_cents > 0),
  settled_at timestamptz NOT NULL,
  hold_until timestamptz NOT NULL,
  sweep_status text NOT NULL DEFAULT 'PENDING' CHECK (sweep_status IN ('PENDING','SHADOW','SUBMITTED','SETTLED','FAILED','UNKNOWN')),
  release_status text NOT NULL DEFAULT 'HELD' CHECK (release_status IN ('HELD','CLAIMED','PARTIAL','PAID','FAILED')),
  total_refunded_cents bigint NOT NULL DEFAULT 0 CHECK (total_refunded_cents >= 0 AND total_refunded_cents <= gross_cents),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(original_account_id, txn_id)
);

CREATE TABLE IF NOT EXISTS rental_allocations (
  rental_id bigint NOT NULL REFERENCES rentals(id),
  shareholder_id bigint NOT NULL REFERENCES shareholders(id),
  basis_points integer NOT NULL CHECK (basis_points BETWEEN 0 AND 10000),
  gross_entitlement_cents bigint NOT NULL CHECK (gross_entitlement_cents >= 0),
  refund_liability_cents bigint NOT NULL DEFAULT 0 CHECK (refund_liability_cents >= 0),
  paid_cents bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD','NETTED','CLAIMED','PAID','PARTIAL','FAILED')),
  PRIMARY KEY(rental_id, shareholder_id)
);

CREATE TABLE IF NOT EXISTS shareholder_debts (
  id bigserial PRIMARY KEY,
  shareholder_id bigint NOT NULL REFERENCES shareholders(id),
  source_refund_id bigint,
  original_cents bigint NOT NULL CHECK (original_cents > 0),
  outstanding_cents bigint NOT NULL CHECK (outstanding_cents >= 0 AND outstanding_cents <= original_cents),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PARTIAL','RECOVERED','REVERSED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refunds (
  id bigserial PRIMARY KEY,
  property_id bigint NOT NULL REFERENCES properties(id),
  rental_id bigint REFERENCES rentals(id),
  landlord_shareholder_id bigint NOT NULL REFERENCES shareholders(id),
  posting_id bigint NOT NULL UNIQUE REFERENCES treasury_postings(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  matched_status text NOT NULL CHECK (matched_status IN ('MATCHED','REVIEW_REQUIRED')),
  reimbursement_status text NOT NULL DEFAULT 'QUEUED' CHECK (reimbursement_status IN ('QUEUED','CLAIMED','SUBMITTED','PAID','FAILED','UNKNOWN')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reimbursed_at timestamptz
);
ALTER TABLE shareholder_debts DROP CONSTRAINT IF EXISTS shareholder_debts_source_refund_id_fkey;
ALTER TABLE shareholder_debts ADD CONSTRAINT shareholder_debts_source_refund_id_fkey FOREIGN KEY(source_refund_id) REFERENCES refunds(id);

CREATE TABLE IF NOT EXISTS monetary_operations (
  id bigserial PRIMARY KEY,
  operation_type text NOT NULL CHECK (operation_type IN ('SWEEP','PAYOUT','REFUND_REIMBURSEMENT','FUND_LANDLORD')),
  workflow_type text NOT NULL,
  workflow_id bigint NOT NULL,
  leg_key text NOT NULL,
  source_account_id bigint NOT NULL,
  destination_account_id bigint,
  destination_uuid uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  memo text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SHADOW','CLAIMED','SUBMITTED','SETTLED','FAILED','UNKNOWN','CANCELLED')),
  treasury_txn_id bigint,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_type, workflow_id, leg_key)
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  workflow_type text NOT NULL,
  workflow_id bigint NOT NULL,
  reversal_of bigint REFERENCES ledger_transactions(id),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY,
  ledger_transaction_id bigint NOT NULL REFERENCES ledger_transactions(id),
  bucket text NOT NULL CHECK (bucket IN ('TREASURY_CASH','HELD_FUNDS','SHAREHOLDER_PAYABLE','COMPANY_RETAINED','REFUND_RESERVE','SHAREHOLDER_DEBT','QUEUED_REIMBURSEMENT','UNCLASSIFIED')),
  shareholder_id bigint REFERENCES shareholders(id),
  debit_cents bigint NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents bigint NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  CHECK ((debit_cents = 0) <> (credit_cents = 0))
);

CREATE OR REPLACE FUNCTION enforce_balanced_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id bigint; debits bigint; credits bigint;
BEGIN
  target_id := COALESCE(NEW.ledger_transaction_id, OLD.ledger_transaction_id);
  SELECT COALESCE(sum(debit_cents),0), COALESCE(sum(credit_cents),0) INTO debits, credits FROM ledger_entries WHERE ledger_transaction_id=target_id;
  IF debits <> credits THEN RAISE EXCEPTION 'Unbalanced ledger transaction %: % != %', target_id, debits, credits; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ledger_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT OR UPDATE OR DELETE ON ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_balanced_ledger();

CREATE TABLE IF NOT EXISTS reconciliation_cursors (
  account_id bigint PRIMARY KEY,
  cursor bigint NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_error text
);

CREATE TABLE IF NOT EXISTS unclassified_transactions (
  posting_id bigint PRIMARY KEY REFERENCES treasury_postings(id),
  reason text NOT NULL,
  review_status text NOT NULL DEFAULT 'OPEN' CHECK (review_status IN ('OPEN','RESOLVED','IGNORED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_events are immutable'; END $$;
DROP TRIGGER IF EXISTS audit_immutable ON audit_events;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE TABLE IF NOT EXISTS connection_tokens (
  token_hash text PRIMARY KEY,
  discord_id text NOT NULL,
  guild_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaseholds (
  id bigserial PRIMARY KEY,
  property_id bigint NOT NULL UNIQUE REFERENCES properties(id),
  payer_uuid uuid NOT NULL,
  payer_ign text NOT NULL,
  fee_cents bigint NOT NULL CHECK (fee_cents > 0),
  interval_days integer NOT NULL CHECK (interval_days > 0),
  payment_reference text NOT NULL UNIQUE,
  next_due_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARREARS','CLOSED')),
  contract_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leasehold_charges (
  id bigserial PRIMARY KEY,
  leasehold_id bigint NOT NULL REFERENCES leaseholds(id),
  period_start timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE','PAID','ARREARS','WAIVED')),
  posting_id bigint REFERENCES treasury_postings(id),
  paid_at timestamptz,
  UNIQUE(leasehold_id, period_start)
);

CREATE INDEX IF NOT EXISTS monetary_operations_work_idx ON monetary_operations(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS rentals_release_idx ON rentals(release_status,hold_until);
CREATE INDEX IF NOT EXISTS refunds_queue_idx ON refunds(reimbursement_status,created_at);
CREATE INDEX IF NOT EXISTS treasury_postings_txn_idx ON treasury_postings(account_id,txn_id);

INSERT INTO schema_migrations(version) VALUES ('001_finance') ON CONFLICT DO NOTHING;
COMMIT;
