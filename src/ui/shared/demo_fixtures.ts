/**
 * A richer fixture set for eyeballing the UI (`PIQUETTE_MOCK=local|demo` in app/).
 * hosted_fixtures.ts keeps its small, test-pinned dataset for `PIQUETTE_MOCK=hosted`;
 * this one is shaped to exercise the surfaces a reader actually meets:
 * 15 runs over two days, three repos (one with a very long name), two
 * factories, success / fail / running, a run that recovered through a fix
 * loop, several runs with a recorded cost of exactly 0 (subscription-backed
 * agents), a markdown request title, and two runs with receipts (one with a
 * recording, one without). Phase spans add up to each run's duration, and the
 * gate rows agree with the phases' pass/fail.
 *
 * Times are relative to `nowMs`, so "Today" and "Yesterday" read naturally.
 */

import { DEMO_VIDEO_BASE64 } from "./demo_video.js";
import type { AgentSession, GateResult, HealthResponse, HostedFactory, Phase, ReceiptEvidenceItem, ReceiptJson, ReceiptsRunResponse, Session, SessionSummary } from "./types.js";

export const DEMO_REPO_API = "github.com/acme/api";
export const DEMO_REPO_WEB = "github.com/acme/web";
export const DEMO_REPO_PIQUETTE = "github.com/piquette-ai/piquette-cli";
/** The receipt store keys by repo segment (segmentFromSlug of the slug), never the full slug. */
const DEMO_RECEIPT_REPO_SEGMENT = "piquette-ai--piquette-cli";
export const DEMO_REPOS = [DEMO_REPO_API, DEMO_REPO_WEB, DEMO_REPO_PIQUETTE];

/** A run with a receipt and no recording: before FAIL 28/36, after PASS 36/36. */
export const DEMO_RECEIPT_RUN = "7ec31b90";
/** A run with a receipt and a recording of the journey before and after: before FAIL 18/24, after PASS 24/24. */
export const DEMO_RECORDED_RUN = "b7d20f45";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const FACTORIES = {
  laptop: { id: "f-3a1c", name: "jd@laptop", repo: DEMO_REPO_PIQUETTE, syncedSecAgo: 6 },
  ci: { id: "f-9e47", name: "ci-runner-1", repo: DEMO_REPO_API, syncedSecAgo: 140 },
} as const;

type Step = [name: string, status: Phase["status"], attempt?: number];

interface Seed {
  adw_id: string;
  factory: keyof typeof FACTORIES;
  repo: string;
  chain: string;
  request: string;
  status: "running" | "success" | "fail";
  startedMinAgo: number;
  durationMin: number;
  /** Exactly 0 means "not billed per token" (subscription or flat-rate agent). */
  cost: number;
  tokens: number;
  phases: Step[];
}

const PLAN_BUILD = ["plan", "build"] as const;
const ok = (...names: string[]): Step[] => names.map((n) => [n, "success"]);

