-- Per-file response behavior.
-- Existing files keep the normal 200 response with no custom headers/redirect/delay.
ALTER TABLE files ADD COLUMN response_status INTEGER NOT NULL DEFAULT 200;
ALTER TABLE files ADD COLUMN response_headers TEXT;
ALTER TABLE files ADD COLUMN redirect_url TEXT;
ALTER TABLE files ADD COLUMN delay_ms INTEGER NOT NULL DEFAULT 0;
