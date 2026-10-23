#!/usr/bin/env node
/**
 * Tarball size gate, run in CI after `npm run build`. `npm pack --dry-run
 * --json` reports the real size without writing a .tgz to disk. Budget
 * re-verified against this package's build after the doctor.ts
 * built-in-chain validation fix plus the declarative `env:` config block /
 * `{model}` per-agent-under-Ollama fix (README/config.md/roster.md doc
 * growth + new tests) (541.4kB packed / 1536.3kB unpacked). Previously
 * 514.1kB/1455.7kB (after Jira issue-authoring + priority/frontier/roll-up +
 * spec-completion), and 478.5kB/1342.6kB before that (after tiering #14) —
 * raise these again, the same way, whenever a real feature deliberately
 * grows the package; this gate exists to catch unintentional bloat (an
 * accidentally-included file, a runaway dependency), not to cap the
 * project's size forever.
 *
 * Raised again for SPF #15 (sandbox backends: `sandbox.ts`/
 * `sandbox_opensandbox.ts`/`sandbox_cloudflare.ts`/`sandbox_sdk_types.ts` +
 * their compiled `.d.ts`), rebased onto the above and re-measured at
 * 597.1kB packed / 1729.6kB unpacked, 186 files: ≤625 KB packed, ≤1.81 MB
 * unpacked — ~5% headroom, same rationale as every prior raise.
 *
 * Raised again for watch --n N (sandboxed best-of-N fan-out per claimed
 * issue) rebased onto #53's `spf loop` landing independently on main in the
 * same window: 630.0kB packed / 1828.6kB unpacked, 192 files: ≤660 KB
 * packed, ≤1.92 MB unpacked — ~5% headroom, same rationale as every prior
 * raise.
 *
 * Raised again for the refiner over-decomposition fix: `assets/prompts/
 * refiner/system.md`/`user.md` grew substantially (the slice test, the
 * sizing/budget section, a worked example, a spec-split Report shape) plus
 * new `gates.ts` budget/shape checks, `watch.ts`'s split-proposal state
 * machine, and README/config.md doc growth to match — 675.2kB packed /
 * 1962.2kB unpacked, 195 files: ≤710 KB packed, ≤2.06 MB unpacked — ~5%
 * headroom, same rationale as every prior raise.
 *
 * Raised again for the Timetable UI (#59): the app replaces Play's two
 * woff2 files with the self-hosted Overpass family (five: sans 400/600/700
 * + mono 400/700) and adds DESIGN.md/PRODUCT.md + the design sidecar —
 * re-measured at 719.5kB packed / 2011.7kB unpacked, 198 files: ≤755 KB
 * packed, ≤2.06 MB unpacked — ~5% headroom on the packed side, unpacked
 * unchanged (headroom there grew).
 *
 * Raised again for the WebMCP + on-device AI batch (#67 WebMCP tools, #68
 * in-browser semantic search, #69 Summarizer session summaries, #70 Prompt
 * API Q&A): no new packaged files (still 198), but the app's shipped bundle
 * grew by four components' worth of source plus their API shims —
 * re-measured at 735.8kB packed / 2084.7kB unpacked, 198 files: ≤775 KB
 * packed, ≤2.19 MB unpacked — ~5% headroom, same rationale as every prior
 * raise.
 *
 * Merging in issue #66 PR1 (discriminated `observability.db` schema — local
 * sqlite | remote d1 — plus the resolveObservabilityDb() normalizer and
 * paths.ts/runner.ts updates, with matching test growth) on top of the
 * WebMCP batch above re-measures at 740.9kB packed / 2099.4kB unpacked, 198
 * files — comfortably inside the budget the WebMCP raise already set, so no
 * further raise was needed here.
 *
 * Rebasing the opencode coding_agent backend (#71) onto the above (a new
 * src/core/agent_opencode.ts (~600 lines) plus its compiled .d.ts/.js, a
 * new ts-opencode.spf.config.yaml template, a new agent_opencode.test.ts,
 * and README/PRODUCT.md/config.md doc growth to match the two other
 * backends' own documentation depth, ON TOP OF the D1 trace-db adapter
 * (#74) and its interview/doctor wiring (#75) that landed on main in the
 * same window) re-measures at 782.7kB packed / 2228.4kB unpacked, 203
 * files: ≤822 KB packed, ≤2.34 MB unpacked — ~5% headroom, same rationale
 * as every prior raise.
 *
 * Raised again for the otel-sdk batch (#78 OTLP SDK exporter, process
 * metrics, outbound propagation) plus its follow-ups (#79 opencode
 * propagation, #80 flue trace unification — more propagation code, headers,
 * tests, and docs): the real OTel SDK deps and the per-backend propagation
 * code grew the tarball to 816.2kB packed / 2328.6kB unpacked, 207 files
 * (re-measured on #80 rebased onto #83's merge): ≤865 KB packed, ≤2.47 MB
 * unpacked — ~5% headroom, same rationale.
 *
 * Raised again for the Jev decision epic (#102): the rails in this change
 * (#103: core/jev.ts, jev_kinds.ts, docs/jev.md + the brainstorm doc) take
 * main's 891.1kB/2549.0kB to 918.8kB packed / 2636.9kB unpacked, and the
 * stacked feature PRs on top of it (#104-#109: risk_tier, loop_control,
 * finding_triage, chain_router, watch intake, chain_edge graphs) grow it to
 * 991.5kB packed / 2859.6kB unpacked, 225 files, measured at the top of the
 * stack. Budgeted once here for the whole stack, so each feature PR does
 * not re-edit this line: ≤1040 KB packed, ≤3.0 MB unpacked — ~5% headroom
 * over the stack top, same rationale as every prior raise.
 *
 * Raised again for `issue_provider: github-projects` (a GitHub Projects v2
 * board as the state machine, not an optional label mirror): a new
 * `core/issues/github_projects_provider.ts` plus its compiled `.d.ts`, a new
 * ~600-line test file, and README/config.md/CHANGELOG doc growth to match —
 * 1035.5kB packed / 3017.0kB unpacked, 230 files: ≤1040 KB packed (already
 * covers it) / ≤3.17 MB unpacked — ~5% headroom over the new unpacked
 * figure, same rationale as every prior raise.
 *
 * Raised again merging the above onto main alongside `jev.provider: ollama`
 * (landed independently in the same window): 1042.1kB packed / 3041.7kB
 * unpacked, 230 files: ≤1090 KB packed / ≤3.2 MB unpacked — ~5% headroom
 * over the combined figure, same rationale as every prior raise.
 *
 * Raised again for the `diff_risk` decision kind (#152): the new
 * `core/diff_risk.ts` and `chains/diff_risk.ts` modules (floor tables,
 * redaction, git reader, fail-closed outcome), their compiled `.d.ts`, a new
 * test file and docs/CHANGELOG growth take 1090.0kB/3200.0kB to 1095.6kB
 * packed / 3218.0kB unpacked, 242 files (re-measured): ≤1150 KB packed /
 * ≤3.38 MB unpacked — ~5% headroom, same rationale as every prior raise.
 *
 * Raised again for verification receipts (#159): the receipt store
 * (`core/receipt_store.ts`, SigV4 S3/R2/local), the receipt schema
 * (`core/receipt.ts`), journeys + recorder + `spf prove` (`core/journeys.ts`,
 * `core/recorder.ts`, `core/prove.ts`, `cli/commands/prove.ts`), their
 * `.d.ts` and tests, and README/CHANGELOG growth — measured at ticket B,
 * 1097.1kB packed / 3234.7kB unpacked, 244 files. Budgeted once for the
 * receipts stack (tickets C–E add little code) rather than per PR.
 * Re-measured after restacking onto main with the decisions stack
 * (#160/#162/#186) merged — both features together, at the top of the
 * receipts stack: 1164.9kB packed / 3445.1kB unpacked, 257 files:
 * ≤1225 KB packed / ≤3.62 MB unpacked — ~5% headroom, same rationale as
 * every prior raise.
 * Receipts viewer (#202) ships video.js (~709 kB minified, 212 kB gzip) as a
 * lazy ReceiptViewer chunk, so the dashboard's main bundle stays ~160 kB but
 * the tarball carries both: 1419.6kB packed / 4296.0kB unpacked, 280 files:
 * ≤1490 KB packed / ≤4.51 MB unpacked — ~5% headroom, same rationale.
 * Moving that viewer to video.js 10 (`@videojs/html`) swaps the chunk and
 * adds 59 lazily loaded i18n locale chunks (ar-*.js ... zh-TW-*.js) to
 * web/assets, taking the packed file count from 323 to 390; measured after a
 * clean build: 1465.8kB packed, 390 files. Note `cd cloud && npm test` runs
 * `bundle` without the prune step and leaves an unpruned dist/worker
 * index.js.map (759 kB), so run size-check before it or after a clean build.
 *
 * Raised again for `spf sync` (#135): `core/sync/*` (contract, identity,
 * state, source, redact, client), `cli/commands/sync.ts`, their `.d.ts`, the
 * 5.8kB generated `assets/sync/payload.v1.schema.json` and a doctor block —
 * the receipts-stack headroom was already spent (1.6kB left), so this one
 * lands at 1213.7kB packed / 3618.4kB unpacked, 283 files: ≤1275 KB packed /
 * ≤3.80 MB unpacked — ~5% headroom, same rationale as every prior raise. The
 * hub Worker (#136) is a separate top-level package outside the root `files`.
 * Combined (viewer + sync, cloud-app integration): ~5% over the sum of both
 * raises — ≤1545 KB packed / ≤4.70 MB unpacked.
 *
 * Raised again for the one cloud app (#214): the minified Worker bundle
 * (`dist/worker/index.js`, ~56 kB: hono + jose + the module code), `src/cloud/*`
 * and `core/repo_slug.ts` with their `.d.ts`, the `@gr8ful/spf/receipts`
 * barrel, `docs/cloud.md` — re-measured at 1504.5kB packed / 4592.0kB unpacked,
 * 323 files: ≤1580 KB packed / ≤4.82 MB unpacked — ~5% headroom, same
 * rationale as every prior raise. cloud/ itself (sources, node_modules) never
 * ships: the script and `prepack` fail on any `cloud/` path.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const PACKED_BUDGET = 1_580_000;
const UNPACKED_BUDGET = 4_820_000;

const root = path.resolve(import.meta.dirname, "..");
// --ignore-scripts: this check runs AFTER `npm run build` in CI, so the
// prepack guard has already had its say; running it again here would only
// print its own output onto the same stdout stream this script parses as JSON.
// It does NOT suppress `prepare`, though (verified directly: npm still ran
// `lefthook install` here despite the flag, printing "sync hooks: ..." onto
// stdout) — `prepare`'s whole point is to run before packing regardless, so
// rather than fight that, find where npm's own JSON array actually starts
// (its own line, always "[") and parse from there instead of the raw string.
const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf-8" });
const lines = raw.split("\n");
const jsonStart = lines.findIndex((line) => line.trim() === "[" || line.trim() === "{");
if (jsonStart === -1) {
  console.error("check-tarball-size: could not find the start of npm pack's JSON output:\n" + raw);
  process.exit(1);
}
const parsed = JSON.parse(lines.slice(jsonStart).join("\n"));
// npm <11 reports an array (`[{...}]`); npm >=12 reports an object keyed by
// package id (`{"@scope/name": {...}}`) -- support both rather than pin to
// whichever shape happened to be installed when this was last verified.
const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
// cloud/ is its own package, outside the root tarball: any path under it is a packaging bug.
const cloudPaths = info.files.filter((f) => f.path.startsWith("cloud/"));
if (cloudPaths.length > 0) {
  console.error(`check-tarball-size: ${cloudPaths.length} file(s) under cloud/ would ship, e.g. ${cloudPaths[0].path}`);
  process.exit(1);
}

function fmt(bytes) {
  return `${(bytes / 1000).toFixed(1)}kB`;
}

console.log(`tarball: ${fmt(info.size)} packed, ${fmt(info.unpackedSize)} unpacked, ${info.entryCount} files`);

const failures = [];
if (info.size > PACKED_BUDGET) failures.push(`packed ${fmt(info.size)} exceeds budget ${fmt(PACKED_BUDGET)}`);
if (info.unpackedSize > UNPACKED_BUDGET) failures.push(`unpacked ${fmt(info.unpackedSize)} exceeds budget ${fmt(UNPACKED_BUDGET)}`);

if (failures.length > 0) {
  console.error("check-tarball-size: over budget:");
  for (const f of failures) console.error(`  ${f}`);
  console.error("\nIf the growth is deliberate, raise PACKED_BUDGET/UNPACKED_BUDGET in this script alongside the change that caused it.");
  process.exit(1);
}
console.log("check-tarball-size: within budget.");
