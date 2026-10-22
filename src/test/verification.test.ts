/**
 * `core/verification.ts` (#159, ticket D / #176): the definition of done as
 * plain-language reasons, the committed-tree check, the escalation text a
 * person reads, and the envelope a failed proof hands the builder.
 */
import "./hermetic_git.js"; // house rule
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { decideVerification, escalationText, loadNonNegotiables, receiptAsEnvelope, withCommit, type DecideInput } from "../core/verification.js";
import { RECEIPT_SCHEMA_VERSION, type Receipt, type Verdict } from "../core/receipt.js";
import { SFConfigSchema } from "../core/data_types.js";

const TREE = "c".repeat(40);
function receipt(stage: "base" | "head", verdict: Verdict, over: Partial<Receipt> = {}): Receipt {
  return {
    schema: RECEIPT_SCHEMA_VERSION,
    run_id: "run-1",
    attempt: 1,
    repo: "demo",
    issue: "179",
    stage,
    revision: { sha: "a".repeat(40), tree: TREE, dirty: true },
    verdict,
    reason: verdict === "PASS" ? "3 check(s) passed" : "1 of 3 check(s) failed",
    next: verdict === "PASS" ? [] : ['P03: printed 28 lines, at most 10 allowed'],
    at: "2026-10-22T12:00:00.000Z",
    subject: { kind: "console" },
    journeys: [{ id: "P03", criterion: "prints at most 10 lines", steps: [{ name: "spf nope", ms: 200, exit: 1 }] }],
    checks: [{ journey: "P03", name: "at most 10 lines", expected: "<= 10", actual: 28, pass: verdict === "PASS" }],
    judgments: [],
    observations: { coverage: { happy: 1, unhappy: 1, non_negotiable: 2 }, outputs: { P03: "unknown chain: nope\n…28 lines…" } },
    evidence: { video: { key: "demo/attempts/run-1/1/video.mp4", content_type: "video/mp4", bytes: 9, sha256: "b".repeat(64) } },
    ...over,
  };
}
const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  journeys: "/h/journeys.yaml",
  base: { receipt: receipt("base", "FAIL"), key: "demo/attempts/run-1/1/receipt.json" },
  head: { receipt: receipt("head", "PASS", { attempt: 2 }), key: "demo/attempts/run-1/2/receipt.json" },
  failedProofs: 0,
  maxFailedProofs: 3,
  expectNonNegotiables: true,
  expectRecording: true,
  ...over,
});

test("red before, green on the change, unhappy path, non-negotiables, recording → verified with no reasons", () => {
  const outcome = decideVerification(input());
  assert.equal(outcome.status, "verified");
  assert.deepEqual(outcome.reasons, []);
  assert.equal(outcome.head?.video, "demo/attempts/run-1/1/video.mp4");
});

