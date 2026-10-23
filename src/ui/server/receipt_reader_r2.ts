/**
 * `ReceiptReader` over a Cloudflare R2 bucket binding (#202, used by #204).
 * Worker-safe: the bucket is described structurally, so there is no
 * `@cloudflare/workers-types` dependency and no Node import.
 */
import { assertKey } from "../../core/receipt_keys.ts";
import type { ByteRange, ReceiptObject, ReceiptObjectInfo, ReceiptReader } from "./receipt_reader.ts";

interface R2Meta {
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
}

export interface R2BucketLike {
  head(key: string): Promise<R2Meta | null>;
  get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<(R2Meta & { body: ReadableStream; text(): Promise<string> }) | null>;
  list(opts: { prefix?: string; delimiter?: string; cursor?: string }): Promise<{
    objects: { key: string }[];
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export class R2ReceiptReader implements ReceiptReader {
  readonly location: string;
  private readonly prefix: string;

  /** `opts.prefix` is the s3 store's `prefix`: keys are namespaced under it in the bucket and stripped here. */
  constructor(
    private readonly bucket: R2BucketLike,
    opts: { prefix?: string } = {},
  ) {
    this.prefix = (opts.prefix ?? "").replace(/^\/+|\/+$/g, "");
    if (this.prefix) assertKey(this.prefix, "prefix");
    this.location = `r2${this.prefix ? `://${this.prefix}` : ""}`;
  }

  private full(key: string): string {
    assertKey(key);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private async listAll(prefix: string, delimiter?: string): Promise<{ keys: string[]; prefixes: string[] }> {
    const keys: string[] = [];
    const prefixes: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, ...(delimiter ? { delimiter } : {}), ...(cursor ? { cursor } : {}) });
      keys.push(...page.objects.map((o) => o.key));
      prefixes.push(...page.delimitedPrefixes);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return { keys, prefixes };
  }

  async repos(): Promise<string[]> {
    const base = this.prefix ? `${this.prefix}/` : "";
    const { prefixes } = await this.listAll(base, "/");
    return prefixes
      .map((p) => p.slice(base.length).replace(/\/$/, ""))
      .filter(Boolean)
      .sort();
  }

  async list(prefix: string): Promise<string[]> {
    if (prefix !== "") assertKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix, "prefix");
    const base = this.prefix ? `${this.prefix}/` : "";
    const { keys } = await this.listAll(base + prefix);
    return keys.map((k) => k.slice(base.length)).sort();
  }

  async text(key: string): Promise<string | null> {
    const object = await this.bucket.get(this.full(key));
    return object ? object.text() : null;
  }

  async head(key: string): Promise<ReceiptObjectInfo | null> {
    const meta = await this.bucket.head(this.full(key));
    return meta ? info(meta) : null;
  }

  async get(key: string, range?: ByteRange): Promise<ReceiptObject | null> {
    const object = await this.bucket.get(this.full(key), range ? { range } : undefined);
    return object ? { ...info(object), body: object.body as ReadableStream<Uint8Array> } : null;
  }
}

function info(meta: R2Meta): ReceiptObjectInfo {
  return { size: meta.size, etag: meta.etag, ...(meta.httpMetadata?.contentType ? { contentType: meta.httpMetadata.contentType } : {}) };
}
