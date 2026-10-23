-- One factory (a machine) serves many repos (#214): the repos a factory has synced, so the dashboard's repo list and tenant receipt scope no longer depend on whichever repo synced last. factories.repo stays as "the repo of the latest batch".
CREATE TABLE factory_repos (factory_id TEXT NOT NULL, repo TEXT NOT NULL, tenant TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (factory_id, repo));
CREATE INDEX idx_factory_repos_tenant ON factory_repos (tenant, repo);
INSERT OR IGNORE INTO factory_repos (factory_id, repo, tenant, last_seen_at) SELECT factory_id, repo, tenant, last_seen_at FROM factories;
INSERT OR IGNORE INTO factory_repos (factory_id, repo, tenant, last_seen_at) SELECT factory_id, repo, tenant, MAX(synced_at) FROM sessions GROUP BY factory_id, repo, tenant;
