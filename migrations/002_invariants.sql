BEGIN;

CREATE OR REPLACE FUNCTION enforce_ownership_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id bigint;
BEGIN
  target_id := COALESCE(NEW.ownership_version_id, OLD.ownership_version_id);
  IF EXISTS (SELECT 1 FROM ownership_versions WHERE id=target_id)
     AND NOT ownership_total_is_10000(target_id) THEN
    RAISE EXCEPTION 'Ownership version % must total exactly 10000 basis points', target_id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS ownership_total_10000 ON ownership_allocations;
CREATE CONSTRAINT TRIGGER ownership_total_10000
AFTER INSERT OR UPDATE OR DELETE ON ownership_allocations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_ownership_total();

CREATE OR REPLACE FUNCTION prevent_ownership_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Ownership snapshots are immutable; create a new version'; END $$;

DROP TRIGGER IF EXISTS ownership_versions_immutable ON ownership_versions;
CREATE TRIGGER ownership_versions_immutable BEFORE UPDATE OR DELETE ON ownership_versions
FOR EACH ROW EXECUTE FUNCTION prevent_ownership_mutation();

DROP TRIGGER IF EXISTS ownership_allocations_immutable ON ownership_allocations;
CREATE TRIGGER ownership_allocations_immutable BEFORE UPDATE OR DELETE ON ownership_allocations
FOR EACH ROW EXECUTE FUNCTION prevent_ownership_mutation();

CREATE OR REPLACE FUNCTION enforce_operation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status='PENDING' AND NEW.status IN ('CLAIMED','SHADOW','CANCELLED')) OR
    (OLD.status='SHADOW' AND NEW.status IN ('PENDING','CANCELLED')) OR
    (OLD.status='CLAIMED' AND NEW.status IN ('SUBMITTED','SETTLED','FAILED','UNKNOWN')) OR
    (OLD.status='SUBMITTED' AND NEW.status IN ('SETTLED','FAILED','UNKNOWN')) OR
    (OLD.status IN ('FAILED','UNKNOWN') AND NEW.status IN ('PENDING','CLAIMED','CANCELLED'))
  ) THEN RAISE EXCEPTION 'Invalid monetary operation transition % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status='SETTLED' THEN RAISE EXCEPTION 'Settled operations are immutable'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS monetary_operation_transitions ON monetary_operations;
CREATE TRIGGER monetary_operation_transitions BEFORE UPDATE OF status ON monetary_operations
FOR EACH ROW EXECUTE FUNCTION enforce_operation_transition();

INSERT INTO schema_migrations(version) VALUES ('002_invariants') ON CONFLICT DO NOTHING;
COMMIT;
