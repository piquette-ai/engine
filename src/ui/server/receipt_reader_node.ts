/**
 * Node-side `ReceiptReader`s (#202): a receipts directory read in place, and
 * a buffered adapter over any `ReceiptStore` (an s3 `receipts.store`). Never
 * imported by Worker-path code.
 */
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { SFConfig } from "../../core/data_types.ts";
import { assertKey } from "../../core/receipt_keys.ts";
import { createReceiptStore, type ReceiptStore } from "../../core/receipt_store.ts";
import type { ByteRange, ReceiptObject, ReceiptObjectInfo, ReceiptReader } from "./receipt_reader.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};
const contentTypeOf = (key: string) => CONTENT_TYPES[path.extname(key).toLowerCase()];

const isEnoent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";

export class LocalReceiptReader implements ReceiptReader {
  readonly location: string;

  constructor(readonly root: string) {
    this.location = path.resolve(root);
  }

  private file(key: string): string {
    const file = path.join(this.location, ...assertKey(key).split("/"));
    if (!file.startsWith(this.location + path.sep)) throw new Error(`receipt key ${JSON.stringify(key)} escapes the store`);
    return file;
  }

  async repos(): Promise<string[]> {
    try {
      const entries = await readdir(this.location, { withFileTypes: true });
      // A symlinked repo directory still counts, so stat rather than trust the dirent.
      const out: string[] = [];
      for (const e of entries) {
        if (e.isDirectory() || (e.isSymbolicLink() && (await stat(path.join(this.location, e.name)).catch(() => null))?.isDirectory())) out.push(e.name);
      }
      return out.sort();
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    if (prefix !== "") assertKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix, "prefix");
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isEnoent(error)) return;
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

  async text(key: string): Promise<string | null> {
    try {
      return await readFile(this.file(key), "utf-8");
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async head(key: string): Promise<ReceiptObjectInfo | null> {
    try {
      const s = await stat(this.file(key));
      if (!s.isFile()) return null;
      const contentType = contentTypeOf(key);
      return { size: s.size, ...(contentType ? { contentType } : {}) };
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async get(key: string, range?: ByteRange): Promise<ReceiptObject | null> {
    const info = await this.head(key);
    if (!info) return null;
    const stream = createReadStream(this.file(key), range ? { start: range.offset, end: range.offset + range.length - 1 } : {});
    return { ...info, body: Readable.toWeb(stream) as ReadableStream<Uint8Array> };
  }
}

/** Buffered adapter: reads whole objects through a `ReceiptStore`. Fine for the occasional local view of an s3 store, not for serving at scale. */
export class StoreReceiptReader implements ReceiptReader {
  constructor(private readonly store: ReceiptStore) {}

  get location(): string {
    return this.store.location;
  }

  async repos(): Promise<string[]> {
    const keys = await this.store.list("");
    return [...new Set(keys.map((k) => k.split("/")[0]))].filter(Boolean).sort();
  }

  list(prefix: string): Promise<string[]> {
    return this.store.list(prefix);
  }

  async text(key: string): Promise<string | null> {
    const bytes = await this.store.get(key);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  async head(key: string): Promise<ReceiptObjectInfo | null> {
    const bytes = await this.store.get(key);
    if (!bytes) return null;
    const contentType = contentTypeOf(key);
    return { size: bytes.byteLength, ...(contentType ? { contentType } : {}) };
  }

  async get(key: string, range?: ByteRange): Promise<ReceiptObject | null> {
    const bytes = await this.store.get(key);
    if (!bytes) return null;
    const contentType = contentTypeOf(key);
    const slice = range ? bytes.subarray(range.offset, range.offset + range.length) : bytes;
    return {
      size: bytes.byteLength,
      ...(contentType ? { contentType } : {}),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(slice);
          controller.close();
        },
      }),
    };
  }
}

/**
 * The reader for `piquette ui`: the configured `receipts.store`, or the same
 * default `proofStore` uses. Never throws; a store that can't be opened is
 * reported as a note and the UI starts without receipts.
 */
export function receiptReaderFor(cfg: Pick<SFConfig, "receipts"> | undefined, repoRoot: string): { reader: ReceiptReader | null; note: string } {
  try {
    const store = cfg?.receipts?.store ?? { kind: "local" as const, path: ".piquette/data/receipts" };
    if (store.kind === "local") {
      const root = path.resolve(repoRoot, store.path);
      // Through a worktree's `.piquette/data` symlink, to the directory that outlives it (as evidenceLinksFor does).
      const real = existsSync(root) ? realpathSync(root) : root;
      const reader = new LocalReceiptReader(real);
      return { reader, note: reader.location };
    }
    const reader = new StoreReceiptReader(createReceiptStore(store, { repoRoot }));
    return { reader, note: reader.location };
  } catch (error) {
    return { reader: null, note: `off (${(error as Error).message})` };
  }
}
