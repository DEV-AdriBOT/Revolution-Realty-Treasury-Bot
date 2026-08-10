BEGIN;

ALTER TABLE treasury_subscriptions ADD COLUMN IF NOT EXISTS guild_id text REFERENCES guild_config(guild_id);
ALTER TABLE leaseholds ADD COLUMN IF NOT EXISTS guild_id text REFERENCES guild_config(guild_id);
ALTER TABLE guild_config ADD COLUMN IF NOT EXISTS emergency_disabled boolean NOT NULL DEFAULT false;

ALTER TABLE rentals ADD COLUMN IF NOT EXISTS company_retained_cents bigint;
UPDATE rentals r SET company_retained_cents = r.gross_cents - COALESCE((
  SELECT sum(ra.gross_entitlement_cents) FROM rental_allocations ra WHERE ra.rental_id=r.id
), 0) WHERE company_retained_cents IS NULL;
ALTER TABLE rentals ALTER COLUMN company_retained_cents SET NOT NULL;
ALTER TABLE rentals DROP CONSTRAINT IF EXISTS rentals_company_retained_cents_check;
ALTER TABLE rentals ADD CONSTRAINT rentals_company_retained_cents_check CHECK (company_retained_cents >= 0 AND company_retained_cents <= gross_cents);

ALTER TABLE rental_allocations ADD COLUMN IF NOT EXISTS debt_recovered_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE rental_allocations DROP CONSTRAINT IF EXISTS rental_allocations_debt_recovered_cents_check;
ALTER TABLE rental_allocations ADD CONSTRAINT rental_allocations_debt_recovered_cents_check CHECK (debt_recovered_cents >= 0);

ALTER TABLE monetary_operations ADD COLUMN IF NOT EXISTS automatic_retry boolean NOT NULL DEFAULT true;
ALTER TABLE monetary_operations ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

ALTER TABLE treasury_postings DROP CONSTRAINT IF EXISTS treasury_postings_classification_check;
ALTER TABLE treasury_postings ADD CONSTRAINT treasury_postings_classification_check
  CHECK (classification IN ('PENDING','RENT','REFUND','SWEEP','PAYOUT','FUND_LANDLORD','LEASEHOLD','RESERVE_DEPOSIT','UNCLASSIFIED'));

CREATE TABLE IF NOT EXISTS debt_recoveries (
  id bigserial PRIMARY KEY,
  debt_id bigint NOT NULL REFERENCES shareholder_debts(id),
  rental_id bigint NOT NULL REFERENCES rentals(id),
  shareholder_id bigint NOT NULL REFERENCES shareholders(id),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(debt_id, rental_id)
);

CREATE TABLE IF NOT EXISTS account_reconciliation (
  account_id bigint PRIMARY KEY,
  guild_id text REFERENCES guild_config(guild_id),
  baseline_cents bigint NOT NULL,
  posting_total_cents bigint NOT NULL,
  treasury_balance_cents bigint NOT NULL,
  mismatch_cents bigint NOT NULL DEFAULT 0,
  last_checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS monetary_operations_claimed_idx ON monetary_operations(status,claimed_at);
CREATE UNIQUE INDEX IF NOT EXISTS monetary_operations_memo_unique_idx ON monetary_operations(memo);
CREATE INDEX IF NOT EXISTS notification_outbox_claimed_idx ON notification_outbox(status,claimed_at);
CREATE INDEX IF NOT EXISTS treasury_subscriptions_account_idx ON treasury_subscriptions(account_id,active);
CREATE UNIQUE INDEX IF NOT EXISTS treasury_one_active_scope_idx ON treasury_subscriptions(scope,COALESCE(guild_id,''),COALESCE(shareholder_id,0)) WHERE active;

CREATE OR REPLACE FUNCTION enforce_operation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='SETTLED' THEN RAISE EXCEPTION 'Settled operations are immutable'; END IF;
  IF OLD.status=NEW.status THEN RETURN NEW; END IF;
  IF NEW.status='SETTLED' AND OLD.status<>'CANCELLED' THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status='PENDING' AND NEW.status IN ('CLAIMED','SHADOW','CANCELLED')) OR
    (OLD.status='SHADOW' AND NEW.status IN ('PENDING','CANCELLED')) OR
    (OLD.status='CLAIMED' AND NEW.status IN ('SUBMITTED','FAILED','UNKNOWN')) OR
    (OLD.status='SUBMITTED' AND NEW.status IN ('FAILED','UNKNOWN')) OR
    (OLD.status IN ('FAILED','UNKNOWN') AND NEW.status IN ('PENDING','CLAIMED','CANCELLED'))
  ) THEN RAISE EXCEPTION 'Invalid monetary operation transition % -> %', OLD.status, NEW.status; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_rental_allocation_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id bigint; gross bigint; company bigint; allocated bigint;
