# piquette cloud (#214)

piquette is an independent product. An org runs it in its **own** Cloudflare account: one Worker, one deploy, all
behind Cloudflare Access. Nothing about your org, host, team or account is in piquette's source or defaults; it is all
configuration (the layered `piquette.config.yaml`) plus secrets in the environment.

The app is built from modules. **Receipts**: the receipts viewer (`/r/<run_id>`) and its API
(`/api/receipts/*`) over an R2 bucket, so a PR's receipt link opens for anyone Access lets in, with no local piquette
and no presigned URL that expires. The **ingest** module is the hosted side of `piquette sync`: `POST /ingest/v1` takes the trace batches a factory pushes
into D1 (see Ingest below). The **dashboard** module serves the same trace UI as `piquette ui`, over every factory
that has synced, scoped per reader to the tenants their email is granted (see Dashboard below). A module that is
enabled in `cloud.modules` but missing its binding (receipts without R2, ingest/dashboard without `d1`) answers 503
`module_unavailable` on its own routes rather than falling through.

Receipts and uploads never block or fail a run or a PR, and nothing here runs inside `piquette watch`.

## Configuration

Config layers load built-in, then machine, then repo, later winning. The machine layer is
`$PIQUETTE_CONFIG_HOME/piquette.config.yaml` (default `~/.piquette/piquette.config.yaml`) and applies to every repo on the machine,
which is the point: say where your cloud is once. `--config <file>` is standalone (no built-in, no machine layer).
`piquette doctor` prints the layers it found.

### `piquette cloud init`: write the block above, don't hand-edit it

```sh
piquette cloud init                 # interview on a TTY; --yes (or piped input) falls through to flags
piquette cloud init --yes --hostname piquette.example.com --team-domain <team>.cloudflareaccess.com \
  --modules receipts,ingest,dashboard --reader-domain example.com
```

Writes the `cloud:` block (and, when `ingest`/`dashboard` is on, a `sync: {}` block) into the **machine-layer**
file — never a repo's own `.piquette/`, for the same reason `deploy`/`provision-factory` refuse a repo-layer block
by default. It merges: every other top-level key already in that file (`notifications:`, a hand-set `sync.on_watch`,
...) survives untouched, and an existing `cloud:` block is left alone unless you confirm interactively or pass
`--force`. Nothing is written unless the whole merged document parses against the real config schema — the same one
`piquette doctor` and every `piquette cloud` subcommand load through — so a typo'd hostname or an invalid tenant id
is caught before anything touches disk.

`cloud.access.aud` is **required** by schema but genuinely does not exist yet at this point (it comes from an Access
application you haven't created): the written file carries an obvious placeholder instead, which makes the Worker
fail **closed** (refuse everyone) rather than fail open. Right after writing, it runs `piquette cloud access-plan`
automatically (skip with `--skip-access-plan`) so you go straight from "nothing configured" to "here is exactly what
to create in Cloudflare" in one command; `access-plan` itself also warns if it ever sees that placeholder still in
place. See **access-plan**, below, for why it stops there instead of creating those applications itself.

Flags mirror the interview one for one: `--name`, `--hostname` (or `--route` + `--zone`), `--base-path`,
`--team-domain`, `--modules` (comma list of `receipts`, `ingest`, `dashboard`; default: all three), `--bucket`,
`--d1`, `--tenant`, `--reader-email`/`--reader-domain` (each a comma list), `--sync`/`--no-sync`, `--config <path>`
to target a file other than the machine layer.

**A second (third, ...) tenant — `--add-tenant`**, not a hand-edit of `cloud.tenants`:

```sh
piquette cloud init --add-tenant --tenant acme-client --reader-email person@acme-client.com
```

A narrower mode of the same command: it only ever touches `cloud.tenants`, appending a new entry (or, with
`--force`, replacing one with the same id — never silently duplicating it) and leaving `hostname`/`modules`/`bucket`/
`d1`/`sync` exactly as they were. Needs an existing `cloud:` block (plain `cloud init` first) and at least one of
`--reader-email`/`--reader-domain`. It chains into `access-plan` the same way, which is worth noticing here
specifically: the reader app's suggested policy is drawn from **every** tenant's readers together, so adding a
tenant reruns it showing the widened rule — a reminder that the Access application's own policy is a separate
thing from `reader_grants` and may need widening by hand to actually let the new tenant's readers in. Ends with
`next: piquette cloud deploy ..., then piquette cloud provision-factory --tenant <id> ...` for that tenant's factories.

Or by hand — this is roughly what `cloud init` produces, plus a few things it doesn't ask about (theming, an s3
`receipts.store` instead of `r2:`):

