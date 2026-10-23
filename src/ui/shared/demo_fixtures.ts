/**
 * A richer fixture set for eyeballing the UI (`SPF_MOCK=local|demo` in app/).
 * hosted_fixtures.ts keeps its small, test-pinned dataset for `SPF_MOCK=hosted`;
 * this one is shaped to exercise the surfaces a reader actually meets:
 * 14 runs over two days, three repos (one with a very long name), two
 * factories, success / fail / running, a run that recovered through a fix
 * loop, several runs with a recorded cost of exactly 0 (subscription-backed
 * agents), a markdown request title, and one run with a full receipt.
 *
 * Times are relative to `nowMs`, so "Today" and "Yesterday" read naturally.
 */

import type { AgentSession, HealthResponse, HostedFactory, Phase, ReceiptEvidenceItem, ReceiptJson, ReceiptsRunResponse, Session, SessionSummary } from "./types.js";

export const DEMO_REPO_API = "github.com/acme/api";
export const DEMO_REPO_WEB = "github.com/acme/web";
export const DEMO_REPO_SPF = "github.com/seesharpguy/super-portable-software-factory";
/** The receipt store keys by repo segment (segmentFromSlug of the slug), never the full slug. */
const DEMO_RECEIPT_REPO_SEGMENT = "seesharpguy--super-portable-software-factory";
export const DEMO_REPOS = [DEMO_REPO_API, DEMO_REPO_WEB, DEMO_REPO_SPF];

