-- get-fit schema. The first block is the Python app's schema verbatim: the new
-- server must be able to open an existing getfit.db without touching it.
-- Everything after "rewrite additions" is new and additive.

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  response_minutes INTEGER NOT NULL,
  quiet_start TEXT NOT NULL,
  quiet_end TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  min_reps INTEGER NOT NULL,
  max_reps INTEGER,
  position INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  form_url TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_key TEXT NOT NULL UNIQUE,
  sent_at TEXT NOT NULL,
  sent_local_date TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  resolved_at TEXT,
  status TEXT NOT NULL,
  bonus_applied INTEGER NOT NULL DEFAULT 0,
  target_reps INTEGER NOT NULL DEFAULT 0,
  source TEXT
);

CREATE TABLE IF NOT EXISTS round_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  exercise_slug TEXT NOT NULL,
  exercise_name TEXT NOT NULL,
  reps INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS opening_balance (
  exercise_slug TEXT PRIMARY KEY,
  exercise_name TEXT NOT NULL,
  reps INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bonus INTEGER NOT NULL DEFAULT 0,
  next_set_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rounds_date ON rounds(sent_local_date);
CREATE INDEX IF NOT EXISTS idx_items_round ON round_items(round_id);

CREATE TABLE IF NOT EXISTS muscles (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS profile (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  prior REAL NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS muscle_state (
  muscle_slug TEXT PRIMARY KEY REFERENCES muscles(slug),
  wear REAL NOT NULL DEFAULT 0,
  soreness REAL NOT NULL DEFAULT 0,
  stop_at REAL NOT NULL DEFAULT 80,
  resume_at REAL NOT NULL DEFAULT 35,
  rest_until TEXT,
  last_loaded_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exercise_muscles (
  exercise_slug TEXT NOT NULL,
  muscle_slug TEXT NOT NULL REFERENCES muscles(slug),
  role TEXT NOT NULL,
  weight REAL NOT NULL,
  k REAL NOT NULL,
  exposure INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (exercise_slug, muscle_slug)
);

CREATE TABLE IF NOT EXISTS wear_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_key TEXT NOT NULL,
  exercise_slug TEXT NOT NULL,
  muscle_slug TEXT NOT NULL,
  reps INTEGER NOT NULL,
  predicted REAL NOT NULL,
  observed REAL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  local_date TEXT,
  round_key TEXT,
  sleep INTEGER, stress INTEGER, fatigue INTEGER, soreness INTEGER,
  prs INTEGER,
  pain INTEGER NOT NULL DEFAULT 0, pain_where TEXT,
  srpe INTEGER, rir INTEGER, stopper TEXT,
  per_muscle TEXT,
  readiness REAL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_checkins_at ON checkins(at);

CREATE TABLE IF NOT EXISTS profile_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  previous REAL,
  n INTEGER NOT NULL,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_history_at ON profile_history(at);
CREATE INDEX IF NOT EXISTS idx_wear_at ON wear_events(at);
CREATE INDEX IF NOT EXISTS idx_wear_round ON wear_events(round_key);
CREATE INDEX IF NOT EXISTS idx_em_ex ON exercise_muscles(exercise_slug);

-- ---------------------------------------------------------------- rewrite additions

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL,
  name TEXT NOT NULL
);

-- per-device bearer tokens for the native clients; the raw token is never stored
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT,
  push_token TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE (platform, push_token)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  event TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  detail TEXT,
  at TEXT NOT NULL
);

-- a key replayed within 24 h returns the stored response instead of mutating twice
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  token_id TEXT,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  response TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_at ON notification_log(at);
