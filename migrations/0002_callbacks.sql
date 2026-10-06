-- Callback catcher migration for existing D1 deployments.
CREATE TABLE IF NOT EXISTS callback_requests (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL,
  method            TEXT NOT NULL,
  url               TEXT NOT NULL,
  path              TEXT NOT NULL,
  query             TEXT,
  headers           TEXT,
  body              TEXT,
  body_truncated    INTEGER NOT NULL DEFAULT 0,
  headers_truncated INTEGER NOT NULL DEFAULT 0,
  ip                TEXT,
  referer           TEXT,
  user_agent        TEXT,
  location_hash     TEXT,
  received          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_callback_requests_id_received
  ON callback_requests(id, received DESC);

CREATE INDEX IF NOT EXISTS idx_callback_requests_received
  ON callback_requests(received DESC);
