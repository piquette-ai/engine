/**
 * Local cursors for `piquette sync` (#135): `{data_dir}/sync-state.json`.
 *
 * Cursors only ever advance after a 2xx, one atomic write per accepted batch.
 * A lost or corrupt state file is safe to lose: every row the hub receives is
 * an idempotent upsert, so the worst case is a full resend. Clocks are never
 * compared — `ended_at` is compared as a STRING, and `pushed_at` is
 * informational only.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SyncLevel } from "./contract.ts";

export interface SessionCursor {
  /** `events.rowid` of the last event the hub accepted for this session. */
  events_cursor: number;
  /** How many events this session had up to `events_cursor` — a renumbering check (rowid integrity). */
  events_count: number;
  gates_cursor: number;
  ended_at: string | null;
  /** sha256 of (level + canonical snapshot) last accepted — a snapshot is resent only when it changes. */
  snapshot_digest: string | null;
  /** The level this session was last pushed at. A higher configured level backfills from 0. */
  level: SyncLevel;
  /** Ended, and nothing pending when last pushed. */
  final: boolean;
  /** The session's issue/PR links when last pushed (`SyncSource.listSessions`); absent = none. A change makes a final session a candidate again. */
  links?: string;
  pushed_at: string;
}

export interface SyncState {
  version: 1;
  /** Highest `events.rowid` / `gate_results.id` seen at the start of the last fully successful pass. */
  events_hwm: number;
  gates_hwm: number;
  sessions: Record<string, SessionCursor>;
  /** The repo slug the cursors above were pushed under (#218). The hub keys rows by it, so when it changes (a new `upstream` remote, `sync.repo`, a rename) the cursors are dropped and everything is resent under the new slug. Absent in state files from before #218: adopted, not reset. */
  repo?: string;
  /** Set on a 409: the hub does not accept this client's schema. Cleared by an piquette upgrade. */
  rejected?: { piquette_version: string; sync_schema: number; supported: [number, number] };
}

export function emptySyncState(): SyncState {
  return { version: 1, events_hwm: 0, gates_hwm: 0, sessions: {} };
}

/** A missing file is an empty state; a corrupt one is moved aside (`*.corrupt-<ts>`) with a warning, and sync replays — safe, every row is idempotent. */
export function readSyncState(file: string, warn: (msg: string) => void = console.warn): SyncState {
  if (!existsSync(file)) return emptySyncState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as SyncState;
    if (parsed?.version !== 1 || typeof parsed.sessions !== "object" || parsed.sessions === null) throw new Error("bad shape");
    return { ...emptySyncState(), ...parsed };
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      renameSync(file, aside);
    } catch {
      // can't move it aside — we overwrite it on the next write anyway
    }
    warn(`sync: ${path.basename(file)} was corrupt; moved aside and starting from scratch (replay is safe — the hub upserts)`);
    return emptySyncState();
  }
}

/** tmp + fsync + rename, so a crash leaves either the old state or the new one, never half of one. */
export function writeSyncState(file: string, state: SyncState): void {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** A `--dry-run --out` pass keeps its own cursors, so it can never make a real push skip rows. */
export function stateFileFor(dataDir: string, dryRun: boolean): string {
  return path.join(dataDir, dryRun ? "sync-state.dry-run.json" : "sync-state.json");
}

export function lockFileFor(dataDir: string): string {
  return path.join(dataDir, "sync.lock");
}
