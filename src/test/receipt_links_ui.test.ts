import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { attemptForPhase, isProvePhase, loadReceipts, receiptKeyFromEvents, receiptRepoSegment, settledProveKey, summarizeReceipts, viewerHref } from "../ui/shared/receipt_links.js";
import type { ReceiptsRunResponse } from "../ui/shared/types.js";

const view = (attempt: number, verdict: "PASS" | "FAIL", pass: boolean[], evidence: Record<string, string> = {}) =>
  ({
    key: `r/attempts/run/${attempt}/receipt.json`,
    attempt,
    receipt: {
      verdict,
      checks: pass.map((p, i) => ({ journey: "j", name: `c${i}`, pass: p })),
      evidence: Object.fromEntries(Object.entries(evidence).map(([k, key]) => [k, { key }])),
    },
  }) as unknown as NonNullable<ReceiptsRunResponse["head"]>;

const att = (attempt: number, stage: "base" | "head") => ({ attempt, stage, verdict: "PASS", at: "", key: `k${attempt}`, checks: { total: 1, failed: 0 } }) as ReceiptsRunResponse["attempts"][number];

const run: ReceiptsRunResponse = {
  run_id: "issue-1",
  repo: "acme--api",
  base: view(1, "FAIL", [false, true, false], { poster: "b/poster.gif", video: "b/video.mp4" }),
  head: view(2, "PASS", [true, true, true], { poster: "h/poster.gif", video: "h/video.mp4" }),
  attempts: [att(1, "base"), att(2, "head"), att(3, "head")],
};

describe("receipt links", () => {
  test("repo segment drops the host and joins with --", () => {
    assert.equal(receiptRepoSegment("github.com/Acme/API"), "acme--api");
    assert.equal(receiptRepoSegment(null), null);
    assert.equal(receiptRepoSegment("github.com"), null);
  });

  test("prove phases", () => {
    assert.ok(isProvePhase("prove_base") && isProvePhase("prove_2"));
    assert.ok(!isProvePhase("prove") && !isProvePhase("test_1") && !isProvePhase(null));
  });

  test("summary reads before/after, head poster and video", () => {
    const s = summarizeReceipts(run);
    assert.deepEqual(s?.before, { verdict: "FAIL", total: 3, failed: 2 });
    assert.deepEqual(s?.after, { verdict: "PASS", total: 3, failed: 0 });
    assert.equal(s?.posterKey, "h/poster.gif");
    assert.equal(s?.videoKey, "h/video.mp4");
    assert.equal(summarizeReceipts({ ...run, base: null, head: null }), null);
  });

  test("prove_base is the base attempt, prove_n the n-th head attempt", () => {
    assert.equal(attemptForPhase("prove_base", run)?.attempt, 1);
    assert.equal(attemptForPhase("prove_1", run)?.attempt, 2);
    assert.equal(attemptForPhase("prove_2", run)?.attempt, 3);
    assert.equal(attemptForPhase("prove_3", run), null);
    assert.equal(attemptForPhase("build", run), null);
    assert.equal(attemptForPhase("prove_1", null), null);
  });

  test("viewer href honors the mount base and encodes", () => {
    assert.equal(viewerHref("", "issue-1"), "/r/issue-1");
    assert.equal(viewerHref("/spf", "issue-1", "acme--api", "a/b c.mp4"), "/spf/r/issue-1?repo=acme--api&key=a%2Fb%20c.mp4");
  });
});

const fail = (status: number, message = "x", candidates: string[] = []) => Object.assign(new Error(message), { status, candidates });

describe("receipt key from a prove phase's own events", () => {
  const log = (receipt: unknown) => ({ type: "log", payload_json: JSON.stringify({ receipt }) });
  test("the recorded key wins over ordinal mapping; the last log wins", () => {
    assert.equal(receiptKeyFromEvents([log("r/attempts/run/2/receipt.json"), { type: "tool_call", payload_json: "{}" }]), "r/attempts/run/2/receipt.json");
    assert.equal(receiptKeyFromEvents([log("a"), log("b")]), "b");
  });
  test("no key when absent, truncated or not a string", () => {
    assert.equal(receiptKeyFromEvents([]), null);
    assert.equal(receiptKeyFromEvents([{ type: "log", payload_json: "{bad" }, { type: "log", payload_json: null }, log(3)]), null);
  });
});

describe("refetch trigger", () => {
  const ph = (name: string, status: string, ended_at: string | null) => ({ name, status, ended_at });
  test("a starting prove phase does not change the key; a finished one does", () => {
    const running = [ph("prove_base", "success", "t1"), ph("prove_1", "running", null)];
    const done = [ph("prove_base", "success", "t1"), ph("prove_1", "fail", "t2")];
    assert.equal(settledProveKey(running), "prove_base@t1");
    assert.notEqual(settledProveKey(running), settledProveKey(done));
    assert.equal(settledProveKey([ph("build", "success", "t0")]), "");
  });
});

describe("loadReceipts state machine", () => {
  test("ready", async () => {
    const r = await loadReceipts(async () => run, "issue-1", "acme--api");
    assert.equal(r.state, "ready");
  });
  test("404 no receipt store and 503 are off", async () => {
    assert.equal((await loadReceipts(async () => { throw fail(404, "no receipt store"); }, "i", null)).state, "off");
    assert.equal((await loadReceipts(async () => { throw fail(503); }, "i", null)).state, "off");
  });
  test("409 carries the candidates", async () => {
    const r = await loadReceipts(async () => { throw fail(409, "many", ["a--b", "c--d"]); }, "i", null);
    assert.deepEqual(r, { state: "conflict", candidates: ["a--b", "c--d"] });
  });
  test("404 under a repo retries without it (legacy segment)", async () => {
    const seen: Array<string | null> = [];
    const r = await loadReceipts(async (_id, repo) => {
      seen.push(repo);
      if (repo) throw fail(404, "no receipt for issue-1");
      return run;
    }, "issue-1", "acme--api");
    assert.equal(r.state, "ready");
    assert.deepEqual(seen, ["acme--api", null]);
  });
  test("404 with no repo, or on the retry, is none", async () => {
    const nf = async () => { throw fail(404, "no receipt for i"); };
    assert.equal((await loadReceipts(nf, "i", null)).state, "none");
    assert.equal((await loadReceipts(nf, "i", "a--b")).state, "none");
  });
  test("a retry that conflicts reports the conflict", async () => {
    const r = await loadReceipts(async (_i, repo) => { throw repo ? fail(404, "no receipt") : fail(409, "many", ["x"]); }, "i", "a--b");
    assert.equal(r.state, "conflict");
  });
  test("other failures are none, not off", async () => {
    assert.equal((await loadReceipts(async () => { throw fail(500); }, "i", null)).state, "none");
  });
});