BEGIN
  IF TG_TABLE_NAME='rentals' THEN
    target_id := CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    target_id := CASE WHEN TG_OP='DELETE' THEN OLD.rental_id ELSE NEW.rental_id END;
  END IF;
  SELECT gross_cents,company_retained_cents INTO gross,company FROM rentals WHERE id=target_id;
  IF FOUND THEN
    SELECT COALESCE(sum(gross_entitlement_cents),0) INTO allocated FROM rental_allocations WHERE rental_id=target_id;
    IF company + allocated <> gross THEN RAISE EXCEPTION 'Rental % allocation and company fee must equal gross',target_id; END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS rental_total_from_rental ON rentals;
CREATE CONSTRAINT TRIGGER rental_total_from_rental AFTER INSERT OR UPDATE OF gross_cents,company_retained_cents ON rentals
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_rental_allocation_total();
DROP TRIGGER IF EXISTS rental_total_from_allocation ON rental_allocations;
CREATE CONSTRAINT TRIGGER rental_total_from_allocation AFTER INSERT OR UPDATE OR DELETE ON rental_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_rental_allocation_total();

CREATE OR REPLACE FUNCTION prevent_financial_identity_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='rentals' THEN
    IF OLD.property_id IS DISTINCT FROM NEW.property_id OR OLD.ownership_version_id IS DISTINCT FROM NEW.ownership_version_id OR
       OLD.landlord_shareholder_id IS DISTINCT FROM NEW.landlord_shareholder_id OR OLD.original_account_id IS DISTINCT FROM NEW.original_account_id OR
       OLD.business_account_id IS DISTINCT FROM NEW.business_account_id OR OLD.posting_id IS DISTINCT FROM NEW.posting_id OR
       OLD.txn_id IS DISTINCT FROM NEW.txn_id OR OLD.gross_cents IS DISTINCT FROM NEW.gross_cents OR
       OLD.company_retained_cents IS DISTINCT FROM NEW.company_retained_cents OR OLD.settled_at IS DISTINCT FROM NEW.settled_at OR
       OLD.hold_until IS DISTINCT FROM NEW.hold_until
    THEN RAISE EXCEPTION 'Rental financial identity is immutable'; END IF;
  ELSIF TG_TABLE_NAME='monetary_operations' THEN
    IF OLD.status='SETTLED' AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Settled operations are immutable'; END IF;
    IF OLD.operation_type IS DISTINCT FROM NEW.operation_type OR OLD.workflow_type IS DISTINCT FROM NEW.workflow_type OR
       OLD.workflow_id IS DISTINCT FROM NEW.workflow_id OR OLD.leg_key IS DISTINCT FROM NEW.leg_key OR
       OLD.source_account_id IS DISTINCT FROM NEW.source_account_id OR OLD.destination_account_id IS DISTINCT FROM NEW.destination_account_id OR
       OLD.destination_uuid IS DISTINCT FROM NEW.destination_uuid OR OLD.amount_cents IS DISTINCT FROM NEW.amount_cents OR
       OLD.memo IS DISTINCT FROM NEW.memo OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key OR
       OLD.request_fingerprint IS DISTINCT FROM NEW.request_fingerprint
    THEN RAISE EXCEPTION 'Monetary operation request identity is immutable'; END IF;
  ELSIF TG_TABLE_NAME='treasury_postings' THEN
    IF OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.posting_id IS DISTINCT FROM NEW.posting_id OR
       OLD.txn_id IS DISTINCT FROM NEW.txn_id OR OLD.amount_cents IS DISTINCT FROM NEW.amount_cents OR
       OLD.memo IS DISTINCT FROM NEW.memo OR OLD.message IS DISTINCT FROM NEW.message OR OLD.settled_at IS DISTINCT FROM NEW.settled_at OR
       OLD.initiator_uuid IS DISTINCT FROM NEW.initiator_uuid OR OLD.plugin_system IS DISTINCT FROM NEW.plugin_system OR
       OLD.source IS DISTINCT FROM NEW.source OR OLD.raw_payload IS DISTINCT FROM NEW.raw_payload
    THEN RAISE EXCEPTION 'Treasury posting identity is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rental_financial_identity_immutable ON rentals;
