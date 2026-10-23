import "./hermetic_git.js";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Receipt } from "../core/receipt.js";
import type { ReceiptReader } from "../ui/server/receipt_reader.js";
import { LocalReceiptReader } from "../ui/server/receipt_reader_node.js";
import { R2ReceiptReader } from "../ui/server/receipt_reader_r2.js";
import { receiptRoutes } from "../ui/server/receipt_routes.js";
import type { ReceiptJson, ReceiptsRunResponse } from "../ui/shared/types.js";
import { fakeR2, runObjects, sha, VIDEO, writeLocal, type FixtureObjects } from "./receipt_fixture.js";

// Compile-time: core's Receipt is assignable to the SPA's structural mirror.
const _assignable = (r: Receipt): ReceiptJson => r;
void _assignable;

const RUN = "run-1";
const VIDEO_KEY = `r/attempts/${RUN}/2/video.mp4`;

/** The route contract any `ReceiptReader` must satisfy. Reused by #204 for the Worker's R2 reader. */
export function routeContract(name: string, makeReader: (objects: FixtureObjects) => { reader: ReceiptReader; cleanup?: () => void }): void {
  describe(`receipt routes over ${name}`, () => {
    const cleanups: Array<() => void> = [];
    after(() => cleanups.forEach((f) => f()));
    const appFor = (objects: FixtureObjects) => {
      const { reader, cleanup } = makeReader(objects);
      if (cleanup) cleanups.push(cleanup);
      return new Hono().route("/", receiptRoutes(() => reader));
    };
    const standard = () => appFor(runObjects("r", RUN));
    const file = (key: string, extra = "") => `/api/receipts/${RUN}/file?key=${encodeURIComponent(key)}${extra}`;

    test("run shape", async () => {
      const res = await standard().request(`/api/receipts/${RUN}`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as ReceiptsRunResponse;
      assert.equal(body.run_id, RUN);
      assert.equal(body.repo, "r");
      assert.equal(body.attempts.length, 2);
      assert.deepEqual(body.attempts.map((a) => [a.attempt, a.stage, a.verdict]), [[1, "base", "FAIL"], [2, "head", "PASS"]]);
      assert.deepEqual(body.attempts[0].checks, { total: 3, failed: 1 });
      assert.equal(body.head?.attempt, 2);
      assert.equal(body.base?.key, `r/attempts/${RUN}/1/receipt.json`);
      assert.equal(body.head?.receipt.evidence["video"].key, VIDEO_KEY);
    });

    test("404 for an unknown run, a null reader, another run's key, and an unlisted file", async () => {
      const app = standard();
      assert.equal((await app.request("/api/receipts/nope")).status, 404);
      assert.equal((await app.request("/api/receipts/nope/file?key=r/attempts/nope/1/video.mp4")).status, 404);
      const none = new Hono().route("/", receiptRoutes(() => null));
      const res = await none.request(`/api/receipts/${RUN}`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "no receipt store" });

      const two = appFor({ ...runObjects("r", RUN), ...runObjects("r", "other") });
      assert.equal((await two.request(file("r/attempts/other/2/video.mp4"))).status, 404);
      assert.equal((await app.request(file(`r/attempts/${RUN}/2/secret.txt`))).status, 404);
      assert.equal((await app.request(file(`r/attempts/${RUN}/2/missing.bin`))).status, 404);
    });

    test("400 for a traversal run_id, a missing key and a traversal key", async () => {
      const app = standard();
      // the URL parser resolves a literal ".." before routing, so a run_id that reaches the handler is checked by shape
      assert.equal((await app.request("/api/receipts/bad%20id")).status, 400);
      assert.equal((await app.request("/api/receipts/x$y")).status, 400);
      assert.equal((await app.request(`/api/receipts/${RUN}?repo=..`)).status, 400);
      assert.ok([400, 404].includes((await app.request("/api/receipts/a%2Fb")).status)); // a slash never reaches a key
      assert.equal((await app.request(`/api/receipts/${RUN}?repo=../x`)).status, 400);
      assert.equal((await app.request(`/api/receipts/${RUN}/file`)).status, 400);
      assert.equal((await app.request(file(`r/attempts/${RUN}/../../../x`))).status, 400);
      assert.equal((await app.request(file("/etc/passwd"))).status, 400);
      assert.equal((await app.request(file("r\\x"))).status, 400);
    });

    test("full GET: 200 with accept-ranges, the receipt's content-type and etag", async () => {
      const res = await standard().request(file(VIDEO_KEY));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("accept-ranges"), "bytes");
      assert.equal(res.headers.get("content-type"), "video/mp4");
      assert.equal(res.headers.get("content-length"), "256");
      assert.equal(res.headers.get("etag"), `"${sha(VIDEO)}"`);
      assert.equal(res.headers.get("content-disposition"), "inline");
      assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...VIDEO]);
    });

    test("receipt.json itself is servable", async () => {
      const res = await standard().request(file(`r/attempts/${RUN}/2/receipt.json`));
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as ReceiptJson).run_id, RUN);
    });

    test("ranges: bounded, open-ended and suffix return 206 with exact bytes", async () => {
      const app = standard();
      const cases: Array<[string, string, number, number]> = [
        ["bytes=10-19", "bytes 10-19/256", 10, 20],
        ["bytes=250-", "bytes 250-255/256", 250, 256],
        ["bytes=-4", "bytes 252-255/256", 252, 256],
        ["bytes=250-9999", "bytes 250-255/256", 250, 256],
      ];
      for (const [range, contentRange, from, to] of cases) {
        const res = await app.request(file(VIDEO_KEY), { headers: { range } });
        assert.equal(res.status, 206, range);
        assert.equal(res.headers.get("content-range"), contentRange);
        assert.equal(res.headers.get("content-length"), String(to - from));
        assert.equal(res.headers.get("accept-ranges"), "bytes");
        assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...VIDEO.subarray(from, to)], range);
      }
    });

    test("an unsatisfiable range is 416 with bytes */256; a multi-range is ignored", async () => {
      const app = standard();
      const bad = await app.request(file(VIDEO_KEY), { headers: { range: "bytes=999-" } });
      assert.equal(bad.status, 416);
      assert.equal(bad.headers.get("content-range"), "bytes */256");
      assert.equal((await bad.arrayBuffer()).byteLength, 0);
      const multi = await app.request(file(VIDEO_KEY), { headers: { range: "bytes=0-1,4-5" } });
      assert.equal(multi.status, 200);
    });

    test("HEAD: headers and no body", async () => {
      const res = await standard().request(file(VIDEO_KEY), { method: "HEAD" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-length"), "256");
      assert.equal(res.headers.get("accept-ranges"), "bytes");
      assert.equal((await res.arrayBuffer()).byteLength, 0);
    });

    test("an evidence type outside the allowlist is served as octet-stream, always nosniff and sandboxed", async () => {
      const objects = runObjects("r", RUN);
      const key = `r/attempts/${RUN}/2/x.html`;
      objects[key] = "<script>1</script>";
      const rj = JSON.parse(objects[`r/attempts/${RUN}/2/receipt.json`] as string);
      rj.evidence["page"] = { key, content_type: "text/html", bytes: 18, sha256: sha("<script>1</script>") };
      objects[`r/attempts/${RUN}/2/receipt.json`] = JSON.stringify(rj);
      const res = await appFor(objects).request(file(key));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
      const txt = await standard().request(file(`r/attempts/${RUN}/2/terminal.txt`));
      assert.equal(txt.headers.get("content-type"), "text/plain; charset=utf-8");
    });

    test("a receipt with a null checks or no revision is skipped, not a 500", async () => {
      const objects = runObjects("r", RUN);
      const bad = (mut: (r: Record<string, unknown>) => void) => {
        const rj = JSON.parse(objects[`r/attempts/${RUN}/2/receipt.json`] as string);
        mut(rj);
        return { ...objects, [`r/attempts/${RUN}/3/receipt.json`]: JSON.stringify({ ...rj, attempt: 3 }) };
      };
      for (const mut of [(r: Record<string, unknown>) => (r["checks"] = null), (r: Record<string, unknown>) => delete r["revision"]]) {
        const res = await appFor(bad(mut)).request(`/api/receipts/${RUN}`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ReceiptsRunResponse;
        assert.deepEqual(body.attempts.map((a) => a.attempt), [1, 2]);
        assert.equal(body.head?.attempt, 2);
      }
    });

    test("409 with candidates when the run exists under two repos; repo= resolves it", async () => {
      const app = appFor({ ...runObjects("a", RUN), ...runObjects("b", RUN) });
      const res = await app.request(`/api/receipts/${RUN}`);
      assert.equal(res.status, 409);
      assert.deepEqual(((await res.json()) as { candidates: string[] }).candidates, ["a", "b"]);
      const ok = await app.request(`/api/receipts/${RUN}?repo=b`);
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as ReceiptsRunResponse).repo, "b");
      assert.equal((await app.request(file(`b/attempts/${RUN}/2/video.mp4`, "&repo=b"))).status, 200);
      assert.equal((await app.request(file(`b/attempts/${RUN}/2/video.mp4`))).status, 409);
    });

    test("a promoted (kept/) run is served from kept/", async () => {
      const app = appFor(runObjects("r", RUN, "kept"));
      const run = (await (await app.request(`/api/receipts/${RUN}`)).json()) as ReceiptsRunResponse;
      const key = run.head!.receipt.evidence["video"].key;
      assert.equal(key, `r/kept/${RUN}/2/video.mp4`);
      assert.equal((await app.request(file(key))).status, 200);
    });
  });
}

