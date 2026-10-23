/**
 * `spf sync`'s push client (#135): reads the trace db (local sqlite OR D1, via
 * `SyncSource`), redacts each row to the configured tier, packs rows into
 * bounded batches and POSTs them to the hub's `/ingest/v1`.
 *
 * INVARIANTS, because sync must never block or fail a run or a PR:
 *  - It is its own process and imports nothing from the run path (tracer,
 *    session, runner, watch — a test pins that).
 *  - Cursors advance only after a 2xx, one atomic state write per accepted
 *    batch. A crash anywhere replays at most one batch, and the hub upserts.
 *  - Candidate selection never compares clocks: it uses presence in state,
 *    `final`, `ended_at` string equality, and the events/gates high-water marks.
 *  - Credentials are read from the environment HERE, at send time, and are
 *    never part of a payload, a log line or an agent's env (#33).
 *  - Every message is redacted, and the endpoint is only ever printed through
 *    `endpointLabel`. `redirect: "manual"` keeps undici from replaying the
 *    CF-Access-Client-Secret header to a redirect target.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveSyncConfig, syncEndpointBlockedByRepoCloud, type SFConfig, type SyncRoutingTrustShape, type SyncConfig } from "../data_types.ts";
import { endpointLabel, redact } from "../otel.ts";
import { PACKAGE_ROOT, type DataPaths, type RepoAnchor } from "../paths.ts";
import { acquirePidLock, releasePidLock } from "../utils.ts";
import type { SyncColumnCache } from "./source.ts";
import {
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  SYNC_INGEST_PATH,
  SYNC_LEVELS,
  SYNC_SCHEMA_HEADER,
  SYNC_SCHEMA_VERSION,
  SyncSupportedSchema,
  type SyncBatch,
  type SyncEventRow,
  type SyncGateRow,
  type SyncLevel,
  type SyncSessionEntry,
  type SyncSnapshot,
} from "./contract.ts";
import { resolveFactory, type FactoryIdentity } from "./identity.ts";
import { applyLevel, collectSecrets, scrubSecrets } from "./redact.ts";
import { SyncSource } from "./source.ts";
import { lockFileFor, readSyncState, stateFileFor, writeSyncState, type SessionCursor, type SyncState } from "./state.ts";
import * as v from "valibot";

export interface SyncPassOptions {
  cfg: SFConfig;
  /** Which layer each steering block came from: a repo-layer `cloud:` never supplies the endpoint. */
  origins?: { cloud?: string | undefined; syncTrusted?: SyncRoutingTrustShape | undefined };
  anchor: Pick<RepoAnchor, "repo_root">;
  dataPaths: Pick<DataPaths, "data_dir" | "db" | "sessions_dir">;
  level: SyncLevel;
  dryRun: boolean;
  /** Dry run only: append each batch to this file as NDJSON, advancing only the dry-run cursors. */
  out?: string;
  /** The hub transport — injectable for tests. */
  fetchImpl?: typeof fetch;
  /** The D1 transport for a D1-backed source — injectable for tests. */
  sourceFetchImpl?: typeof fetch;
  now?: () => string;
  log?: (message: string) => void;
  /** Aborts between batches (and the in-flight request). */
  signal?: AbortSignal;
  /** Test seam: runs after the hub's 2xx and BEFORE the cursors are persisted. */
  afterAccepted?: (batch: SyncBatch) => void;
  /** Kept across the passes of `--follow` (see `SyncColumnCache`). */
  columnCache?: SyncColumnCache;
}

export interface SyncPassReport {
  sessions: number;
  snapshots: number;
  events: number;
  gates: number;
  batches: number;
  bytes: number;
  status: "ok" | "nothing" | "failed" | "rejected" | "locked";
  error?: string;
  /** What a dry run (or a real pass) covered, per session. */
  detail: Array<{ adw_id: string; snapshot: boolean; events: number; gates: number }>;
}

let versionCache: string | undefined;
export function spfVersion(): string {
  if (versionCache === undefined) {
    try {
      versionCache = (JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string }).version;
    } catch {
      versionCache = "unknown";
    }
  }
  return versionCache;
}

