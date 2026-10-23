/**
 * Receipt store (#159, slice 1): where verification receipts and their
 * evidence (video, screenshots, traces) are kept.
 *
 * Two backends behind one interface:
 *
 *  - `LocalReceiptStore`: files under a directory. The default, and what
 *    tests and offline runs use.
 *  - `S3ReceiptStore`: the S3 API, so ONE class covers AWS S3, Cloudflare
 *    R2, MinIO and any other S3-compatible store. Requests are signed with
 *    AWS Signature Version 4 using `node:crypto` and the global `fetch` —
 *    no AWS SDK, the same "plain HTTP, injectable fetch" shape as
 *    `trace_db.ts`'s `D1TraceDb`.
 *
 * Keys are relative and slash-separated (`<repo>/attempts/<run_id>/<n>/…`).
 * Every key is validated before it touches a path or a URL: no empty
 * segments, no `.`/`..`, no leading "/", no backslashes — a key can never
 * escape the store's root or its bucket prefix.
 *
 * Objects are written once. `put()` returns the sha256 of exactly the bytes
 * stored, which the receipt records, so a receipt proves which bytes it saw.
 *
 * Out of scope here (later slices): the receipt schema itself, recording,
 * the viewer, and lifecycle rules (configured on the bucket by the operator;
 * see the design doc's Storage section).
 */

import { createHash, createHmac } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertKey } from "./receipt_keys.ts";
import type { LocalReceiptStoreConfig, ReceiptStoreConfig, S3ReceiptStoreConfig } from "./data_types.ts";

export interface StoredObject {
  key: string;
  bytes: number;
  sha256: string;
  content_type: string;
}

export interface ReceiptStore {
  /** "local" or "s3" — for messages, never for branching on behavior. */
  readonly kind: ReceiptStoreConfig["kind"];
  /** Human-readable location, e.g. `s3://bucket/prefix` or a directory. */
  readonly location: string;
  put(key: string, body: Uint8Array | string, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  copy(fromKey: string, toKey: string): Promise<void>;
  /** Every key under `prefix` (itself a key prefix, e.g. `spf/attempts/run-1/`), sorted. */
  list(prefix: string): Promise<string[]>;
  /** A URL a browser can GET for `ttlSeconds`. Local stores return a `file://` URL and ignore the TTL. */
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

// ── keys ────────────────────────────────────────────────────────────────────

export { assertKey };

/** A list prefix may end in "/" (and must not be absolute); everything before that obeys `assertKey`. */
function assertPrefix(prefix: string): string {
  if (prefix === "") return prefix;
  assertKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix, "prefix");
  return prefix;
}

const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const toBytes = (body: Uint8Array | string) => (typeof body === "string" ? new TextEncoder().encode(body) : body);

// ── local ───────────────────────────────────────────────────────────────────

export class LocalReceiptStore implements ReceiptStore {
  readonly kind = "local" as const;
  readonly location: string;

  constructor(readonly root: string) {
    this.location = path.resolve(root);
  }

  private file(key: string): string {
    return path.join(this.location, ...assertKey(key).split("/"));
  }

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<StoredObject> {
    const bytes = toBytes(body);
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
    return { key, bytes: bytes.byteLength, sha256: sha256Hex(bytes), content_type: contentType };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.file(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    const to = this.file(toKey);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(this.file(fromKey), to);
  }

  async list(prefix: string): Promise<string[]> {
    assertPrefix(prefix);
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const key = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), key);
        else if (entry.isFile() && key.startsWith(prefix)) out.push(key);
      }
    };
    await walk(this.location, "");
    return out.sort();
  }

  async signedUrl(key: string, _ttlSeconds: number): Promise<string> {
    const file = this.file(key);
    await stat(file); // a URL to nothing is worse than an error
    return pathToFileURL(file).href;
  }
}

// ── S3 (AWS S3, Cloudflare R2, MinIO, …) ────────────────────────────────────

const S3_REQUEST_TIMEOUT_MS = 30_000;
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** SigV4 query-string presigning caps expiry at 7 days. */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** RFC 3986 encoding as SigV4 requires: encodeURIComponent plus `!'()*`. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const encodePath = (p: string) => p.split("/").map(uriEncode).join("/");

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
}

function amzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = createHmac("sha256", `AWS4${secret}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  return createHmac("sha256", kService).update("aws4_request").digest();
}

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  credentials: S3Credentials;
  now: Date;
  /** Header names are lower-cased by the signer. `host` is added automatically. */
  headers?: Record<string, string>;
  /** Hex sha256 of the body, or UNSIGNED-PAYLOAD. */
  payloadHash: string;
}

/** SigV4 header signing. Returns the headers to send (including Authorization). */
export function signHeaders(input: SignInput): Record<string, string> {
  const { amzDate: date, dateStamp } = amzDate(input.now);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  headers["host"] = input.url.host;
  headers["x-amz-date"] = date;
  headers["x-amz-content-sha256"] = input.payloadHash;
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const names = Object.keys(headers).sort();
  const query: Record<string, string> = {};
  input.url.searchParams.forEach((v, k) => (query[k] = v));
  const canonical = [
    input.method,
    input.url.pathname,
    canonicalQuery(query),
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, dateStamp, input.region)).update(toSign).digest("hex");
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete headers["host"]; // fetch sets Host itself and refuses a manual one
  return headers;
}

/** SigV4 query-string presigning (GET). */
export function presignUrl(input: { url: URL; region: string; credentials: S3Credentials; now: Date; expiresSeconds: number }): string {
  if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > MAX_PRESIGN_SECONDS) {
    throw new Error(`presigned URL expiry must be 1..${MAX_PRESIGN_SECONDS} seconds (SigV4's 7-day cap), got ${input.expiresSeconds}`);
  }
  const { amzDate: date, dateStamp } = amzDate(input.now);
  const scope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  if (input.credentials.sessionToken) query["X-Amz-Security-Token"] = input.credentials.sessionToken;
  const canonical = ["GET", input.url.pathname, canonicalQuery(query), `host:${input.url.host}\n`, "host", UNSIGNED_PAYLOAD].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, dateStamp, input.region)).update(toSign).digest("hex");
  return `${input.url.origin}${input.url.pathname}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

const xmlTag = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]) : undefined;
};

export class S3ReceiptStore implements ReceiptStore {
  readonly kind = "s3" as const;
  readonly location: string;
  private readonly base: URL;
  private readonly pathStyle: boolean;
  private readonly prefix: string;

  constructor(
    private readonly config: S3ReceiptStoreConfig,
    private readonly credentials: S3Credentials,
    /** Injectable so tests never touch the real network — defaults to the global `fetch`. */
    private readonly fetchImpl: typeof fetch = fetch,
    /** Injectable clock, for signing tests. */
    private readonly clock: () => Date = () => new Date(),
  ) {
    const prefix = config.prefix.replace(/^\/+|\/+$/g, "");
    if (prefix) assertKey(prefix, "prefix");
    this.prefix = prefix;
    this.pathStyle = config.force_path_style ?? Boolean(config.endpoint);
    if (!this.pathStyle && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)) {
      throw new Error(
        `bucket ${JSON.stringify(config.bucket)} can't be used in a virtual-hosted URL (dots or uppercase) — set force_path_style: true`,
      );
    }
    const endpoint = config.endpoint ?? `https://s3.${config.region}.amazonaws.com`;
    this.base = new URL(endpoint);
    if (!this.pathStyle) this.base.hostname = `${config.bucket}.${this.base.hostname}`;
    this.location = `s3://${config.bucket}${prefix ? `/${prefix}` : ""} (${config.endpoint ?? `aws ${config.region}`})`;
  }

  private fullKey(key: string): string {
    assertKey(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  /** Path for a full (prefixed) key, or the bucket root when `fullKey` is "". */
  private objectUrl(fullKey: string, query: Record<string, string> = {}): URL {
    const basePath = this.base.pathname.replace(/\/+$/, "");
    const bucketPath = this.pathStyle ? `/${uriEncode(this.config.bucket)}` : "";
    const url = new URL(this.base.origin);
    url.pathname = `${basePath}${bucketPath}/${fullKey ? encodePath(fullKey) : ""}`;
    // Build the query by hand so the wire form IS the canonical form SigV4 signed.
    const q = canonicalQuery(query);
    return new URL(`${url.origin}${url.pathname}${q ? `?${q}` : ""}`);
  }

  private async request(
    method: string,
    url: URL,
    opts: { body?: Uint8Array; headers?: Record<string, string>; allow404?: boolean } = {},
  ): Promise<Response | null> {
    const payloadHash = opts.body ? sha256Hex(opts.body) : sha256Hex("");
    const headers = signHeaders({ method, url, region: this.config.region, credentials: this.credentials, now: this.clock(), headers: opts.headers, payloadHash });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), S3_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, { method, headers, body: opts.body, signal: controller.signal });
      if (response.status === 404 && opts.allow404) {
        await response.arrayBuffer().catch(() => undefined);
        return null;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const code = xmlTag(text, "Code");
        const message = xmlTag(text, "Message");
        throw new Error(`S3 ${method} ${url.pathname} failed: HTTP ${response.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`);
      }
      return response;
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") throw new Error(`S3 ${method} ${url.pathname} timed out after ${S3_REQUEST_TIMEOUT_MS}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async put(key: string, body: Uint8Array | string, contentType: string): Promise<StoredObject> {
    const bytes = toBytes(body);
    await this.request("PUT", this.objectUrl(this.fullKey(key)), { body: bytes, headers: { "content-type": contentType } });
    return { key, bytes: bytes.byteLength, sha256: sha256Hex(bytes), content_type: contentType };
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.request("GET", this.objectUrl(this.fullKey(key)), { allow404: true });
    return response ? new Uint8Array(await response.arrayBuffer()) : null;
  }

  async delete(key: string): Promise<void> {
    await this.request("DELETE", this.objectUrl(this.fullKey(key)), { allow404: true });
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    const source = `/${uriEncode(this.config.bucket)}/${encodePath(this.fullKey(fromKey))}`;
    const response = await this.request("PUT", this.objectUrl(this.fullKey(toKey)), { headers: { "x-amz-copy-source": source } });
    // CopyObject can answer 200 with an <Error> body when the copy fails part-way.
    const text = await response!.text();
    if (/<Error>/.test(text)) throw new Error(`S3 copy ${fromKey} → ${toKey} failed: ${xmlTag(text, "Code") ?? "unknown"} ${xmlTag(text, "Message") ?? ""}`.trim());
  }

  async list(prefix: string): Promise<string[]> {
    assertPrefix(prefix);
    const full = this.prefix ? `${this.prefix}/${prefix}` : prefix;
    const strip = this.prefix ? this.prefix.length + 1 : 0;
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix: full };
      if (token) query["continuation-token"] = token;
      const response = await this.request("GET", this.objectUrl("", query));
      const xml = await response!.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const k = xmlTag(m[1], "Key");
        if (k !== undefined) keys.push(k.slice(strip));
      }
      token = xmlTag(xml, "IsTruncated") === "true" ? xmlTag(xml, "NextContinuationToken") : undefined;
    } while (token);
    return keys.sort();
  }

  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return presignUrl({ url: this.objectUrl(this.fullKey(key)), region: this.config.region, credentials: this.credentials, now: this.clock(), expiresSeconds: ttlSeconds });
  }
}

