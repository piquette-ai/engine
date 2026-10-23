-- spf cloud: ingest/dashboard schema (#214). One statement per ';' at end of line. No triggers.
-- Every synced table carries factory_id and a composite primary key; src_sent_at is the batch's sent_at.
CREATE TABLE factories (factory_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, name TEXT, repo TEXT NOT NULL, spf_version TEXT, sync_schema INTEGER, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE INDEX idx_factories_tenant_repo ON factories (tenant, repo);
CREATE TABLE factory_credentials (common_name TEXT PRIMARY KEY, tenant TEXT NOT NULL, factory_id TEXT, created_at TEXT);
CREATE TABLE reader_grants (tenant TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('email', 'email_domain')), value TEXT NOT NULL, PRIMARY KEY (kind, value, tenant));
CREATE TABLE sessions (factory_id TEXT NOT NULL, adw_id TEXT NOT NULL, tenant TEXT NOT NULL, repo TEXT NOT NULL, adw_name TEXT, request TEXT, status TEXT, engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens REAL, total_cost REAL, billable_tokens REAL, level TEXT, synced_at TEXT NOT NULL, pruned_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, adw_id));
CREATE INDEX idx_sessions_tenant_repo_started ON sessions (tenant, repo, started_at DESC);
CREATE INDEX idx_sessions_tenant_started ON sessions (tenant, started_at DESC);
CREATE TABLE phases (factory_id TEXT NOT NULL, phase_id TEXT NOT NULL, adw_id TEXT, seq REAL, name TEXT, kind TEXT, owner TEXT, description TEXT, status TEXT, attempt REAL, retries REAL, error TEXT, started_at TEXT, ended_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, phase_id));
CREATE INDEX idx_phases_session ON phases (factory_id, adw_id, seq);
CREATE TABLE agent_sessions (factory_id TEXT NOT NULL, adw_id TEXT NOT NULL, agent TEXT NOT NULL, coding_agent TEXT, model TEXT, color TEXT, session_id TEXT, context_tokens REAL, context_window REAL, created_at TEXT, last_used_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, adw_id, agent));
CREATE TABLE envelopes (factory_id TEXT NOT NULL, envelope_id TEXT NOT NULL, adw_id TEXT, phase_id TEXT, agent TEXT, output_type TEXT, payload_json TEXT, valid REAL, attempt REAL, created_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, envelope_id));
CREATE INDEX idx_envelopes_session ON envelopes (factory_id, adw_id);
CREATE TABLE events (factory_id TEXT NOT NULL, event_id TEXT NOT NULL, local_rowid INTEGER NOT NULL, adw_id TEXT, phase_id TEXT, parent_id TEXT, type TEXT, name TEXT, payload_json TEXT, tokens REAL, started_at TEXT, ended_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, event_id));
CREATE INDEX idx_events_session ON events (factory_id, adw_id, local_rowid);
CREATE TABLE gate_results (factory_id TEXT NOT NULL, local_id INTEGER NOT NULL, adw_id TEXT, phase_id TEXT, attempt REAL, gate TEXT, passed REAL, violations_json TEXT, checks_json TEXT, created_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, local_id));
CREATE INDEX idx_gate_results_session ON gate_results (factory_id, adw_id);
CREATE TABLE prompts (factory_id TEXT NOT NULL, adw_id TEXT NOT NULL, agent TEXT NOT NULL, system TEXT, user TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, adw_id, agent));
CREATE TABLE reviews (tenant TEXT NOT NULL, factory_id TEXT NOT NULL, adw_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, archived_by TEXT, archived_at TEXT, PRIMARY KEY (tenant, factory_id, adw_id));