/** JSON with sorted keys, so the same rows always hash to the same `batch_id`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const levelRank = (l: SyncLevel): number => SYNC_LEVELS.indexOf(l);
const byteLen = (s: string): number => Buffer.byteLength(s);

class PassStop extends Error {
  constructor(
    readonly status: "failed" | "rejected",
    message: string,
  ) {
    super(message);
  }
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  const e = error as { name?: string; message?: string; cause?: { code?: string } };
  if (e?.name === "AbortError") return `request timed out after ${timeoutMs}ms (or was interrupted)`;
  return `${e?.message ?? String(error)}${e?.cause?.code ? ` (${e.cause.code})` : ""}`;
}

type SendResult = { kind: "ok" } | { kind: "schema"; supported: [number, number] } | { kind: "fail"; error: string };

/** A 409 is a schema rejection only when the hub says so: a `{supported: [min, max]}` body that excludes our version. */
function schemaRejection(text: string): [number, number] | null {
  try {
    const parsed = v.safeParse(SyncSupportedSchema, JSON.parse(text));
    if (!parsed.success) return null;
    const [min, max] = parsed.output.supported;
    return SYNC_SCHEMA_VERSION < min || SYNC_SCHEMA_VERSION > max ? parsed.output.supported : null;
  } catch {
    return null;
  }
}

