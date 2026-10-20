-- Users & sessions ----------------------------------------------------------

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,            -- sha256(cookie token)
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Which domains / addresses a member may read. Admins see everything.
CREATE TABLE user_access (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('domain', 'address')),
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, value)
);

CREATE TABLE login_attempts (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Routing -------------------------------------------------------------------

CREATE TABLE domains (
  name       TEXT PRIMARY KEY,
  zone_id    TEXT,
  -- accept_all: every address is accepted (catch-all)
  -- known_only: only addresses already in `addresses` are accepted
  policy     TEXT NOT NULL DEFAULT 'accept_all' CHECK (policy IN ('accept_all', 'known_only')),
  created_at INTEGER NOT NULL
);

CREATE TABLE addresses (
  address          TEXT PRIMARY KEY,      -- lower-cased full address
  domain           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  note             TEXT NOT NULL DEFAULT '',
  created_at       INTEGER NOT NULL,
  last_received_at INTEGER
);
CREATE INDEX addresses_domain ON addresses (domain);

-- Copies forwarded by the Worker (destinations must be verified in Email Routing).
CREATE TABLE forwards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,              -- user@example.com or *@example.com
  destination TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (source, destination)
);

CREATE TABLE blocked_senders (
  pattern    TEXT PRIMARY KEY,            -- user@example.com or @example.com
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Mail ----------------------------------------------------------------------

CREATE TABLE messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_prefix         TEXT NOT NULL,        -- {prefix}/raw.eml, body.json, att/{idx}
  domain            TEXT NOT NULL,
  address           TEXT NOT NULL,        -- envelope recipient
  envelope_from     TEXT NOT NULL,
  from_addr         TEXT NOT NULL DEFAULT '',
  from_name         TEXT NOT NULL DEFAULT '',
  to_json           TEXT NOT NULL DEFAULT '[]',
  cc_json           TEXT NOT NULL DEFAULT '[]',
  reply_to          TEXT NOT NULL DEFAULT '',
  subject           TEXT NOT NULL DEFAULT '',
  snippet           TEXT NOT NULL DEFAULT '',
  message_id_hdr    TEXT,
  sent_at           INTEGER,
  received_at       INTEGER NOT NULL,
  size              INTEGER NOT NULL,
  attachment_count  INTEGER NOT NULL DEFAULT 0,
  folder            TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'archive', 'spam', 'trash')),
  folder_changed_at INTEGER,
  is_read           INTEGER NOT NULL DEFAULT 0,
  is_starred        INTEGER NOT NULL DEFAULT 0,
  spf               TEXT,
  dkim              TEXT,
  dmarc             TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  parse_attempts    INTEGER NOT NULL DEFAULT 0,
  parse_error       TEXT
);
CREATE INDEX messages_folder ON messages (folder, received_at DESC, id DESC);
CREATE INDEX messages_domain ON messages (domain, folder, received_at DESC, id DESC);
CREATE INDEX messages_address ON messages (address, folder, received_at DESC, id DESC);
CREATE INDEX messages_unread ON messages (folder, is_read, address);
CREATE INDEX messages_starred ON messages (received_at DESC, id DESC) WHERE is_starred = 1;
CREATE INDEX messages_pending ON messages (received_at) WHERE status = 'pending';
CREATE INDEX messages_purge ON messages (folder, folder_changed_at);

CREATE TABLE attachments (
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  filename   TEXT NOT NULL DEFAULT '',
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  content_id TEXT,
  inline     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, idx)
);

-- rowid = messages.id. Trigram so CJK substrings (>= 3 chars) are searchable.
CREATE VIRTUAL TABLE messages_fts USING fts5 (subject, sender, recipients, body, tokenize = 'trigram');
