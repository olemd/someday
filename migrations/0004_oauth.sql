-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Milestone 7: the app as its own OAuth 2.1 authorization server for MCP (§8.1).

-- Clients: Client ID Metadata Documents (client_id is an HTTPS URL, metadata
-- fetched and cached 24 h) or, when MCP_ALLOW_DCR is on, dynamically registered.
CREATE TABLE oauth_clients (
  client_id      TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('cimd', 'dcr')),
  client_name    TEXT NOT NULL,
  client_uri     TEXT,
  redirect_uris  TEXT NOT NULL,            -- JSON array
  fetched_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- A user's consent for one client: scopes and (optionally) the lists it may touch.
CREATE TABLE oauth_grants (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scopes        TEXT NOT NULL,             -- space-separated
  list_ids      TEXT,                      -- JSON array, NULL = all lists
  resource      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  UNIQUE (user_id, client_id)
);

-- Authorization codes: single use, 10 minutes, PKCE S256.
CREATE TABLE oauth_codes (
  code_hash       TEXT PRIMARY KEY,
  grant_id        TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  used_at         TEXT
);

-- Access (1 h) and refresh (30 days, rotating) tokens, stored hashed. A token
-- family is one code exchange and its refresh chain: reusing a rotated
-- refresh token revokes the whole family.
CREATE TABLE oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  grant_id    TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  family_id   TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  revoked_at  TEXT
);
CREATE INDEX oauth_tokens_family ON oauth_tokens(family_id);
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);

-- For OAuth actors, `changes.actor` is the client ID; this records the user
-- on whose behalf it acted, so history reads "Kari via <client>".
ALTER TABLE changes ADD COLUMN actor_user TEXT;
