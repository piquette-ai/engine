# Hosted dashboard sync and multi-factory view

Status: proposal (design note, not yet scheduled)
Date: 2026-10-09
Tracks: Epic "hosted dashboard sync + multi-factory view" (see the PR that adds this file for the issue links)

## 1. Goal

Two requests, one design:

1. **General hosted dashboard sync.** A factory's runs should be visible somewhere other than `spf ui` on the machine that ran them.
2. **One view over many factories, filterable by repo.** Several factories (repos, machines, engineers) should show up in a single dashboard, with a repo filter.

Constraints this note inherits from the codebase and does not reopen:

- The trace db is the source of truth for a run, and nothing downstream of it may affect a phase, a gate, or a run outcome (`src/core/tracer.ts` header). Sync is downstream, so it follows the same rule as the OTel exporter (`src/core/otel.ts`): out of the control path, never throws into a caller, and lossy-tolerant.
- No secrets in agent env (#33). A sync credential is read by deterministic code only (`spf sync`, the `spf watch` daemon) and never by a coding-agent subprocess.
- Reuse the Cloudflare/D1 work (#66, #72, #74, #75) where it fits, and reuse the Vue app in `app/` instead of building a second UI.

## 2. Current state (verified in code)

### What a "factory" is today

There is no factory identity. Today a factory is implicitly **one repo checkout plus its data dir**:

- `paths.resolveAnchor()` finds `repo_root` (git toplevel) and the nearest `.spf/`.
- `paths.resolveDataPaths()` resolves `data_dir` (default `.spf/data`, gitignored), the trace db (`observability.db`, default `.spf/data/spf.db`), and `sessions_dir` (JSONL, envelopes, prompt files, always on local disk).
- Worktrees made by `spf fanout` and `spf watch` symlink `.spf/data` back to the main checkout (`core/worktree_data.ts`), so one checkout's runs, worktrees included, share one db.
- The only "name" the UI has is `project`: `path.basename(repo_root)`, passed by `cli/commands/ui.ts` and surfaced on `/api/health` for the page title.
- `watch.repo` (`owner/name` for GitHub, `workspace/repo_slug` for Bitbucket) is the only real repo slug in config, and it is set only when `spf watch` is configured.
- `sessions.engineer` is `$USER`, a person rather than a machine. The OTel `service.name` defaults to `"spf"`.
- `adw_id` is `newId()`, 8 hex chars (32 bits). It is unique within one db but **not safe as a fleet-wide key**: at about 65k sessions across a fleet, the chance of a collision is about 50%.

### What the dashboard reads, and from where

`spf ui` (`src/ui/server/*`) is a Hono app over `SfDb`, a read-only reader of one trace db:

| Route | Source |
|---|---|
| `GET /api/health` | db label, journal mode, session count, `project` |
| `GET /api/sessions?limit=` | `sessions` + per-session phase rollup |
| `GET /api/sessions/:adw_id` | session, usage, phases, agent_sessions |
| `GET /api/sessions/:adw_id/events?after=&limit=` | `events`, **rowid cursor** pagination |
| `GET /api/sessions/:adw_id/envelopes` | `envelopes` |
| `GET /api/sessions/:adw_id/gates` | `gate_results` |
| `GET /api/sessions/:adw_id/agents/:agent/prompts` | **files** in `sessions_dir`, not the db |
| `POST /api/sessions/:adw_id/archive` | the one write: `sessions.archived` (review triage) |

The Vue app (`app/src/lib/api.ts`) calls these paths at an absolute `/api/...` with no base prefix. It polls (no websocket), routes on the hash (`#/<adw_id>/<phase_id>`, `app/src/lib/router.ts`), and knows nothing about which repo it is showing beyond the page-title `project`.

### What sync or export already exists

| Mechanism | What it does | Why it is not "hosted dashboard sync" |
|---|---|---|
| **D1 trace-db backend** (`observability.db: {kind: d1}`, `core/trace_db.ts` `D1TraceDb`) | A repo writes its trace db **directly** to a Cloudflare D1 database over the REST API. `spf ui` can read it back. | It is one db per repo, and the schema has no factory or repo column. Pointing N factories at one D1 database would mix rows with no way to tell them apart, and `adw_id` could collide. It puts a network dependency in the write path, with a 15s timeout per write. It needs an **account-wide** `CLOUDFLARE_API_TOKEN` with D1 edit in every factory's env, which is the same token Workers AI uses and is broader than #33 allows. Prompt files stay on local disk, so a remote reader cannot serve them. |
| **OTel span export** (#10, `core/otel.ts`, `otel_metrics.ts`) | A lossy, allowlisted projection pushed to an OTLP endpoint. | It is a projection by design: no payloads, no envelopes, no request text. You can rebuild a Jaeger trace from it but not the dashboard. Its lifecycle pattern is the one sync should copy: fire-and-forget, bounded queue, flush on exit. |
| **`spf events` / `spf trace` / `spf sessions`** | CLI readers over the same `SfDb`. | Local only. #49 (`spf events` verbosity tiers) is about CLI output levels and does not overlap with sync. |
| **Cloudflare provider** (#121, `core/cloudflare_provider.ts`) | Workers AI / AI Gateway as an LLM provider for Jev and Flue. | It is an LLM provider, not hosting. What carries over is the account and the env-var convention. |
| **Cloudflare sandbox** (`core/sandbox_cloudflare.ts`) | A remote execution backend. | Unrelated to the dashboard. |

**Conclusion:** nothing pushes a factory's trace to a shared, multi-tenant store today. The D1 backend is the closest building block, and it is reused below as the **hosted store**, not as each factory's live trace db.

## 3. Options considered

| Option | Summary | Verdict |
|---|---|---|
| A. Shared D1 as every factory's `observability.db` | Add `factory_id`/`repo` columns and point every factory at one D1 database. | **Rejected.** It couples every run's write path to the network and to one shared database. It puts an account-wide D1 token in every factory's env (#33). Remote readers still cannot serve prompt files. A schema migration run by one factory's tracer would hit every other factory. |
| B. **Push sync to a hosted ingest Worker** | Local sqlite stays the source of truth. `spf sync` pushes changed rows to a Cloudflare Worker, which upserts them into a multi-tenant D1. The same Vue app is served from that Worker in hosted mode. | **Chosen.** Out of the control path, offline-tolerant, scoped credentials, and it reuses D1 and the app. |
| C. Hosted service pulls from factories | The hub polls each factory's `spf ui` API. | **Rejected.** Factories sit on laptops and CI runners behind NAT, and `spf ui` binds to loopback by default (#90). |
| D. OTLP backend as the hosted store | Send everything through OTel and build the dashboard on Tempo, Honeycomb, or similar. | **Rejected for the dashboard.** The OTel export is deliberately a lossy projection (no payloads or envelopes), and the Vue app's data model is the trace db's, not spans. Option D stays the right answer for "drop SPF into an existing observability stack". |

## 4. Design

### 4.1 Identity

| Field | Source | Notes |
|---|---|---|
| `factory_id` | A random UUIDv4, generated on first `spf sync` and stored at `{data_dir}/factory.json` | One per checkout's data dir. Worktrees inherit it through the existing `.spf/data` symlink. Gitignored, so a fresh clone is a new factory, which is correct. |
| `factory_name` | `sync.factory_name` in config, defaulting to `${engineerName()}@${os.hostname()}` | A display label only, never a key. |
| `repo` | `sync.repo`, then `watch.repo`, then `git remote get-url origin` parsed to `owner/name`, then `basename(repo_root)` | Normalized to lowercase `host/owner/name` (e.g. `github.com/acme/api`) so that GitHub and Bitbucket slugs cannot collide. The resolved value goes into the payload and the hosted store. It is the **filter key**. |
| `org` / tenant | Implied by the ingest credential (§4.3) | No `org` field in the payload. A factory cannot claim a tenant. |

The hosted primary key for every synced row is `(factory_id, <local key>)`, for example `(factory_id, adw_id)` or `(factory_id, phase_id)`. `repo` is a denormalized column on `sessions` (and on `factories`) for filtering. It is never part of a key, because a factory's repo can be renamed.

### 4.2 Sync model: push, incremental, idempotent

```
running chains -> local trace db (sqlite, WAL) --(spf sync, out of band)--> POST /ingest/v1 --> Worker --> hosted D1
                                                                                                   |
                                                    browser <-- Vue app (hosted mode) <-- Worker read API
```

**The unit of sync is the session.** Rows other than events are mutable (`sessions.status`, `phases.status`, `agent_sessions.last_used_at`), and none of the tables has an `updated_at`. Delta tracking therefore works per session, not per row:

- A **sidecar state file** `{data_dir}/sync-state.json` (not a trace-db table, so no tracer schema change) records for each `adw_id`: `events_cursor` (the last pushed events `rowid`), `gates_cursor` (the last pushed `gate_results.id`), `final` (whether the session ended *and* was pushed after it ended), and `pushed_at`.
- **Each tick** selects sessions that are non-final or unknown to the state file (`ended_at IS NULL`, or not in state, or `ended_at > pushed_at`). For each one it sends:
  - a full **snapshot** of the session row, its phases, its agent_sessions and its envelopes. These are small, and upserting them is idempotent.
  - **appends** for events (`rowid > events_cursor`) and gate_results (`id > gates_cursor`), reusing the cursor `SfDb.events()` already paginates by.
- **Idempotency.** The server upserts on `(factory_id, natural key)`: `adw_id`, `phase_id`, `event_id`, `envelope_id`, `(adw_id, agent)`. For gate_results it upserts on `(factory_id, local_id)`. Replaying a batch is a no-op, so the client may retry freely and only advances its cursors after a 2xx.
- **Batching.** At most about 500 events or about 1 MB per request, the stricter of the two. A session with more is sent over several requests, and its cursor advances per accepted batch. This stays well under D1's statement and row-size limits.
- **Offline tolerance.** A failed push leaves state untouched, and the next tick resends from the cursor. Nothing is queued in memory beyond one batch, so a laptop that was offline for a week catches up on its next `spf sync`.
- **Triggers:**
  1. `spf sync` runs once. It is safe to call from cron or CI.
  2. `spf sync --follow` runs on an interval, 15s by default, backing off on failure.
  3. `spf watch` optionally runs one sync pass after each claimed issue finishes (`sync.on_watch: true`), on its own unref'd timer. It runs **after** `session.finalize()` and its failures are only logged, the same discipline as `otel.flushAll()`.
- **D1-backed repos.** Such a repo's source is already remote, so the MVP refuses with a clear message ("sync reads a local sqlite trace db"). Mirroring D1 to D1 is listed under open questions.

**Schema versioning.** Every request carries `{ "sync_schema": 1, "spf_version": "x.y.z", "factory": {...}, "sessions": [...] }`.

- The Worker accepts a declared range (`min..max`) and answers `409 {supported: [1, 1]}` outside it. The client then logs once and stops pushing. It does not keep hammering.
- The payload is **row-shaped JSON**, one object per table row, carrying only the columns the hosted schema knows. Unknown fields are ignored server-side. A local column added by a future tracer `MIGRATIONS` entry is dropped until `sync_schema` is bumped to carry it, so local schema drift can never break ingest.
- The hosted D1 has its own migration list, managed with `wrangler d1 migrations`. It is versioned independently of the tracer's additive `MIGRATIONS`.

**Data egress tiers.** Some of this data must not leave a laptop by default: `events.payload_json` carries prompts and source code, envelopes carry agent output, and `sessions.request` is the operator's prompt. The `sync.level` setting controls what goes:

| `sync.level` | Sent |
|---|---|
| `summary` | sessions (without `request`), phases, gate pass/fail with violations but without `checks_json` notes, usage, agent_sessions |
| `trace` (**default**, see Decisions) | `summary` plus events with `payload_json` **redacted** to the same allowlist `otel.ts` uses, plus `request` |
| `full` | Everything in the trace db, plus prompt files from `sessions_dir` (the prompts endpoint) |

The hosted UI already has to render rows that lack payloads (a missing prompt file renders as "no prompts"), so lower tiers degrade without errors.

### 4.3 Auth and token model

We will not build our own auth system. Cloudflare Access sits in front of the hosted Worker:

- **Readers (humans).** A Cloudflare Access application on the dashboard hostname, using the org's IdP (or Access one-time PIN). The Worker validates the `Cf-Access-Jwt-Assertion` JWT and maps the identity's email domain or Access group to a tenant. There are no passwords, sessions or user tables in SPF.
- **Writers (factories).** One **Access service token per factory** (or per CI runner), bound to an Access policy that allows only `POST /ingest/*`. The Worker reads the token's `common_name` from the validated JWT, looks it up in a `factory_credentials` table (common_name to tenant, with optional `factory_id` pinning), and rejects a payload whose `factory_id` the credential is not allowed to write. A stolen factory token can append to that factory's history and nothing else. It cannot read the dashboard.
- **On the factory.** `sync.client_id_env` and `sync.client_secret_env` name the env vars, defaulting to `SPF_SYNC_CLIENT_ID` and `SPF_SYNC_CLIENT_SECRET`. Only `spf sync` and the watch daemon read them. They are added to the credential keys stripped from agent subprocess env, which is the #33 default-deny work. `spf doctor` warns when they are visible to an agent roster entry.
- **Not** `CLOUDFLARE_API_TOKEN`. A factory never holds a credential that can touch D1 directly.

Cloudflare Access is **required** for v1. There is no custom bearer-token fallback in the MVP (see Decisions). A Worker-native bearer token for orgs without Zero Trust is a possible future addition, not scoped.

### 4.4 Hosted store (D1) data model

These are the same tables as the tracer's `SCHEMA`, with these changes:

- Every table gains `factory_id TEXT NOT NULL`, and every primary key becomes composite: `(factory_id, adw_id)`, `(factory_id, phase_id)`, `(factory_id, event_id)` and so on.
- `sessions` gains `repo TEXT NOT NULL` (denormalized from the factory at ingest) and `synced_at`.
- New table `factories (factory_id PK, tenant, name, repo, spf_version, sync_schema, first_seen_at, last_seen_at)`.
- New table `factory_credentials (common_name PK, tenant, factory_id NULL)`.
- New table `reviews (tenant, factory_id, adw_id, archived, by, at)`. Archiving in hosted mode is **reader** state per tenant. It is never pushed back to the factory's local `sessions.archived`, and never overwritten by sync.
- Indexes: `sessions(tenant, repo, started_at DESC)` and `events(factory_id, adw_id, local_rowid)`.
- Events keep the factory's local `rowid` as `local_rowid`, so the existing cursor contract (`?after=`) still holds per session.

### 4.5 Hosted read API and the same Vue app

The Worker serves:

- the **same built SPA** (`web/`, through Workers static assets), and
- the **same `/api/*` route shapes** as `src/ui/server/app.ts`, with these additions:
  - `GET /api/health` adds `mode: "local" | "hosted"`, plus `repos: string[]` and `factories: [{id, name, repo, last_seen_at}]` in hosted mode.
  - `GET /api/sessions?repo=<r>&repo=<r2>&factory=<id>` takes repo filters as a multi-value query param. Each row gains `factory_id`, `factory_name` and `repo`.
  - Session-scoped routes take an optional `factory` selector: `/api/sessions/:adw_id?factory=<id>`. Without it, a hosted request whose `adw_id` matches more than one factory returns `409` listing the candidates. Local mode ignores the parameter.

On implementation reuse: `createApp()` is Hono, and Hono runs on Workers. The SQL in `SfDb` is plain SQLite and runs on D1. Two things block running it as-is: `SfDb` reaches for `node:fs` (prompt files, `existsSync`), and it assumes a single tenant. The plan is to extract the query methods behind a small `TraceReader` interface. Local mode wraps the existing `SfDb`. Hosted mode is a D1-binding implementation that adds the `factory_id`/tenant predicates. The **route table stays shared code**.

Vue app changes, which apply in both modes:

- `app/src/lib/api.ts` takes an optional `factory` on session-scoped calls. The archive call routes to `/api/reviews` in hosted mode.
- `app/src/lib/router.ts` grows hash query params: `#/?repo=github.com/acme/api,github.com/acme/web` for the list, and `#/<adw_id>?factory=<id>` for a trace. Filters therefore survive reload and links can be shared, with no server-side session state.
- **Repo filter.** A multi-select chip bar above the sessions list, shown when `health.repos.length > 1`. Its options come from `health.repos`. "All repos" means no `repo` param.
- **Aggregated list.** Each row shows a repo and factory chip. Sort stays `started_at DESC` across factories.
- **Freshness.** In hosted mode a running session displays "last synced Ns ago" from `factories.last_seen_at`. Hosted is eventually consistent by design: one sync interval behind, plus D1 replica lag, the same trade-off already documented for D1 in `trace_db.ts`.
- **Breadcrumb.** The repo appears as a crumb in both modes, which is the in-flight "repo in breadcrumb" UI request. Local mode's crumb comes from `health.project` or `repo`. Hosted mode's crumb comes from the session's `repo`.

### 4.6 Hosting target

**Primary: Cloudflare Worker + D1 + Workers static assets + Access.** This reuses the D1 adapter experience, the same account and wrangler workflow, and the Hono server code. A new `hub/` package in this repo would hold the Worker and the D1 migrations, deployed with `wrangler deploy` by each org into **its own** Cloudflare account. SPF ships no SaaS.

**Non-goal / future note: self-hosted Node hub** (`spf hub serve`). A Hono app over a single local sqlite in hosted schema, behind a reverse proxy, would suit orgs that cannot use Cloudflare. It is not planned. Because the read routes and the ingest handler are shared code with an injected store, it could later be a second adapter rather than a fork.

**Deployment model: self-deploy only.** Each org deploys `hub/` into its own Cloudflare account. A shared SPF-operated hub is out of scope (see Decisions).

## 5. Phased plan (MVP first)

| Phase | Issue | Scope | Depends on |
|---|---|---|---|
| 1 | Factory identity + `spf sync` push client | `factory.json`, repo-slug resolution, the `sync:` config block, `sync-state.json` cursors, payload v1 builder with `sync.level` tiers, `spf sync [--follow] [--dry-run --out file.ndjson]`, credential env keys excluded from agents, `spf doctor` probe. Fully testable against a mocked fetch, and `--dry-run` is useful before any hub exists. | none |
| 2 | Hub ingest Worker + multi-tenant D1 schema | `hub/` package: wrangler config, D1 migrations (§4.4), `POST /ingest/v1` with Access service-token validation, idempotent upserts, `sync_schema` range check, `factories` upkeep, deploy doc. | 1 (payload contract) |
| 3 | Hosted read API serving the same Vue app | The `TraceReader` extraction (local `SfDb` plus D1-binding impl), shared Hono route table, `/api/health` `mode`/`repos`/`factories`, `factory` selector on session routes, static assets, Access JWT validation for readers, hosted reviews/archive. | 2 |
| 4 | Multi-factory UI: repo filter + aggregated list | Multi-select repo filter persisted in the hash, factory/repo chips on rows, `factory` in trace links, freshness indicator, repo crumb. Built against a fixture `/api` so it can land in parallel with phase 3. | 3 (API shape); can start in parallel against fixtures |

These are deliberately **after MVP**:

- `spf watch` auto-sync hook (`sync.on_watch`). It is a small follow-up on phase 1.
- Self-hosted Node hub (§4.6), a non-goal for now.
- Retention and pruning jobs, a cron-triggered Worker.
- Fleet rollups such as cost per repo per week.
- D1-to-D1 mirroring for D1-backed repos.

## 6. Risks

- **Data egress.** Payloads hold source code and prompts. The default is `trace` (redacted payloads), decided 2026-10-09. Operators opt into `full` explicitly.
- **D1 limits.** Size per database (10 GB on paid plans) and per-query limits. Event volume from long-running `spf watch` fleets could reach the size cap within months, which forces the retention decision. If a single database is not enough, shard per tenant (one D1 database per tenant).
- **Eventual consistency.** The hosted "running" state lags by up to one sync interval, plus replica lag. This is mitigated by showing freshness, and must never be read as control state. It is a dashboard, not a control plane.
- **`adw_id` collisions.** These are handled by composite keys and the `factory` selector. Lengthening `newId()` for new sessions would also help cheaply, but the composite key is still required for history.
- **Dependency on Cloudflare Access.** It avoids an auth system but ties hosted mode to Zero Trust. Accepted for v1: orgs without Zero Trust are not served, and there is no bearer fallback.
- **`SfDb` extraction churn.** `db.ts` is 660 lines with optional-column probing (`optionalColumn`). The `TraceReader` split must keep local behaviour identical, so it needs the existing `src/test` coverage.

## 7. Decisions (2026-10-09)

1. **Default sync level is `trace`.** Payloads are redacted to the OTel allowlist. It is configurable to `summary` or `full` through `sync.level`. Opting into `full` is an explicit operator choice in config.
2. **Cloudflare is the chosen and preferred platform.** Worker + D1 + Access. Cloudflare Access is required for v1, with no custom bearer-token fallback in the MVP. The self-hosted Node hub is demoted to a non-goal / future note (§4.6).
3. **Self-deploy only.** Each org deploys the hub into its own Cloudflare account. A shared SPF-run hub (multi-tenancy as a service, billing, privacy policy) is explicitly out of scope. Revisit only if SPF becomes a business.

## 8. Open questions (need a product decision)

1. **Retention:** how long are hosted events and payloads kept, and does the session summary outlive them?
2. **Archive scope:** in hosted mode, is archive per tenant (proposed) or per viewer?
3. **Repo identity for forks/clones:** is a fork, or the same repo cloned by two engineers, one repo in the filter (proposed: yes, keyed on the normalized slug) with factories underneath?
4. **D1-to-D1 mirroring:** support D1-backed repos (mirror or attach), or document "sync requires local sqlite"? The MVP refuses them.
