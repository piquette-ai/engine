# `piquette sync` — push this factory's trace to a hosted hub

Status: client for #135 (design: [hosted-dashboard-sync.md](design/hosted-dashboard-sync.md)). The hub (#136) is the `ingest` module of `piquette cloud` (see [cloud.md](cloud.md)); `--dry-run` and the in-process fake hub in the tests remain how the client is exercised without a live deploy.

`piquette sync` reads the local trace db and pushes changed rows to a hub's `POST /ingest/v1`. It is out of band: its own process, no import from the run path, and it can never block, fail or slow a run or a PR.

## Config

Off unless `.piquette/piquette.config.yaml` has a `sync:` block.

```yaml
sync:
  endpoint: https://piquette-hub.acme.dev   # base URL; the client POSTs {endpoint}/ingest/v1
  level: trace                         # summary | trace | full   (default trace)
  interval_ms: 15000                   # --follow tick (min 1000)
  timeout_ms: 15000                    # per request (1000..60000)
  client_id_env: PIQUETTE_SYNC_CLIENT_ID    # env var NAMES; values are never in config
  client_secret_env: PIQUETTE_SYNC_CLIENT_SECRET
  factory_name: build-box-1            # display only, MACHINE layer only; default: the short hostname
  repo: github.com/acme/api            # optional override (host/owner/name or owner/name)
```

`endpoint` must be `https://` (plain `http://` only for `localhost`, `127.0.0.1`, `[::1]`), with no userinfo and no query string. It is optional only for `--dry-run`.

## Commands

```sh
piquette sync                       one pass (safe from cron or CI)
piquette sync --follow              repeat every interval_ms; back off on failure (x2, cap 300 s)
piquette sync --dry-run             print per-session counts; send nothing; read no credentials
piquette sync --dry-run --out f.ndjson   write the batches that WOULD be sent, one per line
piquette sync --level summary       push at a LOWER tier than configured
```

`--level` can only go at or below `sync.level` — raising the tier is a config change, on purpose. Exit codes: 0 pushed, up to date, or another sync holds the lock; 1 usage or config error; 2 push failed (state untouched, retry freely); 3 the hub rejected this client's `sync_schema` (upgrade piquette).

For cron, `* * * * * cd /path/to/repo && piquette sync` is enough: a second pass while one is running exits 0 immediately (`.piquette/data/sync.lock`). `--follow` is the same loop in one long-lived process.

## Sync on watch (`sync.on_watch`)

With a `sync:` block in the MACHINE layer (`~/.piquette/piquette.config.yaml`, or `--config`), `piquette watch` runs one sync pass in the background after each run it finishes (success, fail or blocked; build, revision and refine runs alike), plus one catch-up pass when watch starts, so runs that finished while the daemon was down still reach the hub. A run's session shows up on the hub within one pass of the run finishing, with no manual `piquette sync`.

```yaml
sync:
  on_watch: false            # machine layer only; default true when a machine-layer sync: block exists
  on_watch_interval_ms: 10000   # optional; also tick a pass on this interval WHILE watch is running (#2)
```

- It is the same `runSyncPass` as the CLI, in-process, with the same `sync.lock` and cursors, so a manual `piquette sync` and an automatic pass never overlap (the loser skips). Requests that arrive while a pass runs coalesce into one trailing pass.
- It is never on a run's path: nothing awaits it, nothing it does can fail, delay or change a run or a PR. A failed pass logs and notifies at `notice` level (`watch_error`); the next finished run retries.
- Machine layer only. A repo's `.piquette/piquette.config.yaml` cannot turn it on (a repo-only `sync:` block does nothing) or off, and `piquette doctor` warns when a repo layer sets `sync.on_watch`. `piquette watch --dry-run` never syncs.
- Credentials are unchanged: read by the pass only, never in agent or gate environments. On shutdown watch waits for an in-flight pass to finish.
- `piquette doctor` shows whether on_watch is on.

