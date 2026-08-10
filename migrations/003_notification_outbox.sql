BEGIN;

CREATE TABLE notification_outbox (
  id bigserial PRIMARY KEY,
  guild_id text,
  dedupe_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1900),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CLAIMED','SENT','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_outbox_pending_idx ON notification_outbox(status,next_attempt_at,created_at);

INSERT INTO schema_migrations(version) VALUES ('003_notification_outbox') ON CONFLICT DO NOTHING;
COMMIT;