// ── construction + helpers ──────────────────────────────────────────────────

function readEnv(name: string, what: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`${what} is not set — receipts.store names env var ${JSON.stringify(name)}, but it is empty or unset`);
  return value;
}

/** The env vars an s3 store needs set (the session token is optional). Exported for `spf doctor`. */
export function missingS3Env(config: S3ReceiptStoreConfig): string[] {
  return [config.access_key_id_env, config.secret_access_key_env].filter((k) => !(process.env[k] ?? "").trim());
}

export interface CreateReceiptStoreOptions {
  /** Resolves a relative local `path`. Defaults to `process.cwd()`. */
  repoRoot?: string;
  fetchImpl?: typeof fetch;
}

export function createReceiptStore(config: ReceiptStoreConfig, options: CreateReceiptStoreOptions = {}): ReceiptStore {
  if (config.kind === "local") {
    return new LocalReceiptStore(path.resolve(options.repoRoot ?? process.cwd(), (config as LocalReceiptStoreConfig).path));
  }
  const credentials: S3Credentials = {
    accessKeyId: readEnv(config.access_key_id_env, "S3 access key id"),
    secretAccessKey: readEnv(config.secret_access_key_env, "S3 secret access key"),
  };
  const token = (process.env[config.session_token_env] ?? "").trim();
  if (token) credentials.sessionToken = token;
  return new S3ReceiptStore(config, credentials, options.fetchImpl);
}

/**
 * Copy every object of a run from `<repo>/attempts/<run_id>/` to
 * `<repo>/kept/<run_id>/`, so the bucket's lifecycle rule (which expires
 * `attempts/`) keeps it. Copies, never moves: the attempt history stays
 * intact until it expires. Returns the kept keys.
 */
export async function promoteRun(store: ReceiptStore, repo: string, runId: string): Promise<string[]> {
  assertKey(repo, "repo");
  assertKey(runId, "run id");
  if (repo.includes("/") || runId.includes("/")) throw new Error("repo and run id must be single key segments");
  const from = `${repo}/attempts/${runId}/`;
  const keys = await store.list(from);
  const kept: string[] = [];
  for (const key of keys) {
    const to = `${repo}/kept/${runId}/${key.slice(from.length)}`;
    await store.copy(key, to);
    kept.push(to);
  }
  return kept;
}

/**
 * Write, read back, list and delete one small object. Used by `spf doctor`:
 * it proves the credentials, the bucket and the signing all work end to end,
 * without leaving anything behind.
 */
export async function probeReceiptStore(store: ReceiptStore, now: Date = new Date()): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const key = `_doctor/probe-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const body = `spf doctor probe ${now.toISOString()}`;
  try {
    const put = await store.put(key, body, "text/plain");
    const back = await store.get(key);
    if (!back || sha256Hex(back) !== put.sha256) return { ok: false, error: "wrote a probe object but could not read the same bytes back" };
    const listed = await store.list("_doctor/");
    if (!listed.includes(key)) return { ok: false, error: "wrote a probe object but it did not appear in a listing" };
    return { ok: true, detail: `put/get/list/delete ok on ${store.location}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    await store.delete(key).catch(() => undefined);
  }
}
