-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Personal order, "hide for me" and hearts on shared lists.

-- Both are personal like "not now", so they live with it in the per-user,
-- per-item state. `position`: the viewer's own order within a list (lower
-- first; NULL = not placed yet, shown first, newest first). `hidden_at`: the
-- viewer has hidden the idea for themselves; it stays for everyone else.
ALTER TABLE suggestion_state ADD COLUMN position INTEGER;
ALTER TABLE suggestion_state ADD COLUMN hidden_at TEXT;

-- Hearts: "I'd like this too", visible to the members of the list.
CREATE TABLE item_hearts (
  item_id     TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (item_id, user_id)
);
CREATE INDEX item_hearts_user ON item_hearts(user_id);