/** The one run that carries a full receipt: before FAIL 28/36, after PASS 36/36. */
export const DEMO_RECEIPT_RUN = "7ec31b90";

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const FACTORIES = {
  laptop: { id: "f-3a1c", name: "jd@laptop", repo: DEMO_REPO_SPF, syncedSecAgo: 6 },
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
  { adw_id: "a1b2c3d4", factory: "laptop", repo: DEMO_REPO_SPF, chain: "plan + build-test", request: "Add cursor pagination to /v1/runs", status: "running", startedMinAgo: 6, durationMin: 6, cost: 0.84, tokens: 212_400, phases: [["plan", "success"], ["build", "running"], ["test", "queued"]] },
  { adw_id: "c0ffee01", factory: "laptop", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Dark-mode contrast pass on the settings page", status: "running", startedMinAgo: 14, durationMin: 14, cost: 0, tokens: 301_900, phases: [["plan", "success"], ["build", "success"], ["review", "running"]] },
  { adw_id: "dead0042", factory: "ci", repo: DEMO_REPO_API, chain: "plan + build-test", request: "Bump undici to patch CVE-2026-1182", status: "success", startedMinAgo: 55, durationMin: 12, cost: 0.31, tokens: 88_000, phases: ok(...PLAN_BUILD, "test") },
  // Failed phase, fix loop, then green: the "recovered" shape.
  { adw_id: "fb1x0042", factory: "ci", repo: DEMO_REPO_API, chain: "plan + build-test", request: "Retry flaky webhook delivery with backoff", status: "success", startedMinAgo: 95, durationMin: 41, cost: 3.05, tokens: 702_100, phases: [["plan", "success"], ["build", "success"], ["test", "fail", 1], ["fix", "success", 1], ["test", "success", 2], ["review", "success"]] },
  { adw_id: "5f6a7b8c", factory: "laptop", repo: DEMO_REPO_SPF, chain: "plan + build-test", request: "## Problem\n\nThe timetable list shows `$0.0000` for runs billed through a subscription.\n\n## Expected\n\nShow a dash and explain it in a tooltip.", status: "success", startedMinAgo: 130, durationMin: 18, cost: 0, tokens: 244_300, phases: ok(...PLAN_BUILD, "test", "review") },
  { adw_id: "e44d9a10", factory: "ci", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Replace moment with date-fns in the calendar widget", status: "fail", startedMinAgo: 190, durationMin: 21, cost: 2.4, tokens: 540_300, phases: [["plan", "success"], ["build", "success"], ["test", "fail"]] },
  { adw_id: DEMO_RECEIPT_RUN, factory: "laptop", repo: DEMO_REPO_SPF, chain: "prove + fix", request: "Fix the receipts viewer so the checks table keeps its header on scroll", status: "success", startedMinAgo: 260, durationMin: 52, cost: 1.92, tokens: 455_800, phases: [["prove_base", "success"], ["build", "success"], ["prove_1", "success"]] },
  { adw_id: "3b9c0e77", factory: "laptop", repo: DEMO_REPO_WEB, chain: "scout", request: "Where do we parse the session cookie? List every call site.", status: "success", startedMinAgo: 340, durationMin: 4, cost: 0, tokens: 41_200, phases: ok("scout") },
  { adw_id: "9a8b7c6d", factory: "ci", repo: DEMO_REPO_API, chain: "plan + build-test", request: "Index sessions(repo, started_at) for the hosted list", status: "success", startedMinAgo: 1500, durationMin: 9, cost: 0.46, tokens: 120_800, phases: ok(...PLAN_BUILD) },
  { adw_id: "1d2e3f40", factory: "laptop", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Skeleton loaders for the dashboard grid", status: "success", startedMinAgo: 1700, durationMin: 18, cost: 1.6, tokens: 388_000, phases: ok(...PLAN_BUILD, "test") },
  { adw_id: "77aa1c02", factory: "laptop", repo: DEMO_REPO_SPF, chain: "plan + build-test", request: "Teach `spf doctor` to flag a stale protected_files pattern", status: "fail", startedMinAgo: 1800, durationMin: 27, cost: 0, tokens: 330_600, phases: [["plan", "success"], ["build", "success"], ["test", "fail"]] },
  { adw_id: "0c0c5d19", factory: "ci", repo: DEMO_REPO_API, chain: "refine", request: "Split the billing epic into reviewable tickets", status: "success", startedMinAgo: 1900, durationMin: 6, cost: 0.12, tokens: 52_000, phases: ok("refine") },
  { adw_id: "62f1b7e3", factory: "laptop", repo: DEMO_REPO_SPF, chain: "plan + build-test", request: "Document the hub sync key rotation", status: "success", startedMinAgo: 2050, durationMin: 14, cost: 0, tokens: 176_400, phases: ok(...PLAN_BUILD, "review") },
  { adw_id: "d3adbe3f", factory: "ci", repo: DEMO_REPO_WEB, chain: "plan + build-test", request: "Migrate the avatar upload to presigned URLs", status: "success", startedMinAgo: 2300, durationMin: 33, cost: 0.0042, tokens: 9_800, phases: ok(...PLAN_BUILD, "test") },
];

function buildPhase(adw: string, step: Step, seq: number, startMs: number): Phase {
  const [name, status, attempt] = step;
  return {
    phase_id: `${adw}-p${seq}`,
    adw_id: adw,
    seq,
    name,
    kind: name === "test" || name.startsWith("prove") ? "code" : "agent",
    owner: name === "test" || name.startsWith("prove") ? null : "builder",
    description: null,
    status,
    attempt: attempt ?? 1,
    retries: (attempt ?? 1) - 1,
    error: status === "fail" ? "1 gate failed" : null,
    started_at: status === "queued" ? null : iso(startMs),
    ended_at: status === "success" || status === "fail" ? iso(startMs + 2 * MIN) : null,
  };
}

export function demoFactories(nowMs: number): HostedFactory[] {
  return Object.values(FACTORIES).map((f) => ({ id: f.id, name: f.name, repo: f.repo, last_seen_at: iso(nowMs - f.syncedSecAgo * 1000) }));
}

export function demoSessions(nowMs: number): SessionSummary[] {
  return SEEDS.map((s) => {
    const f = FACTORIES[s.factory];
    const start = nowMs - s.startedMinAgo * MIN;
    const phases = s.phases.map((step, i) => buildPhase(s.adw_id, step, i + 1, start + i * 2 * MIN));
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
      factory_id: f.id,
      factory_name: f.name,
      repo: s.repo,
    };
    return { ...session, phases, phase_count: phases.length, agents: [] as AgentSession[] };
  });
}

export function demoHealth(mode: "local" | "demo", nowMs: number): HealthResponse {
  if (mode === "local") {
    return { ok: true, db: "fixture", journal_mode: "wal", sessions: SEEDS.length, project: "super-portable-software-factory", repo: "seesharpguy/super-portable-software-factory", mode: "local" };
  }
  return { ok: true, db: "fixture", journal_mode: "d1", sessions: SEEDS.length, mode: "hosted", repos: DEMO_REPOS, factories: demoFactories(nowMs) };
}

// ── the receipt ──────────────────────────────────────────────────────────────

const SHA = "5522be3f0c1d9a4e7b2860d1a93c4f5e6b7a8c9d";
const evidence = (attempt: "base" | "head"): Record<string, ReceiptEvidenceItem> => ({
  poster: { key: `${DEMO_RECEIPT_RUN}/${attempt}/poster.svg`, content_type: "image/svg+xml", bytes: 640, sha256: "a".repeat(64) },
  contact_sheet: { key: `${DEMO_RECEIPT_RUN}/${attempt}/contact-sheet.svg`, content_type: "image/svg+xml", bytes: 640, sha256: "b".repeat(64) },
  transcript: { key: `${DEMO_RECEIPT_RUN}/${attempt}/transcript.txt`, content_type: "text/plain", bytes: 420, sha256: "c".repeat(64) },
});

const JOURNEYS = ["open the receipt", "scroll the checks table", "switch attempts", "follow an evidence link"];
function checks(failing: number): ReceiptJson["checks"] {
  return Array.from({ length: 36 }, (_, i) => {
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

function receipt(stage: "base" | "head", nowMs: number): ReceiptJson {
  const base = stage === "base";
  return {
    schema: "spf.receipt/1",
    run_id: DEMO_RECEIPT_RUN,
    attempt: 1,
    repo: DEMO_RECEIPT_REPO_SEGMENT,
    issue: "227",
    stage,
    revision: { sha: base ? "045a840a1b2c3d4e5f60718293a4b5c6d7e8f901" : SHA, tree: base ? "9f8e7d6c5b4a" : "1a2b3c4d5e6f", dirty: false },
    verdict: base ? "FAIL" : "PASS",
    reason: base ? "8 of 36 checks failed before the change" : "All 36 checks pass after the change",
    next: [],
    at: new Date(nowMs - (base ? 250 : 215) * MIN).toISOString(),
    subject: { kind: "ui", detail: "receipts viewer" },
    journeys: JOURNEYS.map((id) => ({ id, criterion: id, steps: [{ name: "run", ms: 1800, exit: 0 }] })),
    checks: checks(base ? 8 : 0),
    evidence: evidence(stage),
  };
}

export function demoReceiptRun(runId: string, nowMs: number): ReceiptsRunResponse | null {
  if (runId !== DEMO_RECEIPT_RUN) return null;
  const b = receipt("base", nowMs);
  const h = receipt("head", nowMs);
  return {
    run_id: runId,
    repo: DEMO_RECEIPT_REPO_SEGMENT,
    base: { key: `${runId}/base/receipt.json`, attempt: 1, receipt: b },
    head: { key: `${runId}/head/receipt.json`, attempt: 1, receipt: h },
    attempts: [
      { attempt: 1, stage: "base", verdict: "FAIL", at: b.at, key: `${runId}/base/receipt.json`, checks: { total: 36, failed: 8 } },
      { attempt: 1, stage: "head", verdict: "PASS", at: h.at, key: `${runId}/head/receipt.json`, checks: { total: 36, failed: 0 } },
    ],
  };
}

const svg = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#ede8db"/><rect x="24" y="24" width="592" height="312" fill="none" stroke="#76705e"/><text x="320" y="190" text-anchor="middle" font-family="monospace" font-size="20" fill="#5f5948">${label}</text></svg>`;

/** The evidence files behind the receipt's links: small SVG stand-ins and a text transcript. No video. */
export function demoReceiptFile(runId: string, key: string): { contentType: string; text: string } | null {
  if (runId !== DEMO_RECEIPT_RUN) return null;
  if (key.endsWith(".svg")) return { contentType: "image/svg+xml", text: svg(key.includes("poster") ? "poster (fixture)" : "contact sheet (fixture)") };
  if (key.endsWith("transcript.txt")) return { contentType: "text/plain", text: "$ spf prove\nopen the receipt ... ok\nscroll the checks table ... ok\n36/36 checks pass\n" };
  return null;
}
