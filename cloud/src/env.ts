/** Worker bindings and Hono env for the cloud app. Types only. */
import type { R2BucketLike } from "../../src/ui/server/receipt_reader_r2.ts";

/** The slice of D1 the modules use, described structurally (no workers-types dependency). */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export interface CloudBindings {
  /** Present when the receipts module has a bucket. */
  RECEIPTS?: R2BucketLike;
  /** Present when ingest or dashboard has a database. */
  DB?: D1Database;
  ASSETS: { fetch(req: Request): Promise<Response> };
  /** `<team>.cloudflareaccess.com` */
  ACCESS_TEAM_DOMAIN: string;
  /** Comma-separated Access application AUD tags. Empty fails closed. */
  ACCESS_AUD: string;
  /** Comma-separated: receipts, ingest, dashboard. */
  PIQUETTE_MODULES: string;
  /** Mount path, `/` or `/piquette`. */
  BASE_PATH: string;
  /** Must equal the s3 store's `prefix`. */
  RECEIPTS_PREFIX?: string;
  /** Days of trace detail kept; `0` disables; anything non-integer skips the sweep. */
  RETENTION_DAYS?: string;
  /** `tenant` scopes receipts to the reader's synced repos; anything else (default `perimeter`) serves every receipt to any Access identity. */
  RECEIPTS_VISIBILITY?: string;
  /** Largest accepted ingest body in bytes (default 8 MiB). */
  MAX_BODY_BYTES?: string;
  CHROME_STYLESHEET_URL?: string;
  CHROME_HEADER_URL?: string;
  CHROME_HEADER_HEIGHT?: string;
  CHROME_HOME_URL?: string;
  /** JSON of `cloud.brand` (name, logo, favicon, colors, home); empty for the stock look. */
  BRAND_JSON?: string;
}

export interface AccessIdentity {
  /** A person: present for identity tokens. */
  email?: string;
  /** A service token: present for service-token JWTs. */
  commonName?: string;
}

export type CloudEnv = { Bindings: CloudBindings; Variables: { access?: AccessIdentity; tenants?: string[] } };
