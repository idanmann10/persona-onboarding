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

-- Retired: the main session of a Gmail address under the old Gmail-as-sign-in. Read once, when a Google
-- account with that verified email first signs in, which takes the conversation over and deletes the row.
CREATE TABLE IF NOT EXISTS persona_users (
  email TEXT PRIMARY KEY CHECK (email = lower(email)),
  main_session_id UUID NOT NULL UNIQUE REFERENCES persona_sessions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One account is one user with one main conversation: a Google account (its stable `sub`, email verified
-- by Google) or an email + password account (email unverified, scrypt hash in password_hash). The two
-- kinds never merge by email. The profile columns are what the user or Google last said at sign-in.
-- "Start over" deletes the conversation, which clears main_session_id; the next page load opens a fresh one.
CREATE TABLE IF NOT EXISTS persona_accounts (
  id UUID PRIMARY KEY,
  google_sub TEXT UNIQUE CHECK (length(google_sub) BETWEEN 1 AND 255),
  email TEXT NOT NULL CHECK (email = lower(email)),
  password_hash TEXT,
  full_name TEXT,
  given_name TEXT,
  picture TEXT,
  locale TEXT,
  main_session_id UUID UNIQUE REFERENCES persona_sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_in_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE persona_accounts ALTER COLUMN google_sub DROP NOT NULL;
ALTER TABLE persona_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;
DO $$ BEGIN
  ALTER TABLE persona_accounts ADD CONSTRAINT persona_accounts_one_kind
    CHECK ((google_sub IS NOT NULL AND password_hash IS NULL) OR (google_sub IS NULL AND password_hash IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- One password account per email; Google accounts are found by email only to refuse such a sign-up.
CREATE UNIQUE INDEX IF NOT EXISTS persona_accounts_password_email ON persona_accounts (email) WHERE google_sub IS NULL;
CREATE INDEX IF NOT EXISTS persona_accounts_email ON persona_accounts (email);

-- A signed-in browser: the SHA-256 of the random token in its persona_auth cookie, never the token.
-- Signing out deletes the row.
CREATE TABLE IF NOT EXISTS persona_logins (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id UUID NOT NULL REFERENCES persona_accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS persona_logins_account ON persona_logins (account_id);
CREATE INDEX IF NOT EXISTS persona_logins_expiry ON persona_logins (expires_at);

CREATE TABLE IF NOT EXISTS persona_avatars (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES persona_sessions(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/webp', 'image/png', 'image/jpeg')),
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS persona_avatars_session ON persona_avatars (session_id);
