-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Milestone 1: users, passkey auth, sessions, invites, device links, lists.
-- IDs are ULIDs (TEXT). Datetimes are ISO 8601 UTC strings
-- ('2026-10-15T09:22:00.000Z'), which sort and compare correctly as text.
-- Migrations are additive only: they run before every deploy.

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  -- Random WebAuthn user handle (base64url), never the ULID: the handle is
  -- stored on authenticators and must not reveal anything.
  webauthn_handle  TEXT NOT NULL UNIQUE,
  created_at       TEXT NOT NULL,
  disabled_at      TEXT,
  -- Account deletion (§7): set when requested, hard delete 30 days later.
  deleted_at       TEXT
);

-- Per-user settings, key/value (JSON values). Defaults live in code
-- (src/core/settings.ts); only overrides are stored.
CREATE TABLE user_settings (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Instance settings changed at runtime by an admin (override env vars).
CREATE TABLE instance_settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,           -- credential ID, base64url
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE sessions (
  id_hash        TEXT PRIMARY KEY,          -- SHA-256 of the cookie token
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The passkey that created the session ("That wasn't me" revokes both).
  passkey_id     TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  -- Last passkey assertion; sensitive actions need it to be recent.
  reauth_at      TEXT,
  user_agent     TEXT NOT NULL DEFAULT '',
  -- A recovery-code session may only register a new passkey.
  must_register  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Recovery codes: `lookup` is a short public prefix of the code so a login
-- needs one PBKDF2 run, not one per stored code.
CREATE TABLE recovery_codes (
  lookup     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salt       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

-- WebAuthn challenges: single use, short-lived. `data` carries ceremony
-- context (e.g. the pending signup's name and invite).
CREATE TABLE auth_challenges (
  challenge   TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  user_id     TEXT,
  data        TEXT,
  expires_at  TEXT NOT NULL
);

-- Instance invites (§2.2): single use.
CREATE TABLE invites (
  id          TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  -- Plain TEXT (no FK): it is written in the same batch, before the user
  -- row exists, to claim the invite atomically.
  used_by     TEXT
);

-- Device links (§2.1): add a passkey on another device.
CREATE TABLE device_links (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash         TEXT NOT NULL UNIQUE,
  -- Short code: the first 3 characters are a public lookup prefix, the rest
  -- is checked against code_hash. Failed attempts count per link.
  code_prefix        TEXT NOT NULL,
  code_hash          TEXT NOT NULL,
  failed_attempts    INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  consumed_at        TEXT,
  revoked_at         TEXT,
  require_approval   INTEGER NOT NULL DEFAULT 0,
  -- Set when a new device claims the link: the claim token (hashed), the
  -- number it shows, and the approval by the originating device.
  claim_hash         TEXT,
  approval_number    INTEGER,
  approval_choices   TEXT,                  -- JSON: the number plus two decoys
  approved_at        TEXT,
  claim_user_agent   TEXT
);
CREATE INDEX device_links_user ON device_links(user_id);
CREATE INDEX device_links_prefix ON device_links(code_prefix);

-- In-app notices shown to a user until dismissed (e.g. "new passkey added").
CREATE TABLE notices (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  data          TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  dismissed_at  TEXT
);
CREATE INDEX notices_user ON notices(user_id, dismissed_at);

-- Fixed-window rate limit counters (Cloudflare adapter; the self-hosted
-- server keeps them in memory).
CREATE TABLE rate_limits (
  key           TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- Lists (§3.1).
CREATE TABLE lists (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  created_by              TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  -- Soft delete: purged 30 days later.
  deleted_at              TEXT,
  -- Per-list override of ANON_COUNT_MIN_MEMBERS (owner only, minimum 3).
  anon_count_min_members  INTEGER
);

CREATE TABLE list_members (
  list_id                 TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                    TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  include_in_suggestions  INTEGER NOT NULL DEFAULT 1,
  -- Remembered visibility for the Done dialog (§3.3).
  log_visibility          TEXT NOT NULL DEFAULT 'private'
                          CHECK (log_visibility IN ('private', 'anonymous', 'shared')),
  joined_at               TEXT NOT NULL,
  PRIMARY KEY (list_id, user_id)
);
CREATE INDEX list_members_user ON list_members(user_id);
-- Exactly one owner per list.
CREATE UNIQUE INDEX list_members_one_owner ON list_members(list_id) WHERE role = 'owner';

-- Append-only change log (§3.4): drives sync and shared-list notifications.
-- `visible_to` limits a row to one user (e.g. a private log entry); NULL =
-- every member of `list_id`. `actor` is a user ID or an OAuth client ID.
CREATE TABLE changes (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  list_id     TEXT,
  op          TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  at          TEXT NOT NULL,
  actor       TEXT,
  actor_kind  TEXT NOT NULL DEFAULT 'user',
  visible_to  TEXT
);
CREATE INDEX changes_list ON changes(list_id, seq);
CREATE INDEX changes_visible ON changes(visible_to, seq);

-- Web Push subscriptions (§5): one per device.
CREATE TABLE push_subscriptions (
  endpoint    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL,
  last_ok_at  TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
