-- Public schema only. No records, credentials, signing keys or recovery notes.
-- Matches lib/db/src/schema/relay.ts from the application workspace.
-- This bootstrap is for a fresh standalone database, not a destructive reset.
BEGIN;
CREATE TABLE IF NOT EXISTS hushfund_relay_submissions (
  id uuid PRIMARY KEY,
  scope text NOT NULL,
  payer_key text NOT NULL,
  day text NOT NULL,
  reserved_cost numeric(78, 0) NOT NULL,
  actual_cost numeric(78, 0),
  sponsored boolean NOT NULL,
  request_key text,
  call_hash text,
  status text NOT NULL,
  nonce bigint,
  tx_hash text,
  signed_tx text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hushfund_relay_daily_idx
  ON hushfund_relay_submissions (scope, day);
CREATE UNIQUE INDEX IF NOT EXISTS hushfund_relay_nonce_idx
  ON hushfund_relay_submissions (scope, nonce);
CREATE UNIQUE INDEX IF NOT EXISTS hushfund_relay_request_idx
  ON hushfund_relay_submissions (scope, request_key);
CREATE INDEX IF NOT EXISTS hushfund_relay_pending_idx
  ON hushfund_relay_submissions (scope, status);
COMMIT;
