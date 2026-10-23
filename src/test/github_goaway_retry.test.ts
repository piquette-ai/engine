import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider } from "../core/issues/github_provider.js";
import { GitHubProjectsProvider } from "../core/issues/github_projects_provider.js";
import { isTransientError } from "../core/retry.js";

const goaway = () => new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET", message: 'HTTP/2: "GOAWAY" frame received with code 0' } });

type Step = "goaway" | { status?: number; body?: unknown };

function stub(steps: Step[]): { calls: Array<{ url: string; method: string }>; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  let i = 0;
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (step === "goaway") throw goaway();
    const status = step.status ?? 200;
    return { ok: status < 300, status, text: async () => JSON.stringify(step.body), json: async () => step.body } as unknown as Response;
  };
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const ISSUE = { number: 7, title: "t", body: "b", labels: [], state: "open", user: { login: "u" }, html_url: "x" };

test("isTransientError recognises a GOAWAY-shaped fetch failure, even without a code", () => {
  assert.equal(isTransientError(goaway()), true);
  assert.equal(isTransientError(new Error('HTTP/2: "GOAWAY" frame received with code 0')), true);
});

test("REST reads recover from one GOAWAY (gh GET, getIssue)", async () => {
  const p = new GitHubProvider("acme/w", "spf", "tok");
  const s = stub(["goaway", { body: [] }]);
  try {
    assert.deepEqual(await (p as any).gh("/repos/acme/w/issues/7/comments"), []);
    assert.equal(s.calls.length, 2);
  } finally { s.restore(); }
  const s2 = stub(["goaway", { body: ISSUE }]);
  try {
    assert.ok(await p.getIssue("7"));
    assert.equal(s2.calls.length, 2);
  } finally { s2.restore(); }
});

test("GraphQL query recovers from one GOAWAY; mutation is not retried", async () => {
  const p = new GitHubProjectsProvider("acme/w", "spf", "tok", { projectNumber: 5, owner: "acme" } as any);
  const s = stub(["goaway", { body: { data: { ok: 1 } } }]);
  try {
    assert.deepEqual(await (p as any).ghGraphql("query($a: Int) { x }", {}), { ok: 1 });
    assert.equal(s.calls.length, 2);
  } finally { s.restore(); }
  const s2 = stub(["goaway", { body: { data: { ok: 1 } } }]);
  try {
    await assert.rejects((p as any).ghGraphql("mutation { x }", {}), /fetch failed/);
    assert.equal(s2.calls.length, 1);
  } finally { s2.restore(); }
});

test("a write (POST) is not duplicated after GOAWAY", async () => {
  const p = new GitHubProvider("acme/w", "spf", "tok");
  const s = stub(["goaway", { body: { id: 1 } }]);
  try {
    await assert.rejects((p as any).gh("/repos/acme/w/issues/7/comments", { method: "POST", body: "{}" }), /fetch failed/);
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
});

test("a persistent failure surfaces the original error after one retry", async () => {
  const p = new GitHubProvider("acme/w", "spf", "tok");
  const s = stub(["goaway"]);
  try {
    await assert.rejects((p as any).gh("/x"), (e: any) => e instanceof TypeError && (e.cause as any)?.code === "UND_ERR_SOCKET");
    assert.equal(s.calls.length, 2);
  } finally { s.restore(); }
});

test("a non-transient HTTP error is not retried", async () => {
  const p = new GitHubProvider("acme/w", "spf", "tok");
  const s = stub([{ status: 404, body: {} }]);
  try {
    await assert.rejects((p as any).gh("/x"), /404/);
    assert.equal(s.calls.length, 1);
  } finally { s.restore(); }
});

test("a label DELETE is retried once on GOAWAY (resending it is safe: a repeat answers 404); other DELETEs are not", async () => {
  const { isLabelDelete } = await import("../core/issues/github_provider.js");
  assert.equal(isLabelDelete("/repos/o/r/issues/12/labels/spf%3Aworking", "DELETE"), true);
  assert.equal(isLabelDelete("/repos/o/r/issues/12/labels/spf%3Aworking", "delete"), true);
  assert.equal(isLabelDelete("/repos/o/r/issues/12/labels/spf%3Aworking", "POST"), false);
  assert.equal(isLabelDelete("/repos/o/r/issues/comments/99", "DELETE"), false);
  assert.equal(isLabelDelete("/repos/o/r/issues/12/labels", "DELETE"), false);
});
