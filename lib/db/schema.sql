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
  toolkit TEXT NOT NULL CHECK (toolkit IN ('gmail', 'calendar')),
  connected_account_id TEXT NOT NULL UNIQUE,
  auth_config_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'superseded')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS persona_connections_one_active ON persona_connections (session_id, toolkit) WHERE status = 'active';

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
