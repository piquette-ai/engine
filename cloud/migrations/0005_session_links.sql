-- The tracker issue and pull request `spf watch` recorded for a run (a display label plus an http(s) URL each). Additive and nullable: existing rows read NULL, and a factory that does not send them leaves them NULL (ingest COALESCEs, so an older factory never blanks a stored value).
ALTER TABLE sessions ADD COLUMN issue_label TEXT;
ALTER TABLE sessions ADD COLUMN issue_url TEXT;
ALTER TABLE sessions ADD COLUMN pr_label TEXT;
ALTER TABLE sessions ADD COLUMN pr_url TEXT;
