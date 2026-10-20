-- Extracted from the body at parse time: best verification code and the main action links.
ALTER TABLE messages ADD COLUMN verify_code TEXT;
ALTER TABLE messages ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';
-- Set once Bark rules have been evaluated, so retried parses never notify twice.
ALTER TABLE messages ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;
-- Bytes this message occupies in R2 (raw + parsed body + attachments).
ALTER TABLE messages ADD COLUMN r2_bytes INTEGER NOT NULL DEFAULT 0;

UPDATE messages SET notified = 1, r2_bytes = size * 2;
-- Purge queries range over folder_changed_at; make sure it is always set for spam/trash.
UPDATE messages SET folder_changed_at = received_at WHERE folder_changed_at IS NULL AND folder IN ('spam', 'trash');

-- Bark ---------------------------------------------------------------------

CREATE TABLE bark_targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  server       TEXT NOT NULL,                -- https://api.day.app or a self-hosted server
  device_key   TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sent_at INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE notify_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  keywords     TEXT NOT NULL DEFAULT '[]',   -- JSON array; any match triggers, empty = every message
  fields       TEXT NOT NULL DEFAULT '["subject","from","body"]',
  scopes       TEXT NOT NULL DEFAULT '[]',   -- JSON array of domains / addresses; empty = all
  require_code INTEGER NOT NULL DEFAULT 0,
  target_ids   TEXT NOT NULL DEFAULT '[]',   -- JSON array of bark_targets.id
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

-- Usage tracking (keeps the usage page from scanning the messages table) ---

CREATE TABLE counters (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (key, value) SELECT 'messages', COUNT(*) FROM messages;
INSERT INTO counters (key, value) SELECT 'r2_bytes', COALESCE(SUM(r2_bytes), 0) FROM messages;

CREATE TABLE usage_daily (
  day      TEXT PRIMARY KEY,                 -- YYYY-MM-DD (UTC)
  messages INTEGER NOT NULL DEFAULT 0,
  bytes    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
