/**
 * Receipts under tenant isolation (dashboard mode). Receipts are keyed by repo
 * segment (`acme--api`), never by tenant, so a reader's receipts are the
 * segments of the repos their tenants' factories have synced. That is the same
 * derivation `spf prove` uses to write them (`segmentFromSlug`).
 *
 * A segment outside the reader's set is invisible, not forbidden: it is absent
 * from `repos()` and every read of it answers "missing", so neither a repo name
 * nor a run's existence leaks across tenants. A run written under a legacy
 * (directory-name) segment has no synced repo to match and is not served here.
 */
import { segmentFromSlug, type ReceiptReader } from "../../src/receipts/index.ts";
import type { D1Database } from "./env.ts";

/** Receipt repo segments for these tenants' factories. */
export async function tenantSegments(db: D1Database, tenants: string[]): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT DISTINCT repo FROM factory_repos WHERE tenant IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(tenants))
    .all<{ repo: string }>();
  return new Set(results.map((r) => segmentFromSlug(r.repo)).filter(Boolean));
}

const firstSegment = (key: string): string => key.split("/", 1)[0] ?? "";

export class ScopedReceiptReader implements ReceiptReader {
  private allowed: Promise<Set<string>> | undefined;

  constructor(
    private readonly inner: ReceiptReader,
    private readonly segments: () => Promise<Set<string>>,
  ) {}

  get location(): string {
    return this.inner.location;
  }

  private ok(key: string): Promise<boolean> {
    return (this.allowed ??= this.segments()).then((set) => set.has(firstSegment(key)));
  }

  async repos(): Promise<string[]> {
    const set = await (this.allowed ??= this.segments());
    return (await this.inner.repos()).filter((r) => set.has(r));
  }

  async list(prefix: string): Promise<string[]> {
    if (prefix === "") {
      const set = await (this.allowed ??= this.segments());
      return (await this.inner.list("")).filter((k) => set.has(firstSegment(k)));
    }
    return (await this.ok(prefix)) ? this.inner.list(prefix) : [];
  }

  async text(key: string): Promise<string | null> {
    return (await this.ok(key)) ? this.inner.text(key) : null;
  }

  async head(key: string) {
    return (await this.ok(key)) ? this.inner.head(key) : null;
  }

  async get(key: string, range?: Parameters<ReceiptReader["get"]>[1]) {
    return (await this.ok(key)) ? this.inner.get(key, range) : null;
  }
}
