-- Still — database schema (Cloudflare D1)
-- Run this once, in the D1 console, before deploying the Worker.
-- It is safe to re-run: every statement is IF NOT EXISTS or an upsert.

-- One row per person. pw_hash is NULL until the account is claimed, and a person
-- with a NULL pw_hash may claim it by entering their setup_code once.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name       TEXT NOT NULL,
  pw_hash    TEXT,
  setup_code TEXT,
  tz         TEXT,
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Staying signed in. The token itself is never stored, only its SHA-256.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_exp  ON sessions(expires_at);

-- The record. id is generated on the phone, so sending the same sit twice is harmless.
-- day is that person's own local date, which is what keeps streaks honest across timezones.
CREATE TABLE IF NOT EXISTS sits (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  day        TEXT NOT NULL,
  seconds    INTEGER NOT NULL,
  planned    INTEGER NOT NULL,
  complete   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sits_user_day     ON sits(user_id, day);
CREATE INDEX IF NOT EXISTS sits_user_created ON sits(user_id, created_at);

-- Length, bells, voice and lines, carried between a phone and a Mac.
CREATE TABLE IF NOT EXISTS settings (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Slows down guessing at a password. Cleared on a successful sign-in.
CREATE TABLE IF NOT EXISTS throttle (
  key   TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- The three accounts. Each person signs in with their username and the setup
-- code below, once, and chooses their own password at that moment. The code
-- stops working the instant it is used.
--
-- To reset a forgotten password, run this in the D1 console with a new code:
--   UPDATE users SET pw_hash = NULL, setup_code = 'NEW-CODE' WHERE username = 'sandhya';
--   DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = 'sandhya');
-- ---------------------------------------------------------------------------
INSERT INTO users (id, username, name, pw_hash, setup_code, is_admin, created_at) VALUES
  ('6d701770-5f89-487f-be17-88a2d57a82bd', 'adithya',    'Adithya',    NULL, 'M5EK-BQWS', 1, unixepoch() * 1000),
  ('569ab717-e95d-458b-88da-8a2d62b9161f', 'aishwaryya', 'Aishwaryya', NULL, 'PSWR-4CQV', 0, unixepoch() * 1000),
  ('58e0dbef-c1fe-4ca3-8e16-b16493604a84', 'sandhya',    'Sandhya',    NULL, 'FXK7-GZF9', 0, unixepoch() * 1000)
ON CONFLICT(id) DO NOTHING;