routeContract("LocalReceiptReader", (objects) => {
  const root = mkdtempSync(path.join(tmpdir(), "spf-receipt-routes-"));
  writeLocal(root, objects);
  return { reader: new LocalReceiptReader(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
});

routeContract("R2ReceiptReader (in-memory bucket)", (objects) => ({ reader: new R2ReceiptReader(fakeR2(objects, 2)) }));

test("a reader that throws surfaces to the caller (the app's onError turns it into 500), never a hang", async () => {
  const boom: ReceiptReader = {
    location: "boom",
    repos: async () => {
      throw new Error("store down");
    },
    list: async () => [],
    text: async () => null,
    head: async () => null,
    get: async () => null,
  };
  const app = new Hono().route("/", receiptRoutes(() => boom));
  app.onError((err, c) => c.json({ error: err.message }, 500));
  const res = await app.request("/api/receipts/run-1");
  assert.equal(res.status, 500);
});

describe("HEAD on the file route", () => {
  test("never opens the object", async () => {
    const bucket = fakeR2(runObjects("r", RUN), 2);
    const app = new Hono().route("/", receiptRoutes(() => new R2ReceiptReader(bucket)));
    const url = `/api/receipts/${RUN}/file?key=${encodeURIComponent(VIDEO_KEY)}`;
    const opened = () => bucket.calls.get.filter((g) => g.key === VIDEO_KEY).length;
    const res = await app.request(url, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "256");
    assert.equal(opened(), 0);
    const part = await app.request(url, { method: "HEAD", headers: { range: "bytes=0-9" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-length"), "10");
    assert.equal(part.headers.get("content-range"), "bytes 0-9/256");
    assert.equal(opened(), 0);
    await app.request(url);
    assert.equal(opened(), 1);
  });
});
