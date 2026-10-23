/**
 * The `spf sync` payload contract (#135) — what a factory pushes to the hosted
 * hub (#136) at `POST {endpoint}/ingest/v1`. The hub imports these schemas and
 * types; `assets/sync/payload.v1.schema.json` is generated from them
 * (`npm run gen:sync-schema`) and a test fails when the two drift.
 *
 * NO node imports here: this module must stay safe to bundle into a Worker.
 *
 * Every row carries `factory_id` plus its natural key, so the hub can upsert on
 * `(factory_id, key)` and a replayed batch is a no-op. Rows are built from an
 * allowlist of columns (redact.ts), never by deleting fields from a raw row, so
 * a column a future tracer migration adds cannot leak until the schema is bumped.
 */
import * as v from "valibot";

export const SYNC_SCHEMA_VERSION = 1;
export const SYNC_INGEST_PATH = "/ingest/v1";
export const SYNC_SCHEMA_HEADER = "X-SPF-Sync-Schema";
// Defined in data_types.ts (which the run path imports) and re-exported here, so the run path never loads sync/.
export { SYNC_LEVELS, DEFAULT_SYNC_LEVEL, type SyncLevel } from "../data_types.ts";
import { SYNC_LEVELS } from "../data_types.ts";

/** One request carries at most this many events, or this many serialized bytes — whichever is hit first. */
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 1_000_000;
/** `full` only: a single field larger than this is replaced by `{"_spf_truncated": <bytes>}`. */
export const MAX_FIELD_BYTES = 262_144;

const Str = v.nullable(v.string());
const Num = v.nullable(v.number());

export const SyncSessionRowSchema = v.object({
  factory_id: v.string(),
  adw_id: v.string(),
  adw_name: Str,
  request: Str,
  status: Str,
  engineer: Str,
  started_at: Str,
  ended_at: Str,
  total_tokens: Num,
  total_cost: Num,
  billable_tokens: Num,
});

export const SyncPhaseRowSchema = v.object({
  factory_id: v.string(),
  phase_id: v.string(),
  adw_id: Str,
  seq: Num,
  name: Str,
  kind: Str,
  owner: Str,
  description: Str,
  status: Str,
  attempt: Num,
  retries: Num,
  error: Str,
  started_at: Str,
  ended_at: Str,
});

export const SyncAgentSessionRowSchema = v.object({
  factory_id: v.string(),
  adw_id: v.string(),
  agent: v.string(),
  coding_agent: Str,
  model: Str,
  color: Str,
  session_id: Str,
  context_tokens: Num,
  context_window: Num,
  created_at: Str,
  last_used_at: Str,
});

export const SyncEnvelopeRowSchema = v.object({
  factory_id: v.string(),
  envelope_id: v.string(),
  adw_id: Str,
  phase_id: Str,
  agent: Str,
  output_type: Str,
  payload_json: Str,
  valid: Num,
  attempt: Num,
  created_at: Str,
});

export const SyncEventRowSchema = v.object({
  factory_id: v.string(),
  event_id: v.string(),
  /** The factory-local `rowid` — the append cursor; informational for the hub. */
  local_rowid: v.number(),
  adw_id: Str,
  phase_id: Str,
  parent_id: Str,
  type: Str,
  name: Str,
  payload_json: Str,
  tokens: Num,
  started_at: Str,
  ended_at: Str,
});

export const SyncGateRowSchema = v.object({
  factory_id: v.string(),
  local_id: v.number(),
  adw_id: Str,
  phase_id: Str,
  attempt: Num,
  gate: Str,
  passed: Num,
  violations_json: Str,
  checks_json: Str,
  created_at: Str,
});

/** `full` only — the prompt files kept under `sessions_dir`, which a remote reader cannot otherwise serve. */
export const SyncPromptRowSchema = v.object({
  factory_id: v.string(),
  adw_id: v.string(),
  agent: v.string(),
  system: Str,
  user: Str,
});

export const SyncSnapshotSchema = v.object({
  session: SyncSessionRowSchema,
  phases: v.array(SyncPhaseRowSchema),
  agent_sessions: v.array(SyncAgentSessionRowSchema),
  envelopes: v.array(SyncEnvelopeRowSchema),
  prompts: v.array(SyncPromptRowSchema),
});

/** A session's slice of one batch. No `snapshot` means the entry is append-only (events and gates since the last push). */
export const SyncSessionEntrySchema = v.object({
  adw_id: v.string(),
  snapshot: v.optional(SyncSnapshotSchema),
  events: v.array(SyncEventRowSchema),
  gate_results: v.array(SyncGateRowSchema),
});

export const SyncFactorySchema = v.object({
  factory_id: v.string(),
  /** Display only. */
  name: v.string(),
  /** Normalized `host/owner/name` slug — forks and clones collapse onto one. */
  repo: v.string(),
});

export const SyncBatchSchema = v.object({
  sync_schema: v.literal(SYNC_SCHEMA_VERSION),
  spf_version: v.string(),
  level: v.picklist(SYNC_LEVELS),
  /** sha256 hex of the canonical body without `sent_at` — also sent as the `Idempotency-Key` header. */
  batch_id: v.string(),
  sent_at: v.string(),
  factory: SyncFactorySchema,
  sessions: v.array(SyncSessionEntrySchema),
});

/** `409` body (and the `GET /ingest/v1` probe body): the inclusive `[min, max]` `sync_schema` range the hub accepts. */
export const SyncSupportedSchema = v.object({
  supported: v.tuple([v.number(), v.number()]),
});

export type SyncSessionRow = v.InferOutput<typeof SyncSessionRowSchema>;
export type SyncPhaseRow = v.InferOutput<typeof SyncPhaseRowSchema>;
export type SyncAgentSessionRow = v.InferOutput<typeof SyncAgentSessionRowSchema>;
export type SyncEnvelopeRow = v.InferOutput<typeof SyncEnvelopeRowSchema>;
export type SyncEventRow = v.InferOutput<typeof SyncEventRowSchema>;
export type SyncGateRow = v.InferOutput<typeof SyncGateRowSchema>;
export type SyncPromptRow = v.InferOutput<typeof SyncPromptRowSchema>;
export type SyncSnapshot = v.InferOutput<typeof SyncSnapshotSchema>;
export type SyncSessionEntry = v.InferOutput<typeof SyncSessionEntrySchema>;
export type SyncFactory = v.InferOutput<typeof SyncFactorySchema>;
export type SyncBatch = v.InferOutput<typeof SyncBatchSchema>;
export type SyncSupported = v.InferOutput<typeof SyncSupportedSchema>;