```yaml
# ~/.piquette/piquette.config.yaml
cloud:
  provider: cloudflare
  name: piquette                      # the Worker name
  hostname: piquette.example.com      # a custom domain; or route: "example.com/piquette*" plus zone: example.com
  base_path: /                   # or /piquette, when mounted under a path (a route's path is the default)
  modules: [receipts]            # receipts | ingest | dashboard
  access:
    team_domain: example.cloudflareaccess.com
    aud: [<access-app-aud>]      # one string or a list; the Worker accepts a token for any of them
  r2: { bucket: piquette-receipts }   # or take the bucket from an s3 receipts.store
  # public_url: https://piquette.<account>.workers.dev   # required only for workers.dev, which has no offline URL
  # workers_dev: true            # defaults to false when hostname or route is set
  # chrome: { stylesheet_url: https://example.com/site.css, header_url: https://example.com/header, home_url: https://example.com/ }
  # brand: { name: Example Factory, logo_url: https://example.com/logo.svg, colors: { accent: { light: "#0a7a5c", dark: "#5eead4" } } }   # see Theming
receipts:
  store:
    kind: s3
    bucket: piquette-receipts
    endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    region: auto
    prefix: ""                   # must equal the Worker's RECEIPTS_PREFIX
    access_key_id_env: R2_ACCESS_KEY_ID
    secret_access_key_env: R2_SECRET_ACCESS_KEY
    session_token_env: R2_SESSION_TOKEN   # leave this var unset
```

`cloud` is replaced **whole** by a later layer, never half-merged, so a repo block cannot inherit your machine's
Access settings. A repo layer can still declare its own `cloud:`, so `piquette cloud deploy` says
`cloud block from <path> (repo layer)` when that is where it came from: a cloned repo controls where that deploy
goes. Keep the block in the machine layer.

Secrets are only ever environment variables, named in config and never valued there:
`account_id_env` (default `CLOUDFLARE_ACCOUNT_ID`), `api_token_env` (`CLOUDFLARE_API_TOKEN`),
`access.service_token_id_env` and `service_token_secret_env` (`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`,
used only by the status probe). The API token needs Workers Scripts Edit and Workers R2 Storage Edit.

## Deploy

```sh
piquette cloud deploy --dry-run   # prints the generated wrangler config and the command; no API call, nothing spawned
piquette cloud deploy             # creates the R2 bucket if absent, runs a pinned wrangler against the packaged Worker
piquette cloud status [--json]    # exit 1 on a failed check, 2 with no cloud: block
```

Deploy never creates an Access application: the org owns its perimeter. Create a self-hosted Access application
for the app's hostname (and path) with an allow policy, then put its AUD in `cloud.access.aud`. Every deploy
sets every var (a deploy replaces them all), keeps `workers_dev` off when a hostname or route is set, turns
preview URLs off, and sets `assets.run_worker_first` so no static file skips the JWT check. The wrangler config is
written to a private temp directory, holds no secret and is removed afterwards. wrangler runs through
`npx --yes wrangler@<pinned>`; it is not an piquette dependency.

If Access will not take a `workers.dev` hostname, use a custom domain on a zone in the account.

### `piquette cloud access-plan`: what to create, never created for you

```sh
piquette cloud access-plan [--json]
```

Reads the layered `cloud:` block and **prints** the Access applications your `cloud.modules` call for: their
domain, path, policy type, and a suggested rule drawn from `cloud.tenants[].readers` (when you have any). It makes
no network call, reads no credential, and creates nothing — the same `--allow-repo-cloud`-free, config-in-text-out
shape as `deploy --dry-run`'s wrangler preview. Create what it prints yourself, in Zero Trust > Access >
Applications (or your own Terraform/IaC) — piquette still never provisions your Access perimeter; this only saves
you hand-assembling the hostname, path and policy shape from the prose above.