CREATE TRIGGER rental_financial_identity_immutable BEFORE UPDATE ON rentals FOR EACH ROW EXECUTE FUNCTION prevent_financial_identity_mutation();
DROP TRIGGER IF EXISTS monetary_operation_identity_immutable ON monetary_operations;
CREATE TRIGGER monetary_operation_identity_immutable BEFORE UPDATE ON monetary_operations FOR EACH ROW EXECUTE FUNCTION prevent_financial_identity_mutation();
DROP TRIGGER IF EXISTS treasury_posting_identity_immutable ON treasury_postings;
CREATE TRIGGER treasury_posting_identity_immutable BEFORE UPDATE ON treasury_postings FOR EACH ROW EXECUTE FUNCTION prevent_financial_identity_mutation();

CREATE OR REPLACE FUNCTION audit_financial_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events(actor_type,event_type,entity_type,entity_id,before_data,after_data)
  VALUES('SYSTEM',upper(TG_TABLE_NAME)||'_'||TG_OP,upper(TG_TABLE_NAME),
    CASE WHEN TG_OP='INSERT' THEN NEW.id::text ELSE OLD.id::text END,
    CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP='DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS rentals_audit ON rentals;
CREATE TRIGGER rentals_audit AFTER INSERT OR UPDATE ON rentals FOR EACH ROW EXECUTE FUNCTION audit_financial_row();
DROP TRIGGER IF EXISTS refunds_audit ON refunds;
CREATE TRIGGER refunds_audit AFTER INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION audit_financial_row();
DROP TRIGGER IF EXISTS shareholder_debts_audit ON shareholder_debts;
CREATE TRIGGER shareholder_debts_audit AFTER INSERT OR UPDATE ON shareholder_debts FOR EACH ROW EXECUTE FUNCTION audit_financial_row();
DROP TRIGGER IF EXISTS monetary_operations_audit ON monetary_operations;
CREATE TRIGGER monetary_operations_audit AFTER INSERT OR UPDATE ON monetary_operations FOR EACH ROW EXECUTE FUNCTION audit_financial_row();
DROP TRIGGER IF EXISTS leasehold_charges_audit ON leasehold_charges;
CREATE TRIGGER leasehold_charges_audit AFTER INSERT OR UPDATE ON leasehold_charges FOR EACH ROW EXECUTE FUNCTION audit_financial_row();

CREATE OR REPLACE FUNCTION prevent_financial_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial records are append-only; use status transitions or reversals'; END $$;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['webhook_deliveries','treasury_postings','rentals','rental_allocations','refunds','shareholder_debts','monetary_operations','ledger_transactions','ledger_entries','debt_recoveries','leasehold_charges']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS financial_no_delete ON %I',table_name);
    EXECUTE format('CREATE TRIGGER financial_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_financial_delete()',table_name);
  END LOOP;
END $$;

INSERT INTO schema_migrations(version) VALUES ('004_finance_hardening') ON CONFLICT DO NOTHING;
COMMIT;