const SEEDS: Seed[] = [
  { adw_id: "a1b2c3d4", factory: "laptop", repo: DEMO_REPO_PIQUETTE, chain: "plan + build-test", request: "Add cursor pagination to /v1/runs", status: "running", startedMinAgo: 6, durationMin: 6, cost: 0.84, tokens: 212_400, phases: [["plan", "success"], ["build", "running"], ["test", "queued"]] },
  { adw_id: "c0ffee01", factory: "laptop", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Dark-mode contrast pass on the settings page", status: "running", startedMinAgo: 14, durationMin: 14, cost: 0, tokens: 301_900, phases: [["plan", "success"], ["build", "success"], ["review", "running"]] },
  { adw_id: "dead0042", factory: "ci", repo: DEMO_REPO_API, chain: "plan + build-test", request: "Bump undici to patch CVE-2026-1182", status: "success", startedMinAgo: 55, durationMin: 12, cost: 0.31, tokens: 88_000, phases: ok(...PLAN_BUILD, "test") },
  // Failed phase, fix loop, then green: the "recovered" shape.
  { adw_id: "fb1x0042", factory: "ci", repo: DEMO_REPO_API, chain: "plan + build-test", request: "Retry flaky webhook delivery with backoff", status: "success", startedMinAgo: 95, durationMin: 41, cost: 3.05, tokens: 702_100, phases: [["plan", "success"], ["build", "success"], ["test", "fail", 1], ["fix", "success", 1], ["test", "success", 2], ["review", "success"]] },
  { adw_id: "5f6a7b8c", factory: "laptop", repo: DEMO_REPO_PIQUETTE, chain: "plan + build-test", request: "## Problem\n\nThe timetable list shows `$0.0000` for runs billed through a subscription.\n\n## Expected\n\nShow a dash and explain it in a tooltip.", status: "success", startedMinAgo: 130, durationMin: 18, cost: 0, tokens: 244_300, phases: ok(...PLAN_BUILD, "test", "review") },
  { adw_id: "e44d9a10", factory: "ci", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Replace moment with date-fns in the calendar widget", status: "fail", startedMinAgo: 190, durationMin: 21, cost: 2.4, tokens: 540_300, phases: [["plan", "success"], ["build", "success"], ["test", "fail"]] },
  { adw_id: DEMO_RECEIPT_RUN, factory: "laptop", repo: DEMO_REPO_PIQUETTE, chain: "prove + fix", request: "Fix the receipts viewer so the checks table keeps its header on scroll", status: "success", startedMinAgo: 260, durationMin: 52, cost: 1.92, tokens: 455_800, phases: [["prove_base", "success"], ["build", "success"], ["prove_1", "success"]] },
  { adw_id: DEMO_RECORDED_RUN, factory: "laptop", repo: DEMO_REPO_PIQUETTE, chain: "prove + fix", request: "Keep the masthead crumbs clear of the live lamp on phones", status: "success", startedMinAgo: 300, durationMin: 36, cost: 1.38, tokens: 330_200, phases: [["prove_base", "success"], ["build", "success"], ["prove_1", "success"]] },
  { adw_id: "3b9c0e77", factory: "laptop", repo: DEMO_REPO_WEB, chain: "scout", request: "Where do we parse the session cookie? List every call site.", status: "success", startedMinAgo: 340, durationMin: 4, cost: 0, tokens: 41_200, phases: ok("scout") },
  // Recovered without a second attempt of the failed phase: test failed, a fix phase ran, the run finished.
  { adw_id: "4e5d6c7b", factory: "laptop", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Debounce the search box on the members page", status: "success", startedMinAgo: 1450, durationMin: 24, cost: 1.12, tokens: 268_900, phases: [["plan", "success"], ["build", "success"], ["test", "fail", 1], ["fix", "success", 1], ["review", "success"]] },
  { adw_id: "9a8b7c6d", factory: "ci", repo: DEMO_REPO_API, chain: "plan + build-test", request: "Index sessions(repo, started_at) for the hosted list", status: "success", startedMinAgo: 1500, durationMin: 9, cost: 0.46, tokens: 120_800, phases: ok(...PLAN_BUILD) },
  { adw_id: "1d2e3f40", factory: "laptop", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Skeleton loaders for the dashboard grid", status: "success", startedMinAgo: 1700, durationMin: 18, cost: 1.6, tokens: 388_000, phases: ok(...PLAN_BUILD, "test") },
  { adw_id: "77aa1c02", factory: "laptop", repo: DEMO_REPO_PIQUETTE, chain: "plan + build-test", request: "Teach `piquette doctor` to flag a stale protected_files pattern", status: "fail", startedMinAgo: 1800, durationMin: 27, cost: 0, tokens: 330_600, phases: [["plan", "success"], ["build", "success"], ["test", "fail"]] },
  { adw_id: "0c0c5d19", factory: "ci", repo: DEMO_REPO_API, chain: "refine", request: "Split the billing epic into reviewable tickets", status: "success", startedMinAgo: 1900, durationMin: 6, cost: 0.12, tokens: 52_000, phases: ok("refine") },
  { adw_id: "62f1b7e3", factory: "laptop", repo: DEMO_REPO_PIQUETTE, chain: "plan + build-test", request: "Document the hub sync key rotation", status: "success", startedMinAgo: 2050, durationMin: 14, cost: 0, tokens: 176_400, phases: ok(...PLAN_BUILD, "review") },
  { adw_id: "d3adbe3f", factory: "ci", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Migrate the avatar upload to presigned URLs", status: "success", startedMinAgo: 2300, durationMin: 33, cost: 0.0042, tokens: 9_800, phases: ok(...PLAN_BUILD, "test") },
];

/**
 * The tracker issue and PR `piquette watch` recorded for a run (the trace's
 * `issue_*`/`pr_*` columns). Only watch runs have them: a running or failed
 * run has its issue but no PR yet, a landed run has both, and the
 * interactive runs (scout, the local docs and doctor runs) have neither.
 * acme/api tracks its work in Jira (on a placeholder example.atlassian.net
 * site); the other two repos use GitHub issues.
 * The two receipt runs carry the same issue numbers as their receipts.
 */
const gh = (repo: string, kind: "issues" | "pull", n: number) => ({ label: `#${n}`, url: `https://${repo}/${kind}/${n}` });
const jira = (key: string) => ({ label: key, url: `https://example.atlassian.net/browse/${key}` });
type DemoLink = { label: string; url: string };
const LINKS: Record<string, { issue: DemoLink; pr?: DemoLink }> = {
  a1b2c3d4: { issue: gh(DEMO_REPO_PIQUETTE, "issues", 241) },
  dead0042: { issue: jira("ACME-1221"), pr: gh(DEMO_REPO_API, "pull", 318) },
  fb1x0042: { issue: jira("ACME-1207"), pr: gh(DEMO_REPO_API, "pull", 315) },
  e44d9a10: { issue: gh(DEMO_REPO_WEB, "issues", 88) },
  [DEMO_RECEIPT_RUN]: { issue: gh(DEMO_REPO_PIQUETTE, "issues", 227), pr: gh(DEMO_REPO_PIQUETTE, "pull", 230) },
  [DEMO_RECORDED_RUN]: { issue: gh(DEMO_REPO_PIQUETTE, "issues", 229), pr: gh(DEMO_REPO_PIQUETTE, "pull", 231) },
  "9a8b7c6d": { issue: jira("ACME-1188"), pr: gh(DEMO_REPO_API, "pull", 309) },
  "77aa1c02": { issue: gh(DEMO_REPO_PIQUETTE, "issues", 212) },
};

/** Relative weight of a phase in its run's wall clock; the run's duration is split by these. */
const WEIGHT: Record<string, number> = { plan: 2, build: 6, test: 3, review: 2, fix: 4, prove_base: 3, prove_1: 3, scout: 1, refine: 1 };
const weightOf = (name: string) => WEIGHT[name] ?? 2;
const isCode = (name: string) => name === "test" || name.startsWith("prove");

/**
 * Phases laid end to end across `spanMs`, each given its weighted share. A queued phase has
 * not started and takes no time; a running phase ends where the span does (now).
 */
function buildPhases(adw: string, steps: Step[], startMs: number, spanMs: number): Phase[] {
  const started = steps.filter(([, status]) => status !== "queued");
  const total = started.reduce((n, [name]) => n + weightOf(name), 0) || 1;
  let cursor = startMs;
  return steps.map((step, i) => {
    const [name, status, attempt] = step;
    const seq = i + 1;
    const share = status === "queued" ? 0 : Math.round((spanMs * weightOf(name)) / total);
    const from = cursor;
    cursor += share;
    return {
      phase_id: `${adw}-p${seq}`,
      adw_id: adw,
      seq,
      name,
      kind: isCode(name) ? "code" : "agent",
      owner: isCode(name) ? null : "builder",
      description: null,
      status,
      attempt: attempt ?? 1,
      retries: (attempt ?? 1) - 1,
      error: status === "fail" ? "1 gate failed" : null,
      started_at: status === "queued" ? null : iso(from),
      ended_at: status === "success" || status === "fail" ? iso(from + share) : null,
    };
  });
}

export function demoFactories(nowMs: number): HostedFactory[] {
  return Object.values(FACTORIES).map((f) => ({ id: f.id, name: f.name, repo: f.repo, last_seen_at: iso(nowMs - f.syncedSecAgo * 1000) }));
}

export function demoSessions(nowMs: number): SessionSummary[] {
  return SEEDS.map((s) => {
    const f = FACTORIES[s.factory];
    const start = nowMs - s.startedMinAgo * MIN;
    const spanMin = s.status === "running" ? s.startedMinAgo : s.durationMin;
    const phases = buildPhases(s.adw_id, s.phases, start, spanMin * MIN);
    const session: Session = {
      adw_id: s.adw_id,
      adw_name: s.chain,
      request: s.request,
      status: s.status,
      engineer: f.name.split("@")[0] ?? null,
      started_at: iso(start),
      ended_at: s.status === "running" ? null : iso(start + s.durationMin * MIN),
      total_tokens: s.tokens,
      total_cost: s.cost,
      billable_tokens: s.tokens,
      archived: 0,
      issue_label: LINKS[s.adw_id]?.issue.label ?? null,
      issue_url: LINKS[s.adw_id]?.issue.url ?? null,
      pr_label: LINKS[s.adw_id]?.pr?.label ?? null,
      pr_url: LINKS[s.adw_id]?.pr?.url ?? null,
      factory_id: f.id,
      factory_name: f.name,
      repo: s.repo,
    };
    return { ...session, phases, phase_count: phases.length, agents: [] as AgentSession[] };
  });
}

const TEST_FILES = ["api.spec.ts", "store.spec.ts", "ui.spec.ts", "cli.spec.ts"];

/**
 * What the tests gate reported for each run whose test phase failed: the spec file and the failing
 * cases, one violation per case. Runs not listed fall back to one case in ui.spec.ts.
 */
const TEST_FAILURES: Record<string, { file: string; cases: string[] }> = {
  // Recovered: the first test attempt failed, the fix phase made it pass.
  fb1x0042: { file: "webhook.spec.ts", cases: ["webhook.spec.ts › retries a 503 with backoff: expected 3 attempts, got 1"] },
  // Recovered with no second test attempt: the fix phase ran and the run finished.
  "4e5d6c7b": { file: "search.spec.ts", cases: ["search.spec.ts › debounces typing: expected 1 request, got 5"] },
  e44d9a10: {
    file: "calendar.spec.ts",
    cases: [
      "calendar.spec.ts › renders the week view: expected 7 columns, got 6",
      'calendar.spec.ts › formats the header date: expected "Mon 3 Nov", got "Mon 3rd Nov"',
    ],
  },
  "77aa1c02": {
    file: "doctor.spec.ts",
    cases: [
      "doctor.spec.ts › flags a protected_files pattern that matches nothing: expected 1 warning, got 0",
      "doctor.spec.ts › names the stale pattern in the warning: expected \"legacy/**\" in output",
      "doctor.spec.ts › exits 0 when every pattern matches: expected exit 0, got 1",
      "doctor.spec.ts › prints the fix hint under the warning: expected 1 hint line, got 0",
    ],
  },
};
const DEFAULT_TEST_FAILURE = { file: "ui.spec.ts", cases: ["ui.spec.ts › renders the week view: expected 7 columns, got 6"] };

/**
 * The gate rows behind a run's phases: one per settled test, prove and build phase. A failed
 * phase carries exactly one failing gate (matching its "1 gate failed" error) whose violations
 * are the failing cases of TEST_FAILURES, and a passing phase carries only passing gates, so
 * counts agree with the phase list.
 */
export function demoGates(phases: readonly Phase[]): GateResult[] {
  const rows: GateResult[] = [];
  for (const p of phases) {
    if (p.status !== "success" && p.status !== "fail") continue;
    const name = p.name ?? "";
    const gate = name === "test" ? "tests" : name.startsWith("prove") ? "receipt" : name === "build" ? "protected_files" : null;
    if (!gate) continue;
    const failed = p.status === "fail";
    const failure = TEST_FAILURES[p.adw_id] ?? DEFAULT_TEST_FAILURE;
    const files = TEST_FILES.filter((f) => f !== failure.file);
    const checks =
      gate === "tests"
        ? [...files, failure.file].map((item, i) =>
            failed && item === failure.file ? { item, ok: false, note: `${failure.cases.length} failed` } : { item, ok: true, note: `${12 + i * 5} passed` },
          )
        : gate === "receipt"
          ? [{ item: "receipt.json", ok: true, note: "written" }, { item: "evidence", ok: true, note: "3 files hashed" }]
          : [{ item: "src/", ok: true, note: "no protected path touched" }, { item: "package.json", ok: true, note: "unchanged" }];
    rows.push({
      id: rows.length + 1,
      adw_id: p.adw_id,
      phase_id: p.phase_id,
      attempt: p.attempt,
      gate,
      passed: failed ? 0 : 1,
      violations_json: JSON.stringify(failed ? failure.cases : []),
      checks_json: JSON.stringify(checks),
      created_at: p.ended_at,
    });
  }
  return rows;
}

export function demoHealth(mode: "local" | "demo", nowMs: number): HealthResponse {
  if (mode === "local") {
    return { ok: true, db: "fixture", journal_mode: "wal", sessions: SEEDS.length, project: "piquette-cli", repo: "piquette-ai/piquette-cli", mode: "local" };
  }
  return { ok: true, db: "fixture", journal_mode: "d1", sessions: SEEDS.length, mode: "hosted", repos: DEMO_REPOS, factories: demoFactories(nowMs) };
}

// ── the receipt ──────────────────────────────────────────────────────────────

const SHA = "5522be3f0c1d9a4e7b2860d1a93c4f5e6b7a8c9d";

interface ReceiptSeed {
  total: number;
  /** Checks failing before the change. */
  before: number;
  issue: string;
  subject: string;
  /** Recorded runs carry a `video` evidence item per attempt; the other has stills and a transcript only. */
  video: boolean;
  startedMinAgo: number;
  durationMin: number;
}
const RECEIPTS: Record<string, ReceiptSeed> = {
  [DEMO_RECEIPT_RUN]: { total: 36, before: 8, issue: "227", subject: "receipts viewer", video: false, startedMinAgo: 260, durationMin: 52 },
  [DEMO_RECORDED_RUN]: { total: 24, before: 6, issue: "229", subject: "masthead", video: true, startedMinAgo: 300, durationMin: 36 },
};

const evidence = (runId: string, attempt: "base" | "head", video: boolean): Record<string, ReceiptEvidenceItem> => ({
  poster: { key: `${runId}/${attempt}/poster.svg`, content_type: "image/svg+xml", bytes: 640, sha256: "a".repeat(64) },
  contact_sheet: { key: `${runId}/${attempt}/contact-sheet.svg`, content_type: "image/svg+xml", bytes: 640, sha256: "b".repeat(64) },
  transcript: { key: `${runId}/${attempt}/transcript.txt`, content_type: "text/plain", bytes: 420, sha256: "c".repeat(64) },
  ...(video ? { video: { key: `${runId}/${attempt}/recording.mp4`, content_type: "video/mp4", bytes: Math.floor((DEMO_VIDEO_BASE64.length * 3) / 4), sha256: "d".repeat(64), duration_s: 2 } } : {}),
});

const JOURNEYS = ["open the receipt", "scroll the checks table", "switch attempts", "follow an evidence link"];
function checks(failing: number, total: number): ReceiptJson["checks"] {
  return Array.from({ length: total }, (_, i) => {
    const journey = JOURNEYS[i % JOURNEYS.length] ?? "journey";
    const pass = i >= failing;
    return {
      journey,
      name: `${journey}: step ${Math.floor(i / JOURNEYS.length) + 1}`,
      pass,
      ...(pass ? {} : { expected: "header stays pinned", actual: "header scrolled away", hint: "position: sticky is missing on thead th" }),
    };
  });
}

function receipt(runId: string, seed: ReceiptSeed, stage: "base" | "head", nowMs: number): ReceiptJson {
  const base = stage === "base";
  return {
    schema: "piquette.receipt/1",
    run_id: runId,
    attempt: 1,
    repo: DEMO_RECEIPT_REPO_SEGMENT,
    issue: seed.issue,
    stage,
    revision: { sha: base ? "045a840a1b2c3d4e5f60718293a4b5c6d7e8f901" : SHA, tree: base ? "9f8e7d6c5b4a" : "1a2b3c4d5e6f", dirty: false },
    verdict: base ? "FAIL" : "PASS",
    reason: base ? `${seed.before} of ${seed.total} checks failed before the change` : `All ${seed.total} checks pass after the change`,
    next: [],
    at: new Date(nowMs - (base ? seed.startedMinAgo - 6 : seed.startedMinAgo - seed.durationMin + 2) * MIN).toISOString(),
    subject: { kind: "ui", detail: seed.subject },
    journeys: JOURNEYS.map((id) => ({ id, criterion: id, steps: [{ name: "run", ms: 1800, exit: 0 }] })),
    checks: checks(base ? seed.before : 0, seed.total),
    evidence: evidence(runId, stage, seed.video),
  };
}

export function demoReceiptRun(runId: string, nowMs: number): ReceiptsRunResponse | null {
  const seed = RECEIPTS[runId];
  if (!seed) return null;
  const b = receipt(runId, seed, "base", nowMs);
  const h = receipt(runId, seed, "head", nowMs);
  return {
    run_id: runId,
    repo: DEMO_RECEIPT_REPO_SEGMENT,
    base: { key: `${runId}/base/receipt.json`, attempt: 1, receipt: b },
    head: { key: `${runId}/head/receipt.json`, attempt: 1, receipt: h },
    attempts: [
      { attempt: 1, stage: "base", verdict: "FAIL", at: b.at, key: `${runId}/base/receipt.json`, checks: { total: seed.total, failed: seed.before } },
      { attempt: 1, stage: "head", verdict: "PASS", at: h.at, key: `${runId}/head/receipt.json`, checks: { total: seed.total, failed: 0 } },
    ],
  };
}

const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#ede8db"/><rect x="24" y="24" width="592" height="312" fill="none" stroke="#76705e"/><text x="320" y="64" text-anchor="middle" font-family="monospace" font-size="20" fill="#5f5948">${label}</text></svg>`;

/** The evidence files behind a receipt's links: small SVG stand-ins, a text transcript, and for the recorded run a tiny test-pattern clip. */
export function demoReceiptFile(runId: string, key: string): { contentType: string; text: string; base64?: boolean } | null {
  const seed = RECEIPTS[runId];
  if (!seed) return null;
  if (key.endsWith(".svg")) return { contentType: "image/svg+xml", text: svg(key.includes("poster") ? "poster (fixture)" : "contact sheet (fixture)") };
  if (key.endsWith("transcript.txt")) return { contentType: "text/plain", text: `$ piquette prove\nopen the receipt ... ok\nscroll the checks table ... ok\n${seed.total}/${seed.total} checks pass\n` };
  if (seed.video && key.endsWith("recording.mp4")) return { contentType: "video/mp4", text: DEMO_VIDEO_BASE64, base64: true };
  return null;
}
