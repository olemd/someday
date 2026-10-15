-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Milestone 2: items, tags, the done log, per-user suggestion state, and
-- idempotency for replayed offline writes (§3, §6).

CREATE TABLE items (
  id                 TEXT PRIMARY KEY,
  list_id            TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,
  notes              TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'idea'
                     CHECK (status IN ('idea', 'planned', 'done', 'archived')),
  repeatable         INTEGER NOT NULL DEFAULT 0,
  duration           TEXT CHECK (duration IN ('short', 'half_day', 'day', 'weekend', 'trip')),
  setting            TEXT CHECK (setting IN ('indoor', 'outdoor', 'either')),
  cost               INTEGER CHECK (cost BETWEEN 0 AND 3),
  energy             TEXT CHECK (energy IN ('low', 'medium', 'high')),
  social             TEXT CHECK (social IN ('solo', 'together', 'either')),
  valid_from         TEXT,                 -- YYYY-MM-DD
  valid_to           TEXT,                 -- YYYY-MM-DD
  months             INTEGER,              -- bit 0 = January … bit 11 = December
  links              TEXT NOT NULL DEFAULT '[]',  -- JSON [{url, label?}]
  location           TEXT,                 -- JSON {label, lat?, lon?}
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  -- Per-field last-modified times (epoch ms) for last-write-wins sync (§6).
  field_clock        TEXT NOT NULL DEFAULT '{}'
  -- Attachments (photos) are out of scope for v1 (§11); they will get their
  -- own table keyed by item_id, so nothing here needs to change.
);
CREATE INDEX items_list ON items(list_id, status);

CREATE TABLE item_tags (
  item_id  TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX item_tags_tag ON item_tags(tag);

-- The done log (§3.3). Per user: logging never changes the item for others
-- on shared lists. `prev_status` lets undo restore what logging changed.
CREATE TABLE item_log (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  done_on      TEXT NOT NULL,              -- YYYY-MM-DD
  note         TEXT NOT NULL DEFAULT '',
  rating       INTEGER CHECK (rating BETWEEN 1 AND 5),
  visibility   TEXT NOT NULL DEFAULT 'private'
               CHECK (visibility IN ('private', 'anonymous', 'shared')),
  prev_status  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX item_log_item ON item_log(item_id, user_id);
CREATE INDEX item_log_user ON item_log(user_id);

-- Per-user suggestion state (§3.2, §4): "not now" and "recently suggested"
-- are personal, also on shared lists.
CREATE TABLE suggestion_state (
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id            TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  snoozed_until      TEXT,
  last_suggested_at  TEXT,
  PRIMARY KEY (user_id, item_id)
);

-- Offline outbox replays are idempotent by op_id (§6).
CREATE TABLE applied_ops (
  op_id       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applied_at  TEXT NOT NULL,
  result      TEXT
);
CREATE INDEX applied_ops_at ON applied_ops(applied_at);