Why it stays print-only rather than calling the Access API: an API token that can create or edit Access
Applications (`Access: Apps and Policies Edit`) is account-wide — it can rewrite the identity policy on every other
Access app in your Zero Trust account, not just piquette's. That is a materially bigger credential than anything
else this CLI asks for (`Workers Scripts Edit`, `Workers R2 Storage Edit`, and `provision-factory`'s narrower
`Access: Service Tokens Edit`, which can only mint tokens). An Access Application is also the live security
perimeter, not inert plumbing like an R2 bucket or a D1 database: a policy that is wrong by one field is a real
hole in who can reach the dashboard or write to ingest, the instant it is created. And it is frequently not the
deploying engineer's call at all — Zero Trust/IdP configuration is commonly owned by IT or security separately
from whoever runs `piquette cloud deploy`. `--json` emits one JSON value (`{apps, warnings}`) for scripting; a
repo-layer `cloud:` block gets a non-blocking warning folded into that same output, never a separate line.

`piquette cloud status` checks that the deployed script's vars equal config, the bucket exists, an unauthenticated
request is refused **by Access** (a redirect to `*.cloudflareaccess.com` or Access's own 403; the Worker's own 401
is a warning, and a 2xx is a failure), that workers.dev (when on) refuses no-token and forged-token requests, and,
with the service-token env set, that `/_piquette/status` reports every enabled module `ok`.

## Auth model

The only auth path is the `Cf-Access-Jwt-Assertion` header Access adds. The Worker fetches the team's certs
(the team domain must match `*.cloudflareaccess.com`), caches them per isolate and verifies the RS256 signature,
`iss`, `aud` (any configured AUD), `exp` and `iat`. No header is 401, an invalid token 403, a bad configuration
503 with nothing served and no key fetch. Cookies, bearer and client headers are never read. Readers need a token
with an `email`; a service token (no email) cannot read. `/_piquette/status` accepts either and returns no data.

## Ingest

Add `ingest` to `cloud.modules` and a `cloud.d1.database` name. `piquette cloud deploy` then creates the D1 database if it
is absent, applies the packaged migrations with `wrangler d1 migrations apply --remote` **before** the Worker
deploy, schedules the daily retention sweep (`17 3 * * *`), and finally writes `cloud.tenants[].readers` into the
`reader_grants` table (insert first, delete the rest after, so a reader is never locked out mid-sync).

Create a second Access application for `<hostname><base_path>/ingest*` (with `base_path: /piquette` that is `<hostname>/piquette/ingest*`; with a route path, the route's equivalent) with a **Service Auth** policy ("any valid service token"):
the credential table in D1 is the real gate, a token with no row is refused 403. `piquette cloud access-plan` prints
this exact domain/path/policy for your config (see above); it does not create the application. Then, per factory:

```sh
piquette cloud provision-factory --tenant default --name laptop [--factory-id <uuid>]
# prints PIQUETTE_SYNC_CLIENT_ID=... and PIQUETTE_SYNC_CLIENT_SECRET=... on stdout, once; put them in that factory's environment
piquette cloud provision-factory --tenant default --name laptop --client-id <id>   # adopt a token you created yourself
```

Minting needs an API token with Access: Service Tokens Edit; without it the command exits 3 and prints the manual
steps. The tenant is always taken from the credential row, never from the payload. A factory's `piquette sync` needs only
`sync: {}`: its endpoint is derived from the cloud block's public URL, **but only when that block is in your machine
layer** (or `--config`). A `cloud:` block in a repo's `.piquette/` never supplies the endpoint (a cloned repo could name
any host): set `sync.endpoint` explicitly in your machine config (or `--config`) in that case. `sync.endpoint`, `sync.client_id_env`, `sync.client_secret_env` and `sync.factory_name` are honored only from the machine layer or `--config`; a repo's `.piquette/` may set `level`, `repo`, `interval_ms` and `timeout_ms`, and `piquette doctor` warns when it tries to steer the rest.

Ingest needs the **Workers Paid** plan: a full 500-event batch plans roughly 72 or more D1 statements in one `db.batch`, above the free plan's per-invocation query limit, so on the free plan large batches fail with 500 `ingest_failed` and sync retries them. The Worker also rejects a `sent_at` that is not an ISO-8601 UTC timestamp or is more than five minutes ahead of its clock (400 `invalid_sent_at`).

