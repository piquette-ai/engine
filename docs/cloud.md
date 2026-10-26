# piquette cloud (#214)

piquette is an independent product. An org runs it in its **own** Cloudflare account: one Worker, one deploy, all
behind Cloudflare Access. Nothing about your org, host, team or account is in piquette's source or defaults; it is all
configuration (the layered `piquette.config.yaml`) plus secrets in the environment.

The app is built from modules. This release ships **receipts**: the receipts viewer (`/r/<run_id>`) and its API
(`/api/receipts/*`) over an R2 bucket, so a PR's receipt link opens for anyone Access lets in, with no local piquette
and no presigned URL that expires. The **ingest** module is the hosted side of `piquette sync`: `POST /ingest/v1` takes the trace batches a factory pushes
into D1 (see Ingest below). The `dashboard` module name is accepted by the schema and reported by
`piquette cloud status`; it answers 503 `module_unavailable` until it lands.

Receipts and uploads never block or fail a run or a PR, and nothing here runs inside `piquette watch`.

## Configuration

Config layers load built-in, then machine, then repo, later winning. The machine layer is
`$PIQUETTE_CONFIG_HOME/piquette.config.yaml` (default `~/.piquette/piquette.config.yaml`) and applies to every repo on the machine,
which is the point: say where your cloud is once. `--config <file>` is standalone (no built-in, no machine layer).
`piquette doctor` prints the layers it found.

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
the credential table in D1 is the real gate, a token with no row is refused 403. Then, per factory:

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
