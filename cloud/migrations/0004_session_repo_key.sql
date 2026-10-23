-- Key synced sessions and every child row by (factory_id, repo, adw_id) (#218). One factory (a machine) serves many repos, and phase_id, gate local_id and adw_id can repeat across them.
-- D1/SQLite cannot ALTER a primary key, so each table is rebuilt: create <t>_new, copy every row (rowid kept), drop <t>, rename. The new key is a superset of the old one, so plain INSERT cannot conflict.
-- repo is backfilled from the owning session. Orphans and rows with a NULL adw_id have no session to ask, so they take factories.repo (the repo of the factory's LATEST batch, an approximation that is wrong for a factory serving several repos) and then ''. The real client always selects child rows by adw_id and never writes a NULL one, so on a live database this fallback is expected to match nothing; such rows are invisible to the reader either way.
-- Not rollback-safe for the previous Worker (its child INSERTs omit repo, and its ON CONFLICT targets are gone): deploy the new Worker right after applying, and take a D1 Time Travel bookmark first. Child tables copy before sessions is dropped.
CREATE TABLE sessions_new (factory_id TEXT NOT NULL, repo TEXT NOT NULL, adw_id TEXT NOT NULL, tenant TEXT NOT NULL, adw_name TEXT, request TEXT, status TEXT, engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens REAL, total_cost REAL, billable_tokens REAL, level TEXT, synced_at TEXT NOT NULL, pruned_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, repo, adw_id));
CREATE TABLE phases_new (factory_id TEXT NOT NULL, repo TEXT NOT NULL, phase_id TEXT NOT NULL, adw_id TEXT, seq REAL, name TEXT, kind TEXT, owner TEXT, description TEXT, status TEXT, attempt REAL, retries REAL, error TEXT, started_at TEXT, ended_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, repo, phase_id));
CREATE TABLE agent_sessions_new (factory_id TEXT NOT NULL, repo TEXT NOT NULL, adw_id TEXT NOT NULL, agent TEXT NOT NULL, coding_agent TEXT, model TEXT, color TEXT, session_id TEXT, context_tokens REAL, context_window REAL, created_at TEXT, last_used_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, repo, adw_id, agent));
CREATE TABLE envelopes_new (factory_id TEXT NOT NULL, repo TEXT NOT NULL, envelope_id TEXT NOT NULL, adw_id TEXT, phase_id TEXT, agent TEXT, output_type TEXT, payload_json TEXT, valid REAL, attempt REAL, created_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, repo, envelope_id));
CREATE TABLE events_new (factory_id TEXT NOT NULL, repo TEXT NOT NULL, event_id TEXT NOT NULL, local_rowid INTEGER NOT NULL, adw_id TEXT, phase_id TEXT, parent_id TEXT, type TEXT, name TEXT, payload_json TEXT, tokens REAL, started_at TEXT, ended_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, repo, event_id));
CREATE TABLE gate_results_new (factory_id TEXT NOT NULL, repo TEXT NOT NULL, local_id INTEGER NOT NULL, adw_id TEXT, phase_id TEXT, attempt REAL, gate TEXT, passed REAL, violations_json TEXT, checks_json TEXT, created_at TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, repo, local_id));
CREATE TABLE prompts_new (factory_id TEXT NOT NULL, repo TEXT NOT NULL, adw_id TEXT NOT NULL, agent TEXT NOT NULL, system TEXT, user TEXT, src_sent_at TEXT, PRIMARY KEY (factory_id, repo, adw_id, agent));
CREATE TABLE reviews_new (tenant TEXT NOT NULL, factory_id TEXT NOT NULL, repo TEXT NOT NULL, adw_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, archived_by TEXT, archived_at TEXT, PRIMARY KEY (tenant, factory_id, repo, adw_id));
INSERT INTO sessions_new (rowid, factory_id, repo, adw_id, tenant, adw_name, request, status, engineer, started_at, ended_at, total_tokens, total_cost, billable_tokens, level, synced_at, pruned_at, src_sent_at) SELECT rowid, factory_id, repo, adw_id, tenant, adw_name, request, status, engineer, started_at, ended_at, total_tokens, total_cost, billable_tokens, level, synced_at, pruned_at, src_sent_at FROM sessions;
INSERT INTO phases_new (rowid, factory_id, repo, phase_id, adw_id, seq, name, kind, owner, description, status, attempt, retries, error, started_at, ended_at, src_sent_at) SELECT c.rowid, c.factory_id, COALESCE(s.repo, f.repo, ''), c.phase_id, c.adw_id, c.seq, c.name, c.kind, c.owner, c.description, c.status, c.attempt, c.retries, c.error, c.started_at, c.ended_at, c.src_sent_at FROM phases c LEFT JOIN sessions s ON s.factory_id = c.factory_id AND s.adw_id = c.adw_id LEFT JOIN factories f ON f.factory_id = c.factory_id;
INSERT INTO agent_sessions_new (rowid, factory_id, repo, adw_id, agent, coding_agent, model, color, session_id, context_tokens, context_window, created_at, last_used_at, src_sent_at) SELECT c.rowid, c.factory_id, COALESCE(s.repo, f.repo, ''), c.adw_id, c.agent, c.coding_agent, c.model, c.color, c.session_id, c.context_tokens, c.context_window, c.created_at, c.last_used_at, c.src_sent_at FROM agent_sessions c LEFT JOIN sessions s ON s.factory_id = c.factory_id AND s.adw_id = c.adw_id LEFT JOIN factories f ON f.factory_id = c.factory_id;
INSERT INTO envelopes_new (rowid, factory_id, repo, envelope_id, adw_id, phase_id, agent, output_type, payload_json, valid, attempt, created_at, src_sent_at) SELECT c.rowid, c.factory_id, COALESCE(s.repo, f.repo, ''), c.envelope_id, c.adw_id, c.phase_id, c.agent, c.output_type, c.payload_json, c.valid, c.attempt, c.created_at, c.src_sent_at FROM envelopes c LEFT JOIN sessions s ON s.factory_id = c.factory_id AND s.adw_id = c.adw_id LEFT JOIN factories f ON f.factory_id = c.factory_id;
INSERT INTO events_new (rowid, factory_id, repo, event_id, local_rowid, adw_id, phase_id, parent_id, type, name, payload_json, tokens, started_at, ended_at, src_sent_at) SELECT c.rowid, c.factory_id, COALESCE(s.repo, f.repo, ''), c.event_id, c.local_rowid, c.adw_id, c.phase_id, c.parent_id, c.type, c.name, c.payload_json, c.tokens, c.started_at, c.ended_at, c.src_sent_at FROM events c LEFT JOIN sessions s ON s.factory_id = c.factory_id AND s.adw_id = c.adw_id LEFT JOIN factories f ON f.factory_id = c.factory_id;
INSERT INTO gate_results_new (rowid, factory_id, repo, local_id, adw_id, phase_id, attempt, gate, passed, violations_json, checks_json, created_at, src_sent_at) SELECT c.rowid, c.factory_id, COALESCE(s.repo, f.repo, ''), c.local_id, c.adw_id, c.phase_id, c.attempt, c.gate, c.passed, c.violations_json, c.checks_json, c.created_at, c.src_sent_at FROM gate_results c LEFT JOIN sessions s ON s.factory_id = c.factory_id AND s.adw_id = c.adw_id LEFT JOIN factories f ON f.factory_id = c.factory_id;
INSERT INTO prompts_new (rowid, factory_id, repo, adw_id, agent, system, user, src_sent_at) SELECT c.rowid, c.factory_id, COALESCE(s.repo, f.repo, ''), c.adw_id, c.agent, c.system, c.user, c.src_sent_at FROM prompts c LEFT JOIN sessions s ON s.factory_id = c.factory_id AND s.adw_id = c.adw_id LEFT JOIN factories f ON f.factory_id = c.factory_id;
INSERT INTO reviews_new (rowid, tenant, factory_id, repo, adw_id, archived, archived_by, archived_at) SELECT c.rowid, c.tenant, c.factory_id, COALESCE(s.repo, f.repo, ''), c.adw_id, c.archived, c.archived_by, c.archived_at FROM reviews c LEFT JOIN sessions s ON s.tenant = c.tenant AND s.factory_id = c.factory_id AND s.adw_id = c.adw_id LEFT JOIN factories f ON f.factory_id = c.factory_id;
DROP TABLE sessions;
DROP TABLE phases;
DROP TABLE agent_sessions;
DROP TABLE envelopes;
DROP TABLE events;
DROP TABLE gate_results;
DROP TABLE prompts;
DROP TABLE reviews;
ALTER TABLE sessions_new RENAME TO sessions;
ALTER TABLE phases_new RENAME TO phases;
ALTER TABLE agent_sessions_new RENAME TO agent_sessions;
ALTER TABLE envelopes_new RENAME TO envelopes;
ALTER TABLE events_new RENAME TO events;
ALTER TABLE gate_results_new RENAME TO gate_results;
ALTER TABLE prompts_new RENAME TO prompts;
ALTER TABLE reviews_new RENAME TO reviews;
CREATE INDEX idx_sessions_tenant_repo_started ON sessions (tenant, repo, started_at DESC);
CREATE INDEX idx_sessions_tenant_started ON sessions (tenant, started_at DESC);
CREATE INDEX idx_phases_session ON phases (factory_id, repo, adw_id, seq);
CREATE INDEX idx_envelopes_session ON envelopes (factory_id, repo, adw_id);
CREATE INDEX idx_events_session ON events (factory_id, repo, adw_id, local_rowid);
CREATE INDEX idx_events_type ON events (factory_id, repo, adw_id, type, local_rowid);
CREATE INDEX idx_gate_results_session ON gate_results (factory_id, repo, adw_id);