`retention_days` (default 90, `0` disables) prunes events, prompts, envelope payloads and gate check detail of old
sessions. Sessions, phases, gate verdicts and factories are kept, and a running session is never touched. A
`RETENTION_DAYS` that is not a whole number skips the sweep; it never falls back to a default.
`piquette cloud status` also checks that the database exists, that its applied migrations equal the shipped count, and
that a service token can `GET /ingest/v1`.

## Dashboard

Add `dashboard` to `cloud.modules` (it needs `ingest`'s same `cloud.d1.database`, and at least one entry in
`cloud.tenants`). It owns `/api/*` — the same route table `piquette ui` serves locally, over the shared D1 instead of
a repo's own sqlite — so with `dashboard` on, `receipts` routes are served by the dashboard module and are not
mounted a second time.

A few identities are easy to conflate; they are not the same thing:

- **tenant** — the isolation boundary, declared once in `cloud.tenants[].id`. Most orgs want exactly one. A tenant is
  never created by a factory or a sync: it only ever comes from config.
- **factory** — one *machine* (a laptop, a build box). Its id is a random UUID in `factory.json`; one factory serves
  every repo checked out on it. This is what `provision-factory` (above) provisions, one machine at a time.
- **repo** — a normalized `host/owner/name` slug. Repos are **never configured**: the first time a provisioned
  factory syncs from a checkout, that repo's slug shows up in `health.repos` and in the row/repo filter on its own.
- **reader** — a human, granted by email or email domain in `cloud.tenants[].readers`, synced into `reader_grants` by
  `piquette cloud deploy`.

So onboarding a new engineer's laptop is `provision-factory` once; onboarding a new repo is nothing — point that
machine's `piquette sync` (or `piquette watch`) at it and the repo appears.

Every query a reader can run is scoped to `sessions.tenant` from their `reader_grants` row, never from the request;
an identity with no grant gets 403 `no tenant for this identity`, not an empty list. `receipts_visibility: tenant`
additionally scopes receipt blobs to the repos a reader's tenants have synced (via `factory_repos`); the default
`perimeter` instead serves any receipt to any Access identity, so a PR's evidence link still opens before its repo
has ever synced. Archiving (`POST /api/reviews`) is reader state per tenant, never written back to a factory's local
trace db.

`reader_grants` and an Access policy answer two different questions, and it is worth keeping them straight: Access
decides who gets past the perimeter at all; `cloud.tenants[].readers` then decides which tenant's data that reader
sees once inside. They commonly overlap (the same email domain in both), but they do not have to: Access could pass
your whole Google Workspace while `reader_grants` still narrows a given reader to one tenant. `piquette cloud
access-plan` suggests an Access rule from `cloud.tenants[].readers` as a reasonable starting point for the former —
see **Deploy**, above — but creating or widening it is still your call.

## Mounting under a path