/** One POST. Credentials are read here, at send time, and nowhere else. */
async function postBatch(sync: SyncConfig, batch: SyncBatch, body: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<SendResult> {
  const id = (process.env[sync.client_id_env] ?? "").trim();
  const secret = (process.env[sync.client_secret_env] ?? "").trim();
  const missing = [!id && sync.client_id_env, !secret && sync.client_secret_env].filter(Boolean);
  if (missing.length > 0) return { kind: "fail", error: `${missing.join(" and ")} not set — the Cloudflare Access service token is read from the environment at sync time` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sync.timeout_ms);
  timer.unref?.();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetchImpl(sync.endpoint!.replace(/\/+$/, "") + SYNC_INGEST_PATH, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        [SYNC_SCHEMA_HEADER]: String(SYNC_SCHEMA_VERSION),
        "Idempotency-Key": batch.batch_id,
        "User-Agent": `spf/${spfVersion()}`,
        "CF-Access-Client-Id": id,
        "CF-Access-Client-Secret": secret,
      },
      body,
    });
    if (res.status >= 200 && res.status < 300) {
      await res.body?.cancel().catch(() => {});
      return { kind: "ok" };
    }
    if (res.status === 409) {
      const supported = schemaRejection(await res.text().catch(() => ""));
      if (supported) return { kind: "schema", supported };
      // an Idempotency-Key conflict or an in-progress request: retry on the next tick, never persist `rejected`
      return { kind: "fail", error: "hub answered HTTP 409 (not a schema rejection; will retry)" };
    }
    await res.body?.cancel().catch(() => {});
    if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
      return { kind: "fail", error: `Cloudflare Access rejected the service token (HTTP ${res.status}) — check ${sync.client_id_env} / ${sync.client_secret_env} and the Access policy` };
    }
    return { kind: "fail", error: `hub answered HTTP ${res.status}` };
  } catch (error) {
    return { kind: "fail", error: describeFetchError(error, sync.timeout_ms) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

interface Pending {
  entries: Map<string, SyncSessionEntry>;
  commits: Map<string, SessionCursor>;
  rows: number;
  events: number;
  bytes: number;
}

export async function runSyncPass(opts: SyncPassOptions): Promise<SyncPassReport> {
  const sync = resolveSyncConfig(opts.cfg, opts.origins);
  const level = opts.level;
  const now = opts.now ?? (() => new Date().toISOString());
  const report: SyncPassReport = { sessions: 0, snapshots: 0, events: 0, gates: 0, batches: 0, bytes: 0, status: "nothing", detail: [] };
  const safe = (msg: string): string =>
    redact(msg, [process.env[sync.client_id_env], process.env[sync.client_secret_env], sync.endpoint]);
  const log = (msg: string): void => (opts.log ?? ((m: string) => console.log(m)))(safe(msg));
  const persist = !opts.dryRun || opts.out !== undefined;
  const dataDir = opts.dataPaths.data_dir;
  const stateFile = stateFileFor(dataDir, opts.dryRun);
  const lockFile = lockFileFor(dataDir);
  let locked = false;
  let source: SyncSource | null = null;

  try {
    if (!opts.dryRun) {
      if (!sync.endpoint) {
        throw new PassStop("failed", syncEndpointBlockedByRepoCloud(opts.cfg, opts.origins) ? "sync.endpoint is not derived from a repo-layer cloud block; set sync.endpoint in your machine config" : opts.origins?.syncTrusted?.routing_ignored.includes("endpoint") ? "sync.endpoint is not taken from a repo layer; set it in your machine config" : "sync.endpoint is not set in the config");
      }
      const lock = acquirePidLock(lockFile);
      if (!lock.ok) {
        log(`sync: another sync is running (pid ${lock.holderPid}); skipping this pass`);
        report.status = "locked";
        return report;
      }
      locked = true;
    }

    // `--out` always leaves a file behind, even when there is nothing new to append.
    if (opts.dryRun && opts.out !== undefined) writeFileSync(opts.out, "", { flag: "a" });

    // A plain `--dry-run` previews what a real push would send: it reads the real cursors (read-only) and never writes.
    const state: SyncState = readSyncState(opts.dryRun && opts.out === undefined ? stateFileFor(dataDir, false) : stateFile, log);
    if (!opts.dryRun && state.rejected && state.rejected.spf_version === spfVersion()) {
      log(`sync: the hub does not accept sync_schema ${state.rejected.sync_schema} (it supports ${state.rejected.supported.join("-")}); upgrade spf to retry`);
      report.status = "rejected";
      return report;
    }
    if (!opts.dryRun) delete state.rejected;

    // A local db that does not exist yet has nothing to sync — and no reason to mint a factory id.
    if (opts.dataPaths.db.kind === "sqlite" && !existsSync(opts.dataPaths.db.path)) {
      log("sync: nothing to sync (no trace db yet)");
      return report;
    }
    // Identity first: its factory id is stamped on every row the source reads.
    const factoryNow: FactoryIdentity = resolveFactory(opts.cfg, opts.anchor, dataDir, opts.origins);
    // The hub keys every row by (factory, repo, adw_id), so a slug change must restart the cursors: an append-only entry
    // under the new slug would find no session row there and be invisible. The old slug's rows stay (see the design doc runbook).
    if (state.repo !== undefined && state.repo !== factoryNow.repo) {
      log(`sync: repo changed (${state.repo} -> ${factoryNow.repo}); resending every session under the new repo`);
      state.sessions = {};
      state.events_hwm = 0;
      state.gates_hwm = 0;
    }
    state.repo = factoryNow.repo;
    source = await SyncSource.open(opts.dataPaths, { factoryId: factoryNow.factory_id, fetchImpl: opts.sourceFetchImpl, columnCache: opts.columnCache });
    if (!source) {
      log("sync: nothing to sync (no trace db yet)");
      return report;
    }

    const secrets = collectSecrets(opts.cfg);
    // Captured BEFORE reading anything, so a row written mid-pass is seen by the next pass.
    const maxEvents = await source.maxEventRowid();
    const maxGates = await source.maxGateId();
    // Which sessions saw events since the last pass — read at EVERY level (it also tells a still-running session apart from an idle one),
    // but only `trace`/`full` act on it: a summary pass never sends events.
    const activeAdws = new Set(await source.adwIdsWithEventsAfter(state.events_hwm));
    const eventAdws = level === "summary" ? new Set<string>() : activeAdws;
    const gateAdws = new Set(await source.adwIdsWithGatesAfter(state.gates_hwm));

    const sessions: Array<{ adw_id: string; ended_at: string | null }> = [];
    for (let after = 0; ; ) {
      const page = await source.listSessions(after, 500);
      if (page.length === 0) break;
      sessions.push(...page);
      after = page[page.length - 1]!.rowid;
    }
    const candidates = sessions.filter((s) => {
      const cur = state.sessions[s.adw_id];
      return (
        !cur || !cur.final || cur.ended_at !== s.ended_at || eventAdws.has(s.adw_id) || gateAdws.has(s.adw_id) || levelRank(level) > levelRank(cur.level)
      );
    });

    // A running session with no new events or gates, the same ended_at and the same tier has nothing to send:
    // skip its snapshot read (7 D1 calls) — a SIGKILLed session stays a candidate forever otherwise.
    const idle = (s: { adw_id: string; ended_at: string | null }): boolean => {
      const cur = state.sessions[s.adw_id];
      return !!cur && !cur.final && cur.ended_at === s.ended_at && s.ended_at === null && levelRank(level) <= levelRank(cur.level) && !activeAdws.has(s.adw_id) && !gateAdws.has(s.adw_id);
    };

    let pending: Pending = { entries: new Map(), commits: new Map(), rows: 0, events: 0, bytes: 0 };

    const flush = async (): Promise<void> => {
      if (pending.rows === 0) return;
      if (opts.signal?.aborted) throw new PassStop("failed", "interrupted");
      const core = {
        sync_schema: SYNC_SCHEMA_VERSION as typeof SYNC_SCHEMA_VERSION,
        spf_version: spfVersion(),
        level,
        factory: { factory_id: factoryNow.factory_id, name: factoryNow.name, repo: factoryNow.repo },
        sessions: [...pending.entries.values()],
      };
      const batch: SyncBatch = { ...core, batch_id: sha256(canonicalJson(core)), sent_at: now() };
      const body = JSON.stringify(batch);
      if (opts.dryRun) {
        if (opts.out !== undefined) writeFileSync(opts.out, body + "\n", { flag: "a" });
      } else {
        const sent = await postBatch(sync, batch, body, opts.fetchImpl ?? fetch, opts.signal);
        if (sent.kind === "schema") {
          state.rejected = { spf_version: spfVersion(), sync_schema: SYNC_SCHEMA_VERSION, supported: sent.supported };
          writeSyncState(stateFile, state);
          throw new PassStop("rejected", `the hub does not accept sync_schema ${SYNC_SCHEMA_VERSION} (it supports ${sent.supported.join("-")}); upgrade spf and retry`);
        }
        if (sent.kind === "fail") throw new PassStop("failed", sent.error);
      }
      opts.afterAccepted?.(batch);
      for (const [adw, cursor] of pending.commits) state.sessions[adw] = cursor;
      if (persist) writeSyncState(stateFile, state);
      report.batches++;
      report.bytes += byteLen(body);
      pending = { entries: new Map(), commits: new Map(), rows: 0, events: 0, bytes: 0 };
    };

    const room = (size: number, events: number): boolean =>
      pending.rows === 0 || (pending.events + events <= MAX_BATCH_EVENTS && pending.bytes + size <= MAX_BATCH_BYTES);

    for (const cand of candidates) {
      if (idle(cand)) continue;
      if (opts.signal?.aborted) throw new PassStop("failed", "interrupted");
      let cur: SessionCursor | undefined = state.sessions[cand.adw_id];
      let working: SessionCursor = cur
        ? { ...cur }
        : { events_cursor: 0, events_count: 0, gates_cursor: 0, ended_at: null, snapshot_digest: null, level, final: false, pushed_at: "" };
      if (cur && levelRank(level) > levelRank(cur.level)) {
        log(`sync: ${cand.adw_id}: level raised to ${level}, backfilling from the start`);
        working = { ...working, events_cursor: 0, events_count: 0, gates_cursor: 0, snapshot_digest: null };
      } else if (cur && cur.events_cursor > 0 && level !== "summary") {
        const count = await source.countEventsUpTo(cand.adw_id, cur.events_cursor);
        if (count !== cur.events_count) {
          log(`sync: ${cand.adw_id}: event rows were renumbered (${cur.events_count} synced, ${count} found); resending from the start`);
          working = { ...working, events_cursor: 0, events_count: 0 };
        }
      }

      const raw = await source.snapshot(cand.adw_id);
      if (!raw) continue;
      const detail = { adw_id: cand.adw_id, snapshot: false, events: 0, gates: 0 };
      // Committed mid-session cursors are never `final`: a later batch of a backfill may still fail,
      // and a final cursor would drop the session from the next pass's candidates.
      const touch = (final = false): void => {
        pending.commits.set(cand.adw_id, { ...working, final, level, pushed_at: now() });
      };
      const entryFor = (): SyncSessionEntry => {
        let entry = pending.entries.get(cand.adw_id);
        if (!entry) {
          entry = { adw_id: cand.adw_id, events: [], gate_results: [] };
          pending.entries.set(cand.adw_id, entry);
        }
        return entry;
      };
      const redactEntry = (e: SyncSessionEntry): SyncSessionEntry => scrubSecrets(applyLevel(level, e), secrets);

      // Snapshot: only when its content (or the tier) changed.
      const snapshot: SyncSnapshot = {
        session: raw.session,
        phases: raw.phases,
        agent_sessions: raw.agent_sessions,
        envelopes: raw.envelopes,
        prompts: level === "full" ? source.prompts(cand.adw_id, raw.agent_sessions.map((a) => a.agent)) : [],
      };
      const digest = sha256(level + canonicalJson(snapshot));
      if (digest !== working.snapshot_digest) {
        const out = redactEntry({ adw_id: cand.adw_id, snapshot, events: [], gate_results: [] }).snapshot!;
        const size = byteLen(JSON.stringify(out));
        if (!room(size, 0)) await flush();
        entryFor().snapshot = out;
        pending.rows++;
        pending.bytes += size;
        working.snapshot_digest = digest;
        detail.snapshot = true;
        report.snapshots++;
        touch();
      }

      if (level !== "summary") {
        for (;;) {
          const page = await source.events(cand.adw_id, working.events_cursor, MAX_BATCH_EVENTS);
          if (page.length === 0) break;
          const red = redactEntry({ adw_id: cand.adw_id, events: page, gate_results: [] }).events;
          for (let i = 0; i < page.length; i++) {
            const size = byteLen(JSON.stringify(red[i]));
            if (!room(size, 1)) await flush();
            entryFor().events.push(red[i]!);
            pending.rows++;
            pending.events++;
            pending.bytes += size;
            working.events_cursor = (page[i] as SyncEventRow).local_rowid;
            working.events_count++;
            detail.events++;
            report.events++;
            touch();
          }
          if (page.length < MAX_BATCH_EVENTS) break;
        }
      }

      for (;;) {
        const page = await source.gates(cand.adw_id, working.gates_cursor, MAX_BATCH_EVENTS);
        if (page.length === 0) break;
        const red = redactEntry({ adw_id: cand.adw_id, events: [], gate_results: page }).gate_results;
        for (let i = 0; i < page.length; i++) {
          const size = byteLen(JSON.stringify(red[i]));
          if (!room(size, 0)) await flush();
          entryFor().gate_results.push(red[i]!);
          pending.rows++;
          pending.bytes += size;
          working.gates_cursor = (page[i] as SyncGateRow).local_id;
          detail.gates++;
          report.gates++;
          touch();
        }
        if (page.length < MAX_BATCH_EVENTS) break;
      }

      working.ended_at = raw.session.ended_at;
      working.final = raw.session.ended_at !== null;
      working.level = level;
      if (pending.commits.has(cand.adw_id)) {
        touch(working.final);
      } else if (JSON.stringify(working) !== JSON.stringify(cur)) {
        // Nothing to send, but the cursor's bookkeeping moved (e.g. now final).
        state.sessions[cand.adw_id] = { ...working, pushed_at: cur?.pushed_at ?? now() };
      }
      if (detail.snapshot || detail.events || detail.gates) {
        report.sessions++;
        report.detail.push(detail);
      }
    }
    await flush();

    // A summary pass never looked at events: moving the mark would hide an event added to a final session.
    if (level !== "summary") state.events_hwm = maxEvents;
    state.gates_hwm = maxGates;
    if (persist) writeSyncState(stateFile, state);
    report.status = report.batches > 0 ? "ok" : "nothing";
    return report;
  } catch (error) {
    if (error instanceof PassStop) {
      report.status = error.status;
      report.error = safe(error.message);
    } else {
      report.status = "failed";
      report.error = safe((error as Error)?.message ?? String(error));
    }
    return report;
  } finally {
    if (source) await source.close().catch(() => {});
    if (locked) releasePidLock(lockFile);
  }
}

export type HubProbe =
  | { kind: "ok"; supported: [number, number]; compatible: boolean }
  | { kind: "access" }
  | { kind: "unreachable"; error: string };

/** `GET {endpoint}/ingest/v1` with the Access headers: which `sync_schema` range does the hub accept? Never throws. */
export async function probeHub(sync: SyncConfig, fetchImpl: typeof fetch = fetch, timeoutMs = 3000): Promise<HubProbe> {
  const id = (process.env[sync.client_id_env] ?? "").trim();
  const secret = (process.env[sync.client_secret_env] ?? "").trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchImpl(sync.endpoint!.replace(/\/+$/, "") + SYNC_INGEST_PATH, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": `spf/${spfVersion()}`, "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret },
    });
    if ((res.status >= 300 && res.status < 400) || res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      return { kind: "access" };
    }
    if (res.status < 200 || res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      return { kind: "unreachable", error: `hub answered HTTP ${res.status}` };
    }
    const parsed = v.safeParse(SyncSupportedSchema, JSON.parse(await res.text()));
    if (!parsed.success) return { kind: "unreachable", error: "hub answered, but not with a {supported: [min, max]} body" };
    const [min, max] = parsed.output.supported;
    return { kind: "ok", supported: parsed.output.supported, compatible: SYNC_SCHEMA_VERSION >= min && SYNC_SCHEMA_VERSION <= max };
  } catch (error) {
    const msg = describeFetchError(error, timeoutMs);
    return { kind: "unreachable", error: redact(msg, [id, secret, sync.endpoint]) };
  } finally {
    clearTimeout(timer);
  }
}