test("every definition-of-done miss is its own plain-language reason", () => {
  const cases: Array<[string, Partial<DecideInput>, RegExp]> = [
    ["no journeys", { journeys: null, base: null, head: null }, /plan has no journeys/],
    ["already passing before", { base: { receipt: receipt("base", "PASS"), key: "k" } }, /already pass on the code before the change/],
    ["still failing after 3", { head: { receipt: receipt("head", "FAIL"), key: "k" }, failedProofs: 3 }, /still fails its own proof after 3 of 3 attempt\(s\)/],
    ["can't tell", { head: { receipt: receipt("head", "CANT_TELL", { reason: "recording failed: no frames" }), key: "k" } }, /couldn't tell: recording failed: no frames/],
    ["no unhappy path", { head: { receipt: receipt("head", "PASS", { observations: { coverage: { happy: 2, unhappy: 0, non_negotiable: 2 } } }), key: "k" } }, /No unhappy-path journey/],
    ["non-negotiables missing", { head: { receipt: receipt("head", "PASS", { observations: { coverage: { happy: 1, unhappy: 1, non_negotiable: 0 } } }), key: "k" } }, /non-negotiables weren't part of the proof/],
    ["no recording", { head: { receipt: receipt("head", "PASS", { evidence: {} }), key: "k" } }, /no recording to watch/],
    ["setup problem", { problems: ["The plan's journeys file couldn't be read: bad yaml"] }, /couldn't be read: bad yaml/],
  ];
  for (const [name, over, reason] of cases) {
    const outcome = decideVerification(input(over));
    assert.equal(outcome.status, "unverified", name);
    assert.match(outcome.reasons.join("\n"), reason, name);
  }
});

test("a proof that couldn't run gets ONE reason, not a second 'never ran' echo (seen on the #179 pilot PR)", () => {
  const outcome = decideVerification(
    input({
      base: null,
      head: null,
      problems: [
        "The proof before the change couldn't run: can't bind a proof to a revision: boom",
        "The proof of the change couldn't run: can't bind a proof to a revision: boom",
      ],
    }),
  );
  assert.equal(outcome.status, "unverified");
  assert.equal(outcome.reasons.length, 2);
  assert.doesNotMatch(outcome.reasons.join("\n"), /never ran/);
  // Without an explanation, the generic reasons still appear.
  assert.match(decideVerification(input({ base: null, head: null })).reasons.join("\n"), /before the change never ran[\s\S]*of the change never ran/);
});

test("withCommit: the committed tree must be the proved tree", () => {
  const verified = decideVerification(input());
  const same = withCommit(verified, "d".repeat(40), TREE);
  assert.equal(same.status, "verified");
  assert.deepEqual(same.committed, { commit: "d".repeat(40), tree: TREE, matches: true });

  const drifted = withCommit(verified, "d".repeat(40), "e".repeat(40));
  assert.equal(drifted.status, "unverified");
  assert.match(drifted.reasons.join("\n"), /isn't the code that was proved/);
});

test("escalationText asks a person to decide, says the work wasn't blocked, and points at the evidence", () => {
  const text = escalationText(decideVerification(input({ head: { receipt: receipt("head", "FAIL"), key: "demo/attempts/run-1/3/receipt.json" }, failedProofs: 3 })));
  assert.match(text, /Unverified — a person needs to decide/);
  assert.match(text, /was not blocked/);
  assert.match(text, /still fails its own proof after 3 of 3/);
  assert.match(text, /demo\/attempts\/run-1\/3\/receipt\.json/);
  assert.match(text, /video: `demo\/attempts\/run-1\/1\/video\.mp4`/);
  assert.match(text, /Decide: merge as it is, ask for a fix, or close it\./);
  assert.match(escalationText(decideVerification(input())), /^\*\*Verified\.\*\*/);
});

// ── ticket E: the receipt a person reads on the PR ─────────────────────────

test("the receipt table: before/after, check counts, failed proofs before the pass, and linked evidence with an expiry note", () => {
  const base = { receipt: receipt("base", "FAIL", { checks: [{ journey: "P01", name: "a", expected: 0, actual: 1, pass: false }, { journey: "P01", name: "b", expected: 0, actual: 0, pass: true }] }), key: "demo/attempts/run-1/1/receipt.json" };
  const head = { receipt: receipt("head", "PASS", { attempt: 3 }), key: "demo/attempts/run-1/3/receipt.json" };
  const outcome = {
    ...decideVerification(input({ base, head, failedProofs: 1 })),
    links: {
      "demo/attempts/run-1/3/receipt.json": { url: "https://r.example/receipt", expires: "2026-10-29T12:00:00.000Z" },
      "demo/attempts/run-1/1/video.mp4": { url: "https://r.example/video", expires: "2026-10-29T12:00:00.000Z" },
    },
  };
  const text = escalationText(withCommit(outcome, "d".repeat(40), TREE));
  assert.match(text, /^\*\*Verified\.\*\*/);
  assert.match(text, /\| Proof \| Code \| Result \| Evidence \|/);
  assert.match(text, /\| Before the change \| `a{12}` \+ uncommitted work \| \*\*FAIL\*\* · 1 of 2 checks failed \|/);
  assert.match(text, /\| The change \| `a{12}` \+ uncommitted work \| \*\*PASS\*\* · 1 of 1 checks passed · after 1 failed proof\(s\) \| \[receipt\]\(https:\/\/r\.example\/receipt\) · \[video\]\(https:\/\/r\.example\/video\) \|/);
  assert.match(text, /Committed `d{12}`: the code that was proved\./);
  assert.match(text, /_Evidence links expire 2026-10-29\._/);
  assert.doesNotMatch(text, /Decide:/, "a verified change asks for no decision");
});

test("local evidence is listed with its path; CAN'T TELL reads as words; a mismatched commit says so", () => {
  const head = { receipt: receipt("head", "CANT_TELL", { reason: "recording failed" }), key: "demo/attempts/run-1/2/receipt.json" };
  const outcome = { ...decideVerification(input({ head })), links: { "demo/attempts/run-1/2/receipt.json": { local: "/stores/demo/attempts/run-1/2/receipt.json" } } };
  const text = escalationText(withCommit(outcome, "d".repeat(40), "e".repeat(40)));
  assert.match(text, /\*\*CAN'T TELL\*\*/);
  assert.match(text, /Evidence on the machine that ran the proof \(local receipt store\):/);
  assert.match(text, /- the change — receipt: `\/stores\/demo\/attempts\/run-1\/2\/receipt\.json`/);
  assert.match(text, /Committed `d{12}`: \*\*not\*\* the code that was proved\./);
  assert.match(text, /Decide: merge as it is, ask for a fix, or close it\.$/);
});

test("reasons are tidied for a PR: the home directory becomes ~, long tool output is cut short", () => {
  const home = homedir();
  const long = `The proof of the change couldn't run: git failed in ${home}/.spf/watch/x/worktrees/issue-1: ${"z".repeat(400)}`;
  const text = escalationText(decideVerification(input({ head: null, problems: [long] })));
  const line = text.split("\n").find((l) => l.startsWith("- The proof of the change"))!;
  assert.ok(!line.includes(home), "no absolute home path in a PR");
  assert.match(line, /in ~\/\.spf\/watch\/x\/worktrees\/issue-1/);
  assert.ok(line.length <= 302 && line.endsWith("…"), `cut to a readable length (${line.length})`);
});

test("receiptAsEnvelope hands the builder the receipt's next steps and each failing journey's verbatim output", () => {
  const envelope = receiptAsEnvelope(receipt("head", "FAIL"), "demo/attempts/run-1/1/receipt.json");
  assert.equal(envelope.status, "fail");
  assert.equal(envelope.passed, false);
  assert.match(envelope.failures[0], /printed 28 lines/);
  assert.match(envelope.failures[1], /^P03 — prints at most 10 lines\n\$ spf nope\nunknown chain: nope/);
  assert.match(envelope.notes_for_next_agent, /Do not edit the journeys file/);
});

test("loadNonNegotiables: none yet at the default path; an explicitly configured missing file is an error", () => {
  const repo = mkdtempSync(join(tmpdir(), "spf-nn-test-"));
  try {
    assert.deepEqual(loadNonNegotiables(repo, v.parse(SFConfigSchema, {})), { specs: [], file: null });
    assert.throws(() => loadNonNegotiables(repo, v.parse(SFConfigSchema, { receipts: { non_negotiables: "rules.yaml" } })), /configured explicitly/);
    mkdirSync(join(repo, ".spf", "verify"), { recursive: true });
    writeFileSync(join(repo, ".spf", "verify", "non-negotiables.yaml"), "journeys:\n  - { id: help, criterion: c, run: 'true', expect: { exit: 0 } }\n");
    const nn = loadNonNegotiables(repo, v.parse(SFConfigSchema, {}));
    assert.equal(nn.specs[0].kind, "non_negotiable");
    assert.match(nn.file ?? "", /non-negotiables\.yaml$/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