**`sync.on_watch_interval_ms` (#2).** By default, a run's progress only reaches the hub when it finishes — nothing pushes while it's still going, unlike local `piquette ui`, which reads the live trace db directly. Setting this adds a plain tick on that interval, in addition to (never instead of) the run-finished and start-catchup triggers above: the same coalescing rules apply, so a tick that lands mid-pass just marks one trailing pass pending, never a second concurrent one. Same trust rule as `on_watch` itself — machine layer only, a repo layer's value is ignored (`piquette doctor` warns). Minimum 1000ms. Unset (the default) is the unchanged, triggers-only behavior from above.

## What leaves the machine (tiers)

| level | sent |
| --- | --- |
| `summary` | sessions (without `request`), phases (without `error`), agent_sessions, usage totals, gate pass/fail with the violated items (never their notes, which quote command output); per-check `{item, ok}` only. No events, envelopes or prompts. |
| `trace` (default) | `summary` plus `request`, envelope metadata (never contents), and events: `payload_json` reduced to the token/cost numbers `core/otel.ts` already allows into spans, `name` kept only for fixed lifecycle event types and a tool call's own tool name (`bash`, not `bash: cat ...`). Free-text event types (`log`, `feedback`, anything unknown) lose their name. |
| `full` | everything in the db, plus prompt files from `sessions_dir`. Any single field over 256 KiB becomes `{"_piquette_truncated": <bytes>}`. `piquette doctor` warns when this is on. |

Rows are built field by field from an allowlist, so a column or payload key nobody anticipated can only fail to leave. On top of that, at **every** level (full included), any value of the sync credentials, the D1 API token, or an environment variable named like `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`, `*_KEY` or `*CREDENTIAL*` (8+ characters) is replaced by `[redacted]` in every string, raw and JSON-escaped.

## Credentials (Cloudflare Access service token)

The hub sits behind Cloudflare Access. Create a service token, add it to an Access policy for the hub, and export:

```sh
export PIQUETTE_SYNC_CLIENT_ID=<id>.access
export PIQUETTE_SYNC_CLIENT_SECRET=<secret>
```

They are sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret` and are read from the environment at sync time only. They are never written to config, to the payload, or to a log, and piquette strips them (and any custom `client_*_env` names) from the environment of every agent, gate, quality check, receipt journey, recorded terminal and git commit hook (#33) — even an agent whose `env_allowlist` names them. Redirects are never followed (a 3xx/401/403 reads "Cloudflare Access rejected the service token"), so the secret header cannot travel to another host. The factory never holds `CLOUDFLARE_API_TOKEN` for sync.

## Identity

- **Factory**: one MACHINE (a laptop, or a build box serving many repos). Its id is a random UUID minted once into `factory.json` in the machine config home (`$PIQUETTE_CONFIG_HOME`, default `~/.piquette`), so every repo, checkout and worktree on the machine shares it and repos are listed under the one factory (the hub keeps a `factory_repos` row per repo a factory has synced). If that file is corrupt piquette refuses to continue rather than minting a new id (a new id would orphan the factory's history); delete it deliberately to start over.
  - **Migration**: older versions kept a `factory.json` per repo in `{data_dir}`. When the machine has none yet, this checkout's legacy file is adopted as the machine's id (so existing history is kept), but ONLY from the default `{repo_root}/.piquette/data` and ONLY if git does not track it, so a cloned repo can never hand the machine an identity. Other checkouts' files are then ignored. Which checkout syncs first decides the id, so with several checkouts and a credential pinned to one checkout's old id (`provision-factory --factory-id <uuid>`), re-pin with `--factory-id this` after upgrading; `piquette doctor` shows an id that is not yet adopted as such.
  - **Hub clean-up**: the hub keeps the old per-checkout factory rows (and their old names, which may include a username and hostname) and sessions synced under them; factories are never pruned, and a session in flight across the upgrade can appear under both ids. Remove stale rows by hand on the hub (`DELETE FROM factories / factory_repos / sessions WHERE factory_id = ...`); there is no rename or merge command yet.
  - **Engineer**: each session's `engineer` (`ENGINEER_NAME`, else `git config user.name`) is still sent at every level, including `summary`; set `ENGINEER_NAME` to something neutral if that name should not reach the hub.
  - **Name**: `sync.factory_name`, honored only from the machine layer or `--config` (identity is machine-owned; a repo's `.piquette/` cannot set the name or the id, and `piquette doctor` warns when it tries). Unset, it is the short hostname, with no username and no domain suffix such as `.local`; `piquette doctor` hints to set a name.
  - `piquette cloud provision-factory --factory-id this` pins the credential to this machine's shared id.
- **Repo**: a normalized `host/owner/name` slug, so forks and clones collapse into one repo with factories underneath. Order: `sync.repo`, `watch.repo`, the `upstream` remote (how a fork collapses onto its parent), `origin`, then `local/<dir name>`. Remote URLs are never logged — an https remote can carry a token.

## D1-backed repos

A repo whose `observability.db` is `kind: d1` syncs the same payload as local sqlite (D1-to-D1 mirroring, decided 2026-10-22). `piquette sync` reads through the same trace-db abstraction, using the D1 account/token env vars the `observability.db` block names, one short statement at a time (D1's 100-bound-parameter cap is never reached). Prompt files at `full` still come from the local `sessions_dir`. Only ONE factory may sync a given D1 database: `piquette sync` mirrors every session in it under the local `factory_id`, so two machines sharing a database would each push all of it. `--follow` polls a D1 source at most once a minute (Cloudflare's API allows 1200 requests per 5 minutes per user, shared with the tracer), keeps `table_info` across passes, and skips running sessions with no new events or gates.

## Cursors and failure

`{data_dir}/sync-state.json` holds a cursor per session. A cursor advances only after the hub answers 2xx, one atomic write per accepted batch, so a crash replays at most one batch; the hub upserts on `(factory_id, natural key)` and `Idempotency-Key` is the batch's content hash, so a replay is a no-op. Batches are capped at 500 events or ~1 MB. A hub answering `409 {supported: [min, max]}` with a range that excludes this piquette stops syncing until piquette is upgraded; any other 409 (an `Idempotency-Key` conflict, a request in progress) is retried like a 500. A `summary` pass never moves the event high-water mark, so events written meanwhile are still sent by the next `trace`/`full` pass. A config layer that sets its own `endpoint` does not inherit the credential variable names of the layer below. Raising `sync.level` backfills from the start; lowering it resends nothing. `--dry-run --out` keeps its own `sync-state.dry-run.json`, so it can never make a real push skip rows; a plain `--dry-run` reads the real cursors (read-only) and previews what the next push would send.

`piquette doctor` reports the endpoint (origin and path only), tier, resolved repo and factory id, source (sqlite path or D1 database id), which credential variables are set (names only), and — unless `--no-probe` — a `GET /ingest/v1` against the hub. All sync checks are informational or warnings, never failures.

## Payload contract

`src/core/sync/contract.ts` (valibot, no node imports) is what the hub imports. `assets/sync/payload.v1.schema.json` is generated from it — `npm run build:cli && npm run gen:sync-schema` — and a test fails if the two drift.

## Real-Cloudflare end-to-end

`scripts/sync-e2e.sh` (not run in CI) seeds a temp repo through the real Tracer, then runs `piquette sync --dry-run`, `piquette sync`, `piquette sync` again (must send nothing) and `curl`s `GET /ingest/v1` with the Access headers. It sources `~/.config/piquette/cloudflare.env` and needs `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_ALLOWED_EMAIL` (passed through for the hub stage) plus `PIQUETTE_SYNC_ENDPOINT`, `PIQUETTE_SYNC_CLIENT_ID`, `PIQUETTE_SYNC_CLIENT_SECRET`. It never echoes a secret.
