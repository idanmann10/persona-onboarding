CREATE TABLE IF NOT EXISTS persona_sessions (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS persona_events (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, event_id)
);
CREATE INDEX IF NOT EXISTS persona_events_session_seq ON persona_events (session_id, seq);

CREATE TABLE IF NOT EXISTS persona_graph_facts (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_value TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (evidence IN ('tentative', 'confirmed', 'declined', 'superseded')),
  provenance TEXT NOT NULL CHECK (provenance IN ('user_said', 'tool_observed', 'assistant_inferred', 'user_confirmed')),
  source_url TEXT,
  source_event_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE persona_graph_facts ADD COLUMN IF NOT EXISTS event_id TEXT;
CREATE INDEX IF NOT EXISTS persona_graph_facts_session ON persona_graph_facts (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS persona_graph_facts_event ON persona_graph_facts (session_id, event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS persona_action_confirmations (
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, action_id)
);

CREATE TABLE IF NOT EXISTS persona_connections (
  attempt_id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  toolkit TEXT NOT NULL CONSTRAINT persona_connections_toolkit_slug CHECK (toolkit ~ '^[a-z0-9_]{1,60}$'),
  connected_account_id TEXT NOT NULL UNIQUE,
  auth_config_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'superseded')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS persona_connections_one_active ON persona_connections (session_id, toolkit) WHERE status = 'active';
-- The hash of the per-attempt callback key (see lib/integrations/connections.ts).
ALTER TABLE persona_connections ADD COLUMN IF NOT EXISTS callback_hash TEXT;
-- Any Composio toolkit can be connected now, not only Gmail and Calendar: swap the old list check for a slug check.
ALTER TABLE persona_connections DROP CONSTRAINT IF EXISTS persona_connections_toolkit_check;
DO $$ BEGIN
  ALTER TABLE persona_connections ADD CONSTRAINT persona_connections_toolkit_slug CHECK (toolkit ~ '^[a-z0-9_]{1,60}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- One Composio-managed auth config per toolkit other than Gmail and Calendar, created on first connect.
CREATE TABLE IF NOT EXISTS persona_auth_configs (
  toolkit TEXT PRIMARY KEY CHECK (toolkit ~ '^[a-z0-9_]{1,60}$'),
  auth_config_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS persona_call_leases (
  session_id UUID PRIMARY KEY REFERENCES persona_sessions(id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL,
  call_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_rate_limits (
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (session_id, scope, window_start)
);

CREATE TABLE IF NOT EXISTS persona_identity_reservations (
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  user_event_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_event_id)
);

CREATE TABLE IF NOT EXISTS persona_reservations (
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  reservation_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, reservation_key)
);

CREATE TABLE IF NOT EXISTS persona_ip_limits (
  client_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (client_key, scope, window_start)
);

CREATE TABLE IF NOT EXISTS persona_automations (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  toolkits TEXT[] NOT NULL DEFAULT '{}',
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekdays', 'weekly')),
  weekday SMALLINT CHECK (weekday BETWEEN 0 AND 6),
  local_time TEXT NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'declined', 'disabled')),
  next_run_at TIMESTAMPTZ,
  claimed_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS persona_automations_one_active ON persona_automations (session_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS persona_automations_due ON persona_automations (next_run_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS persona_automation_runs (
  id UUID PRIMARY KEY,
  automation_id UUID NOT NULL REFERENCES persona_automations(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'run_now')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  message_event_id TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (automation_id, scheduled_for, trigger)
);

CREATE TABLE IF NOT EXISTS persona_traces (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'step', 'call', 'voice_tool')),
  name TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER,
  status TEXT CHECK (status IN ('running', 'ok', 'error', 'timeout')),
  data JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS persona_traces_session ON persona_traces (session_id, id);

-- One person, one main session: the verified Gmail address (lowercased) of whoever connected Gmail first.
-- Deleting the main session ("Start over") deletes the row, so the address can start fresh.
CREATE TABLE IF NOT EXISTS persona_users (
  email TEXT PRIMARY KEY CHECK (email = lower(email)),
  main_session_id UUID NOT NULL UNIQUE REFERENCES persona_sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