`base_path` (or a route's path) mounts the whole app under `/piquette`: the Worker strips the base before routing,
`/piquette` redirects to `/piquette/`, and anything outside the base, a prefix trick like `/piquettex`, an encoded slash or a `..`
segment is a plain 404. The SPA works at `/`, under a path and on `/piquette/r/<id>` from one build: its API calls
are prefixed with the path before `/r/<id>`.

## Embedding

A host that already has a Worker and its own auth can mount piquette's receipts without the cloud app:

```ts
import { receiptRoutes, R2ReceiptReader } from "@piquette/engine/receipts";
```

`@piquette/engine/receipts` is node-free and exports the receipt routes, the R2 reader, `selectRun`,
`viewerAssetPath`, the shell helpers (`stripBase`, `injectShell`, `shellCsp`, `chromeFromVars`) and `accessConfig`.
piquette's JWT verification is deliberately not exported: a host authenticates its own way. Point your
`assets.directory` at `node_modules/@piquette/engine/web`.

## Host chrome

`cloud.chrome` takes URLs only (https): a stylesheet, a header iframe (sandboxed without `allow-same-origin`) and a
home link. The shell's CSP is `script-src 'self'` plus those origins. piquette ships no host code.

## Theming and whitelabeling

One bundle serves every org. The look is configuration, injected into the HTML shell per request: no rebuild.
`brand` is one schema in two places: `cloud.brand` for the hosted app and a top-level `ui.brand` for local `piquette ui`
(for example in your machine-layer `piquette.config.yaml`).

```yaml
ui:                                # or cloud.brand
  brand:
    name: Example Factory          # header wordmark and document titles (default: Piquette)
    logo_url: https://example.com/logo.svg   # https, or an encoded data:image/svg+xml,... URI; replaces the mark
    favicon_url: https://example.com/favicon.svg   # same rules; falls back to the logo
    home_url: https://www.example.com/       # your own root: a "Home" link in the header
    home_label: Example home                 # default "Home"
    colors:                                  # allowlisted tokens only, hex values, light and/or dark
      accent: { light: "#0a7a5c", dark: "#5eead4" }
      # also: live, ground, face, fg, rule, dim, faint, inset, rule-soft (DESIGN.md's semantic tokens)
```

- **Defaults keep today's look.** Anything unset is the stock Timetable palette, name and mark.
- **Colors** are hex only (`#rgb`, `#rrggbb`, `#rrggbbaa`). Light values apply to the paper surface, dark values to
  the board; set one or both. Tokens outside the allowlist are an error, not ignored. You own the contrast: if you
  change `ground`, `face` or `fg`, also set `dim` and `faint` (secondary text), `inset` (sunken panels) and `rule-soft`
  to match; the signal colors (pass, fail) are not themeable on purpose.
- **Delivery.** The Worker (or `piquette ui`) adds a generated `<style>` with the token overrides and a
  `<script type="application/json" id="piquette-brand">` blob (escaped, non-executable) to the shell, and sets the title
  and favicon. The CSP gets no script exception; `img-src` gains the logo and favicon origins only when they are
  configured as https URLs. `style-src` already allows inline styles.
- **Hosted vars.** `piquette cloud deploy` writes `cloud.brand` as the `BRAND_JSON` var (present, empty when unset). Cloudflare limits one
  var to 5 KB, so `cloud.brand` is capped at 4096 bytes serialized: validation and deploy fail early with a clear
  message (use an https `logo_url`, or a smaller SVG). A
  malformed var drops the bad fields with a warning in the Worker log (once per isolate, not per request); it never breaks the app.
- **`chrome.home_url`** keeps working: it is the fallback for `brand.home_url`.
- **Repo layer.** For local `piquette ui`, a repo's `.piquette/piquette.config.yaml` may set `ui.brand` name and colors, but its
  `logo_url`, `favicon_url` and `home_url` are ignored (with a warning): a cloned repo must not make your dashboard
  load or link to a host it picked. Put those in the machine layer. `cloud.brand` follows the `cloud:` block's
  rule: deploy refuses a repo-layer `cloud:` block unless `--allow-repo-cloud`.

### Getting back to a root

The header brand always links to the dashboard root under the mount base (`/`, `/piquette/`, also from `/piquette/r/<run>`),
never to a hard-coded address. A receipt page shows a "Dashboard" link and a run view an "All sessions" link back.
When `brand.home_url` (or `chrome.home_url`) is set, a "Home" link to the org root shows on every page. A
receipts-only app has no dashboard, so there the brand is plain text and only the org link remains.

## Receipt keys

Keys are `<repo>/attempts/<run_id>/<attempt>/<file>`. `<repo>` is the repo's identity without its host, parts joined
with `--` (`github.com/acme/api` is `acme--api`), so every clone and worktree of a repo shares it and a shared bucket
never splits a repo. A repo with no remote uses its main worktree's directory name. A run that already wrote under
the old directory-name segment stays on it, and the viewer finds a run under either layout. PR links are
`<public_url>/r/<run_id>?key=<key>&repo=<segment>`.

R2 lifecycle rules match a literal key prefix and every key starts with `<repo>/` (or `<prefix>/<repo>/`), so add one
rule per repo: `<prefix>/<repo>/attempts/`. Promoted runs are copied to `<repo>/kept/` and survive it.

## Developing the Worker

`cloud/` is its own package (private, outside the root tarball, which ships only the minified bundle at
`dist/worker/index.js`). After `npm ci && npm run build:cli && npm run build:app` at the repo root:
`npm --prefix cloud ci && npm --prefix cloud test` builds with `wrangler deploy --dry-run` and runs the tests in
Miniflare (no network, no credentials). The Worker is built without `nodejs_compat`, so a `node:` import in a module
fails the build. `npm --prefix cloud run e2e` is a by-hand real-Cloudflare run (creates the bucket and the Access
app, then deploys through the same generator); it is never run by tests.
