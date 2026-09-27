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
CREATE INDEX IF NOT EXISTS persona_graph_facts_session ON persona_graph_facts (session_id);

CREATE TABLE IF NOT EXISTS persona_action_confirmations (
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  preview_hash TEXT NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, action_id)
);
