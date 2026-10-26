/**
 * `core/receipt_store.ts` (#159, slice 1).
 *
 *  - SigV4: checked against the worked examples in AWS's S3 SigV4
 *    documentation (a presigned GET and a header-signed GET with a Range
 *    header), so the hand-rolled signer is pinned to AWS's own numbers,
 *    not just to itself.
 *  - Keys: everything that could escape the store's root is refused.
 *  - LocalReceiptStore: real files in a temp dir.
 *  - S3ReceiptStore: a MOCKED fetch — URL shapes (AWS virtual-hosted, R2 /
 *    MinIO path-style), prefixes, list pagination, 404s, errors.
 *  - Live S3-compatible round trip: only when PIQUETTE_TEST_S3_ENDPOINT is set
 *    (e.g. a local MinIO); skipped otherwise, never a network call in CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  assertKey,
  createReceiptStore,
  LocalReceiptStore,
  MAX_PRESIGN_SECONDS,
  presignUrl,
  probeReceiptStore,
  promoteRun,
  S3ReceiptStore,
  signHeaders,
  uriEncode,
  type S3Credentials,
} from "../core/receipt_store.js";
import { S3ReceiptStoreSchema, SFConfigSchema, type S3ReceiptStoreConfig } from "../core/data_types.js";

// AWS's documentation example credentials (not a real key).
const AWS_DOC_CREDS: S3Credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AWS_DOC_NOW = new Date("2013-05-24T00:00:00Z");
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ── SigV4 against AWS's published examples ─────────────────────────────────

test("presignUrl reproduces AWS's documented presigned-URL example", () => {
  const url = presignUrl({
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    credentials: AWS_DOC_CREDS,
    now: AWS_DOC_NOW,
    expiresSeconds: 86400,
  });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  assert.match(url, /X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request/);
});

test("signHeaders reproduces AWS's documented GET-object (Range) example", () => {
  const headers = signHeaders({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    credentials: AWS_DOC_CREDS,
    now: AWS_DOC_NOW,
    headers: { Range: "bytes=0-9" },
    payloadHash: EMPTY_SHA256,
  });
  assert.equal(
    headers["authorization"],
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.equal(headers["host"], undefined, "fetch sets Host itself");
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
});

test("signHeaders adds the session token header (and signs it) for temporary credentials", () => {
  const headers = signHeaders({
    method: "GET",
    url: new URL("https://b.s3.us-east-1.amazonaws.com/k"),
    region: "us-east-1",
    credentials: { ...AWS_DOC_CREDS, sessionToken: "tok" },
    now: AWS_DOC_NOW,
    payloadHash: EMPTY_SHA256,
  });
  assert.equal(headers["x-amz-security-token"], "tok");
  assert.match(headers["authorization"], /SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/);
});

test("presignUrl refuses an expiry past SigV4's 7-day cap", () => {
  const base = { url: new URL("https://b.s3.amazonaws.com/k"), region: "us-east-1", credentials: AWS_DOC_CREDS, now: AWS_DOC_NOW };
  assert.throws(() => presignUrl({ ...base, expiresSeconds: MAX_PRESIGN_SECONDS + 1 }), /7-day cap/);
  assert.throws(() => presignUrl({ ...base, expiresSeconds: 0 }), /7-day cap/);
});

test("uriEncode follows RFC 3986 the way SigV4 requires", () => {
  assert.equal(uriEncode("a b!'()*~._-"), "a%20b%21%27%28%29%2A~._-");
});

// ── keys ────────────────────────────────────────────────────────────────────

test("assertKey refuses keys that could escape the store", () => {
  for (const bad of ["", "/abs", "a/../b", "..", "a//b", "a/./b", "a\\b", "trailing/"]) {
    assert.throws(() => assertKey(bad), /receipt store key/, JSON.stringify(bad));
  }
  assert.equal(assertKey("piquette/attempts/run-1/1/video.mp4"), "piquette/attempts/run-1/1/video.mp4");
});

// ── LocalReceiptStore ───────────────────────────────────────────────────────

function tmpStore(): { dir: string; store: LocalReceiptStore } {
  const dir = mkdtempSync(join(tmpdir(), "piquette-receipt-store-test-"));
  return { dir, store: new LocalReceiptStore(join(dir, "receipts")) };
}

test("LocalReceiptStore: put returns the sha256 of the stored bytes; get/list/copy/delete round-trip", async () => {
  const { dir, store } = tmpStore();
  try {
    const put = await store.put("piquette/attempts/r1/1/receipt.json", '{"verdict":"PASS"}', "application/json");
    assert.equal(put.bytes, 18);
    assert.equal(put.sha256, createHash("sha256").update('{"verdict":"PASS"}').digest("hex"));
    assert.equal(new TextDecoder().decode((await store.get("piquette/attempts/r1/1/receipt.json"))!), '{"verdict":"PASS"}');
    assert.equal(await store.get("piquette/attempts/r1/1/missing.json"), null);

    await store.put("piquette/attempts/r1/1/video.mp4", new Uint8Array([1, 2, 3]), "video/mp4");
    await store.put("piquette/attempts/r2/1/receipt.json", "{}", "application/json");
    assert.deepEqual(await store.list("piquette/attempts/r1/"), ["piquette/attempts/r1/1/receipt.json", "piquette/attempts/r1/1/video.mp4"]);
    assert.deepEqual(await store.list("nothing/"), []);

    await store.copy("piquette/attempts/r1/1/video.mp4", "piquette/kept/r1/1/video.mp4");
    assert.deepEqual([...(await store.get("piquette/kept/r1/1/video.mp4"))!], [1, 2, 3]);

    await store.delete("piquette/attempts/r2/1/receipt.json");
    await store.delete("piquette/attempts/r2/1/receipt.json"); // idempotent
    assert.equal(await store.get("piquette/attempts/r2/1/receipt.json"), null);

    assert.match(await store.signedUrl("piquette/kept/r1/1/video.mp4", 300), /^file:\/\/.*\/piquette\/kept\/r1\/1\/video\.mp4$/);
    await assert.rejects(store.signedUrl("piquette/kept/r1/1/nope.mp4", 300));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promoteRun copies a run's attempts into kept/ and leaves the attempts in place", async () => {
  const { dir, store } = tmpStore();
  try {
    await store.put("piquette/attempts/run-9/1/receipt.json", "{}", "application/json");
    await store.put("piquette/attempts/run-9/2/receipt.json", "{}", "application/json");
    await store.put("piquette/attempts/run-90/1/receipt.json", "{}", "application/json"); // "run-90" starts with "run-9": the trailing "/" keeps it out
    const kept = await promoteRun(store, "piquette", "run-9");
    assert.deepEqual(kept, ["piquette/kept/run-9/1/receipt.json", "piquette/kept/run-9/2/receipt.json"]);
    assert.equal((await store.list("piquette/attempts/run-9/")).length, 2);
    assert.deepEqual(await store.list("piquette/kept/"), kept);
    await assert.rejects(promoteRun(store, "piquette", "a/b"), /single key segments/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeReceiptStore round-trips a probe object and leaves nothing behind", async () => {
  const { dir, store } = tmpStore();
  try {
    const result = await probeReceiptStore(store);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await store.list(""), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── S3ReceiptStore (mocked fetch) ───────────────────────────────────────────

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

function fakeFetch(handler: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as Uint8Array | undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const s3Config = (over: Record<string, unknown>): S3ReceiptStoreConfig => v.parse(S3ReceiptStoreSchema, { kind: "s3", bucket: "piquette-receipts", ...over });
const CREDS: S3Credentials = { accessKeyId: "AKID", secretAccessKey: "SECRET" };
const NOW = () => new Date("2026-10-21T12:00:00Z");

test("S3ReceiptStore on AWS: virtual-hosted URL, signed PUT carrying the body's sha256 and content-type", async () => {
  const { fetch, calls } = fakeFetch(() => new Response("", { status: 200 }));
  const store = new S3ReceiptStore(s3Config({ region: "eu-west-1", prefix: "receipts" }), CREDS, fetch, NOW);
  const put = await store.put("piquette/attempts/r1/1/video.mp4", new Uint8Array([9, 9]), "video/mp4");
  const call = calls[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.url, "https://piquette-receipts.s3.eu-west-1.amazonaws.com/receipts/piquette/attempts/r1/1/video.mp4");
  assert.equal(call.headers["content-type"], "video/mp4");
  assert.equal(call.headers["x-amz-content-sha256"], put.sha256);
  assert.match(call.headers["authorization"], /^AWS4-HMAC-SHA256 Credential=AKID\/20261021\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.match(store.location, /^s3:\/\/piquette-receipts\/receipts \(aws eu-west-1\)$/);
});

test("S3ReceiptStore on R2/MinIO: an endpoint means path-style, region auto", async () => {
  const { fetch, calls } = fakeFetch(() => new Response("", { status: 200 }));
  const store = new S3ReceiptStore(
    s3Config({ endpoint: "https://acct123.r2.cloudflarestorage.com", region: "auto" }),
    CREDS,
    fetch,
    NOW,
  );
  await store.put("piquette/a b/receipt.json", "{}", "application/json");
  assert.equal(calls[0].url, "https://acct123.r2.cloudflarestorage.com/piquette-receipts/piquette/a%20b/receipt.json");
  assert.match(calls[0].headers["authorization"], /\/20261021\/auto\/s3\/aws4_request/);
  const url = await store.signedUrl("piquette/a b/receipt.json", 300);
  assert.match(url, /^https:\/\/acct123\.r2\.cloudflarestorage\.com\/piquette-receipts\/piquette\/a%20b\/receipt\.json\?X-Amz-Algorithm=AWS4-HMAC-SHA256&/);
  assert.match(url, /X-Amz-Expires=300/);
});

test("S3ReceiptStore on R2: presigned URL is path-style and scoped to region auto", async () => {
  const store = new S3ReceiptStore(s3Config({ endpoint: "https://acct.r2.cloudflarestorage.com", region: "auto" }), CREDS, undefined, NOW);
  const url = await store.signedUrl("issue-198/attempts/issue-198/2/video.mp4", 600);
  assert.match(url, /^https:\/\/acct\.r2\.cloudflarestorage\.com\/piquette-receipts\/issue-198\/attempts\/issue-198\/2\/video\.mp4\?/);
  assert.match(decodeURIComponent(new URL(url).searchParams.get("X-Amz-Credential") ?? ""), /\/auto\/s3\/aws4_request$/);
});

test("S3ReceiptStore refuses a dotted bucket in virtual-hosted mode instead of producing a broken TLS host", () => {
  assert.throws(() => new S3ReceiptStore(s3Config({ bucket: "my.bucket" }), CREDS), /force_path_style/);
  assert.doesNotThrow(() => new S3ReceiptStore(s3Config({ bucket: "my.bucket", force_path_style: true }), CREDS));
});

test("S3ReceiptStore.get: 404 is null, other errors carry the S3 error code", async () => {
  const { fetch } = fakeFetch((call) =>
    call.url.endsWith("/missing")
      ? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
      : new Response("<Error><Code>AccessDenied</Code><Message>no &amp; never</Message></Error>", { status: 403 }),
  );
  const store = new S3ReceiptStore(s3Config({ endpoint: "http://127.0.0.1:9000" }), CREDS, fetch, NOW);
  assert.equal(await store.get("missing"), null);
  await assert.rejects(store.get("secret"), /HTTP 403 AccessDenied: no & never/);
});

test("S3ReceiptStore.list pages through ListObjectsV2 and strips the configured prefix", async () => {
  const page1 = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok/1+=</NextContinuationToken>
    <Contents><Key>p/piquette/attempts/r1/1/b.json</Key></Contents><Contents><Key>p/piquette/attempts/r1/1/a&amp;b.json</Key></Contents></ListBucketResult>`;
  const page2 = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/piquette/attempts/r1/2/c.json</Key></Contents></ListBucketResult>`;
  const { fetch, calls } = fakeFetch((call) => new Response(new URL(call.url).searchParams.get("continuation-token") ? page2 : page1));
  const store = new S3ReceiptStore(s3Config({ endpoint: "http://127.0.0.1:9000", prefix: "p" }), CREDS, fetch, NOW);
  assert.deepEqual(await store.list("piquette/attempts/r1/"), [
    "piquette/attempts/r1/1/a&b.json",
    "piquette/attempts/r1/1/b.json",
    "piquette/attempts/r1/2/c.json",
  ]);
  assert.equal(calls.length, 2);
  const q1 = new URL(calls[0].url).searchParams;
  assert.equal(q1.get("list-type"), "2");
  assert.equal(q1.get("prefix"), "p/piquette/attempts/r1/");
  assert.equal(new URL(calls[1].url).searchParams.get("continuation-token"), "tok/1+=");
});

test("S3ReceiptStore.copy signs x-amz-copy-source and treats a 200 <Error> body as a failure", async () => {
  let fail = false;
  const { fetch, calls } = fakeFetch(() =>
    new Response(fail ? "<Error><Code>InternalError</Code><Message>try again</Message></Error>" : "<CopyObjectResult/>", { status: 200 }),
  );
  const store = new S3ReceiptStore(s3Config({ endpoint: "http://127.0.0.1:9000" }), CREDS, fetch, NOW);
  await store.copy("piquette/attempts/r1/1/v.mp4", "piquette/kept/r1/1/v.mp4");
  assert.equal(calls[0].headers["x-amz-copy-source"], "/piquette-receipts/piquette/attempts/r1/1/v.mp4");
  assert.match(calls[0].headers["authorization"], /x-amz-copy-source/);
  fail = true;
  await assert.rejects(store.copy("a", "b"), /InternalError try again/);
});

// ── construction + config ───────────────────────────────────────────────────

test("createReceiptStore names the missing env var instead of sending unsigned requests", () => {
  const cfg = s3Config({ access_key_id_env: "PIQUETTE_TEST_UNSET_KEY_ID", secret_access_key_env: "PIQUETTE_TEST_UNSET_SECRET" });
  delete process.env.PIQUETTE_TEST_UNSET_KEY_ID;
  assert.throws(() => createReceiptStore(cfg), /PIQUETTE_TEST_UNSET_KEY_ID/);
});

test("createReceiptStore resolves a relative local path against the repo root", () => {
  const store = createReceiptStore({ kind: "local", path: ".piquette/data/receipts" }, { repoRoot: "/tmp/repo" });
  assert.equal(store.location, "/tmp/repo/.piquette/data/receipts");
});

test("config: receipts is off by default; local is the default store; s3 needs a bucket", () => {
  assert.equal(v.parse(SFConfigSchema, {}).receipts, undefined);
  assert.deepEqual(v.parse(SFConfigSchema, { receipts: {} }).receipts?.store, { kind: "local", path: ".piquette/data/receipts" });
  const r2 = v.parse(SFConfigSchema, {
    receipts: {
      store: { kind: "s3", bucket: "piquette-receipts", endpoint: "https://a.r2.cloudflarestorage.com", region: "auto", access_key_id_env: "R2_ACCESS_KEY_ID", secret_access_key_env: "R2_SECRET_ACCESS_KEY" },
      viewer_url: "https://receipts.example.com",
    },
  }).receipts!;
  assert.equal(r2.store.kind, "s3");
  assert.equal(r2.store.kind === "s3" && r2.store.prefix, "");
  assert.equal(v.safeParse(SFConfigSchema, { receipts: { store: { kind: "s3" } } }).success, false);
  assert.equal(v.safeParse(SFConfigSchema, { receipts: { store: { kind: "gcs", bucket: "x" } } }).success, false);
});

// ── live S3-compatible round trip (opt-in) ─────────────────────────────────

const LIVE = process.env.PIQUETTE_TEST_S3_ENDPOINT;
test("live S3-compatible store: put/get/list/copy/presign/delete (set PIQUETTE_TEST_S3_ENDPOINT, e.g. a local MinIO)", { skip: !LIVE && "PIQUETTE_TEST_S3_ENDPOINT not set" }, async () => {
  const store = createReceiptStore(
    v.parse(S3ReceiptStoreSchema, {
      kind: "s3",
      bucket: process.env.PIQUETTE_TEST_S3_BUCKET ?? "piquette-receipts-test",
      endpoint: LIVE,
      region: process.env.PIQUETTE_TEST_S3_REGION ?? "us-east-1",
      prefix: `test-${Date.now()}`,
      access_key_id_env: "PIQUETTE_TEST_S3_ACCESS_KEY_ID",
      secret_access_key_env: "PIQUETTE_TEST_S3_SECRET_ACCESS_KEY",
    }),
  );
  const probe = await probeReceiptStore(store);
  assert.equal(probe.ok, true, JSON.stringify(probe));

  const key = "piquette/attempts/live-run/1/hello world.txt";
  const put = await store.put(key, "hello receipts", "text/plain");
  assert.equal(new TextDecoder().decode((await store.get(key))!), "hello receipts");
  const kept = await promoteRun(store, "piquette", "live-run");
  assert.deepEqual(kept, ["piquette/kept/live-run/1/hello world.txt"]);

  const response = await fetch(await store.signedUrl(key, 60));
  assert.equal(response.status, 200);
  const body = new Uint8Array(await response.arrayBuffer());
  assert.equal(body.byteLength, put.bytes);

  for (const k of [key, ...kept]) await store.delete(k);
  assert.deepEqual(await store.list("piquette/"), []);
});

test("promoteRun copies nested journey evidence keys (#235)", async () => {
  const { dir, store } = tmpStore();
  try {
    await store.put("piquette/attempts/run-9/1/receipt.json", "{}", "application/json");
    await store.put("piquette/attempts/run-9/1/evidence/P01/x.mp4", "vid", "video/mp4");
    const kept = await promoteRun(store, "piquette", "run-9");
    assert.deepEqual(kept, ["piquette/kept/run-9/1/evidence/P01/x.mp4", "piquette/kept/run-9/1/receipt.json"]);
    assert.equal(new TextDecoder().decode((await store.get("piquette/kept/run-9/1/evidence/P01/x.mp4"))!), "vid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
