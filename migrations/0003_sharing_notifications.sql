-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Milestone 5: list invites (§3.1) and notifications (§5).

-- List invite links: role chosen at creation, limited uses, expiry.
CREATE TABLE list_invites (
  id          TEXT PRIMARY KEY,
  list_id     TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  uses        INTEGER NOT NULL DEFAULT 0,
  revoked_at  TEXT
);
CREATE INDEX list_invites_list ON list_invites(list_id);

-- When each user's next scheduled notification work is due (UTC), so cron
-- only touches users with something to do. `type`: 'window' (daily 09:00
-- local) or 'nudge_draw' (start of the next nudge period). `last_sent` makes
-- runs idempotent (§5): a restart never double-sends.
CREATE TABLE notif_schedule (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  next_at    TEXT NOT NULL,
  last_sent  TEXT,
  PRIMARY KEY (user_id, type)
);
CREATE INDEX notif_schedule_due ON notif_schedule(next_at);

-- Drawn nudge times (§5.1). Persisted so cron is idempotent and a restart
-- never re-rolls. Never shown to the user.
CREATE TABLE nudge_slots (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start  TEXT NOT NULL,             -- YYYY-MM-DD (local)
  send_at       TEXT NOT NULL,             -- UTC
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'skipped_empty', 'skipped_paused', 'discarded')),
  item_id       TEXT
);
CREATE INDEX nudge_slots_due ON nudge_slots(status, send_at);
CREATE INDEX nudge_slots_user ON nudge_slots(user_id, period_start);

-- Activity by others on shared lists, batched per (recipient, list) (§5).
-- Only ever filled for items added and *shared* log entries.
CREATE TABLE shared_queue (
  id          TEXT PRIMARY KEY,
  recipient   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id     TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('item_added', 'log_shared')),
  item_id     TEXT,
  actor_name  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX shared_queue_recipient ON shared_queue(recipient, list_id);

-- Non-urgent pushes held back during quiet hours, sent when they end.
CREATE TABLE push_deferred (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  not_before  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX push_deferred_due ON push_deferred(not_before);

-- Sent notifications (for per-type caps such as agent notifications per day).
CREATE TABLE notif_log (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type     TEXT NOT NULL,
  sent_at  TEXT NOT NULL
);
CREATE INDEX notif_log_user ON notif_log(user_id, type, sent_at);
