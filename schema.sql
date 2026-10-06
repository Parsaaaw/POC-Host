-- D1 schema for poc-host (Cloudflare Workers port).
-- Replaces the Railway version's "./data" disk files + ".meta.json" sidecar
-- with a single table: file content + tag/raw metadata live together.
--
-- Multi-tags are stored in the existing `tag` TEXT column as a JSON array
-- string. This deliberately avoids requiring a schema migration for existing
-- deployments. Legacy plain-text tag values are still accepted by the Worker.

CREATE TABLE IF NOT EXISTS files (
  name     TEXT PRIMARY KEY,   -- full name as served, e.g. "poc.js" or "poc" (no ext)
  ext      TEXT,               -- extension without the dot, may be ''
  content  TEXT NOT NULL,
  tag      TEXT,               -- JSON array string for tags; NULL = untagged
  raw      INTEGER NOT NULL DEFAULT 0,  -- 0/1, same meaning as original "raw-only"
  size     INTEGER NOT NULL,   -- byte length of content, cached for the list view
  modified INTEGER NOT NULL,   -- unix ms, same role as the original mtime
  response_status INTEGER NOT NULL DEFAULT 200,
  response_headers TEXT,
  redirect_url TEXT,
  delay_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_files_tag ON files(tag);


-- Public callback catcher. Each hit to /<CALLBACK_PATH>/<id> becomes one row.
-- location_hash is populated only when the client explicitly sends a hash value
-- (URL fragments are never transmitted as part of an HTTP request).
CREATE TABLE IF NOT EXISTS callback_requests (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL,
  method           TEXT NOT NULL,
  url              TEXT NOT NULL,
  path             TEXT NOT NULL,
  query            TEXT,
  headers          TEXT,
  body             TEXT,
  body_truncated   INTEGER NOT NULL DEFAULT 0,
  headers_truncated INTEGER NOT NULL DEFAULT 0,
  ip               TEXT,
  referer          TEXT,
  user_agent       TEXT,
  location_hash    TEXT,
  received         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_callback_requests_id_received
  ON callback_requests(id, received DESC);
CREATE INDEX IF NOT EXISTS idx_callback_requests_received
  ON callback_requests(received DESC);