/** Human line for a source-less `endpoint` — never prints userinfo or a query. */
export function describeEndpoint(sync: SyncConfig): string {
  return sync.endpoint ? endpointLabel(sync.endpoint) : "(no endpoint)";
}

export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    // Ref'd on purpose: this timer IS what keeps `spf sync --follow` alive between ticks.
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Passes at `interval_ms`; on a failure the wait doubles (capped at 300 s,
 * +-20% jitter), and a `rejected` schema stops it — a hub that said no will
 * keep saying no until spf is upgraded.
 */
const D1_MIN_INTERVAL_MS = 60_000;

export async function followSync(
  opts: SyncPassOptions & { signal: AbortSignal },
  onReport: (report: SyncPassReport) => void = () => {},
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepUnlessAborted,
): Promise<SyncPassReport> {
  const sync = resolveSyncConfig(opts.cfg, opts.origins);
  // D1 reads go through Cloudflare's REST API (1200 requests / 5 min / user, shared with the tracer's own writes): poll it no faster than once a minute.
  const intervalMs = opts.dataPaths.db.kind === "d1" ? Math.max(sync.interval_ms, D1_MIN_INTERVAL_MS) : sync.interval_ms;
  const passOpts: SyncPassOptions = { ...opts, columnCache: opts.columnCache ?? new Map() };
  let failures = 0;
  let last: SyncPassReport;
  for (;;) {
    last = await runSyncPass(passOpts);
    onReport(last);
    if (last.status === "rejected" || opts.signal.aborted) return last;
    failures = last.status === "failed" ? failures + 1 : 0;
    const base = failures === 0 ? intervalMs : Math.min(300_000, intervalMs * 2 ** failures);
    const jitter = failures === 0 ? 1 : 0.8 + Math.random() * 0.4;
    await sleep(Math.round(base * jitter), opts.signal);
    if (opts.signal.aborted) return last;
  }
}
