/**
 * The decision layer — a model-agnostic, BOUNDED advisor to piquette's
 * deterministic code. Ticket #103 (epic #102), renamed from `jev` to
 * `decisions` in #150; operator docs in `docs/decisions.md`; the brainstorm
 * that chose where it plugs in is `docs/brainstorms/jev-in-the-factory.md`.
 *
 * HOW a question is answered is a BACKEND (`decisions.backend`). Today
 * there is one, `systemone`: a "System One" typed-decision model — Jev
 * (TypeSafe's, via its own API or Cloudflare Workers AI) or a local
 * `nimble`/`tev1` through Ollama — answering `choice`/`score` questions with
 * per-option probabilities. Nothing below the client seam depends on which.
 *
 * piquette's rule is "deterministic TypeScript owns the graph — agent proposes,
 * code disposes". The decision model does not get an exception. Everything a feature needs
 * to stay inside that rule lives HERE, once, so no feature re-implements
 * (and subtly weakens) it:
 *
 *  1. OFF BY DEFAULT. No `decisions:` config (or `enabled: false`) means `decide()`
 *     returns the caller's own fallback with `reason: "disabled"` — no client
 *     is built, no network call happens, and NO trace event is written, so a
 *     run's trace is byte-identical to one from before this module existed.
 *  2. CLOSED SETS ONLY. `decide()` takes the option list from the CALLER
 *     (code builds it: an enum, an operator-declared chain menu, ...). the model's
 *     answer is only ever used if it is literally one of those values;
 *     anything else is `invalid_choice` and the fallback acts. The decision model never
 *     names a chain, step, gate, model, or command code did not offer it.
 *  3. EVERY DECISION HAS A DETERMINISTIC FALLBACK, supplied by the caller
 *     (itself a member of the option set), and used on: disabled, per-kind
 *     `off`, shadow mode, missing API key, error, timeout, malformed answer,
 *     an out-of-set choice, a choice outside `permitted`, or confidence
 *     below the threshold. `decide()` never throws for any of those — the
 *     only throws are PROGRAMMER errors in the request itself (empty option
 *     set, fallback not in the set, ...), raised before any network call so
 *     a bad call site fails its own unit test instead of a run.
 *  4. SHADOW vs ACT. `mode: shadow` calls the decision model and records what it said, but
 *     the fallback ACTS. `mode: act` lets the model's answer act, only when it
 *     passes every check in (3).
 *  5. EVERYTHING IS RECORDED. Every decision made while the decision model is enabled for
 *     its kind — shadow or act, success or failure — is handed to the
 *     `DecisionRecorder`, which for a run is `traceDecisionRecorder`: ONE
 *     `type: "log"`, `name: "decision"` event whose payload is the
 *     whole `Decision`. `findRecordedDecision` reads it back so a replay or
 *     an estimate reuses the recorded ANSWER instead of calling the decision model again
 *     (pass it as `DecisionRequest.replay`). A replay re-applies TODAY's
 *     policy to that answer — `permitted`, threshold, shadow/act — so a
 *     recorded `escalate_tier` cannot act once the caller no longer permits
 *     it, and `enabled: false` / a kind set to `off` beats any replay (the
 *     no-op in §1 has no exceptions).
 *  6. MONOTONE AUTHORITY is the CALLER's job, but `permitted` exists to make
 *     it cheap: a feature whose option set includes something the decision model may only
 *     choose under conditions (e.g. `escalate_tier` only below the spend
 *     ceiling) passes the currently-allowed subset, and an answer outside it
 *     is `not_permitted`. The decision model may add a rejection or stop early; it may never
 *     approve past a gate, drop a gate, raise a retry ceiling, or spend past
 *     an operator ceiling — no option set a feature builds may contain such
 *     a move in the first place.
 *  7. PURE MODULES STAY PURE. Resolve a decision ONCE (e.g. in `startRun`)
 *     and pass the resulting `Decision` into a pure function as data —
 *     never call `decide()` from inside `core/tiering.ts` or its peers.
 *  8. NO NETWORK IN TESTS. `DecisionClient` is an interface; tests inject
 *     `src/test/fake_decisions.ts`'s `FakeDecisionClient` either directly
 *     (`createDecider({client})`) or process-wide via `setDecisionClientFactory` for
 *     code paths (like `startRun`) that build their own `Decider`.
 *  9. NO NEW DEPENDENCY. `HttpSystemOneClient` is ~40 lines over global `fetch`;
 *     the official `@typesafe-ai/sdk` is deliberately not used.
 *
 * WIRE FORMAT (researched 2026-09-25, ten days after launch — VERIFY
 * AGAINST A LIVE RESPONSE before flipping anything to `act`): one endpoint,
 * `POST {base_url}/systemone`, `Authorization: Bearer <key>`, body
 * `{model, state, questions: {name: Question}}`, response
 * `{model, answers: {name: Answer}, usage: {input_tokens, output_tokens}}`.
 * A `choice` question's `criteria` maps option key -> description and its
 * answer is `{type:"choice", choice, probabilities, confidence}`; a `score`
 * question's `criteria` is an ORDERED array of 2-10 level descriptions and
 * its answer is `{type:"score", score, legend, probabilities, confidence}`.
 * Answers are parsed defensively (`v.looseObject`) because the exact shapes
 * are the least-verified part of that research — an answer that does not
 * parse is `invalid_response`, i.e. the fallback, never a crash. When an
 * answer carries no `confidence`, it is derived from `probabilities` with
 * TypeSafe's published formula `(n * peak - 1) / (n - 1)`; with neither, the
 * confidence is unknown and treated as below any threshold.
 *
 * NOT DONE HERE, deliberately: retries. the model's value is ~100 ms decisions; a
 * retry loop inside a 2 s timeout buys little, and every failure already has
 * a correct answer (the fallback). A 429/529 is recorded as `error` with its
 * status in `detail`, which is exactly what shadow-mode analysis should see.
 */

import { createHash } from "node:crypto";
import * as v from "valibot";
import { DecisionsConfigSchema, makeEventRecord, type EventRecord, type DecisionsConfig, type DecisionsConfigInput, type DecisionMode } from "./data_types.ts";
import { DECISION_KINDS, type DecisionKindSpec } from "./decision_kinds.ts";
import type { TraceDb } from "./trace_db.ts";

export const SYSTEM_ONE_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
/**
 * The ollama path's OWN fallback when `decisions.systemone.ollama.base_url` is empty after
 * trimming — never `SYSTEM_ONE_DEFAULT_BASE_URL` (TypeSafe's cloud API). The schema
 * (`SystemOneOllamaSchema.base_url` in data_types.ts) already rejects a blank/
 * whitespace value at config-load time, so this only matters for a `DecisionsConfig`
 * built by hand (a test, a future caller) that skips `v.parse` — defense in
 * depth, not the primary guard. Matches `SystemOneOllamaSchema`'s own default.
 */
export const SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const SYSTEM_ONE_PATH = "/systemone";
/** The ONE trace event name a decision is WRITTEN under — always `type: "log"` (see `traceDecisionRecorder` for why not a new event type). */
export const DECISION_EVENT = "decision";
/**
 * What this event was called before #150 (`jev` -> `decisions`). Rows under it
 * are persisted in local sqlite and D1 and are never migrated — every READER
 * (replay, the dashboard, `piquette estimate`) accepts both names via
 * `DECISION_EVENT_NAMES`; only WRITERS use `DECISION_EVENT`.
 */
export const LEGACY_DECISION_EVENT = "jev_decision";
export const DECISION_EVENT_NAMES: readonly string[] = [DECISION_EVENT, LEGACY_DECISION_EVENT];
/** TypeSafe's documented per-question caps. */
export const DECISIONS_MAX_CHOICE_OPTIONS = 255;
export const DECISIONS_MIN_SCORE_LEVELS = 2;
export const DECISIONS_MAX_SCORE_LEVELS = 10;

// ── wire types ──────────────────────────────────────────────────────────────

/** The unstructured context the decision model evaluates. State + questions share a ~32k-token budget per call. */
export type DecisionState = string | Record<string, unknown> | unknown[];

export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

export interface SystemOneRequest {
  model: string;
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionUsage {
  input_tokens: number;
  output_tokens: number;
}

/** `answers` values are `unknown` on purpose — parsed defensively by `decide()`, never trusted. */
export interface SystemOneResponse {
  model?: string;
  answers: Record<string, unknown>;
  usage?: Partial<DecisionUsage>;
}

/**
 * The seam every test fakes. `signal` aborts at the decision's timeout; a
 * client that ignores it is still bounded (`decide()` races it), it just
 * leaks its own socket until the server answers.
 */
export interface DecisionClient {
  systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<SystemOneResponse>;
}
/** The `backend: systemone` client contract — an alias, so a future `EmbeddingClient` sits beside it under the shared `DecisionClient` seam. */
export type SystemOneClient = DecisionClient;

/** A non-2xx HTTP answer. `status` is what shadow analysis groups on (401 key, 422 request, 429 rate, 529 overloaded). */
export class SystemOneApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`decision model: HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    this.name = "SystemOneApiError";
    this.status = status;
  }
}

/** Raised (internally) when a call outlives its `timeout_ms`; surfaces only as `reason: "timeout"`. */
export class DecisionTimeoutError extends Error {
  constructor(ms: number) {
    super(`decision model: no answer within ${ms} ms`);
    this.name = "DecisionTimeoutError";
  }
}

/**
 * Normalize `base_url`: empty (or whitespace-only) -> `defaultBaseUrl`; a
 * trailing slash is dropped so `+ "/systemone"` never doubles it.
 * `defaultBaseUrl` defaults to TypeSafe's cloud endpoint — callers resolving
 * an `ollama` base_url MUST pass `SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL` instead, so a
 * blank/whitespace `decisions.systemone.ollama.base_url` never silently falls back to
 * sending repo `state` to TypeSafe's cloud API.
 */
export function systemOneEndpoint(baseUrl: string | undefined, defaultBaseUrl: string = SYSTEM_ONE_DEFAULT_BASE_URL): string {
  const base = (baseUrl ?? "").trim() || defaultBaseUrl;
  return `${base.replace(/\/+$/, "")}${SYSTEM_ONE_PATH}`;
}

/**
 * The real client — global `fetch`, no SDK. Never logs or echoes the key:
 * an error carries only the status and a clipped response body.
 *
 * `apiKey: null` (Ollama) sends no `Authorization` header at all — a bare
 * local Ollama server has no auth of its own. `enforceOllamaLimits` turns on
 * Ollama's own wire caps (see `ollamaWireLimitProblem`), checked BEFORE the
 * body is sent so an oversized/over-optioned request never reaches the
 * network — it throws, `decide()` catches it, and the fallback acts with
 * `reason: "error"`, same as any other transport failure.
 */
export class HttpSystemOneClient implements DecisionClient {
  private readonly apiKey: string | null;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly enforceOllamaLimits: boolean;

  constructor(options: { apiKey?: string | null; baseUrl?: string; defaultBaseUrl?: string; fetchImpl?: typeof fetch; enforceOllamaLimits?: boolean }) {
    this.apiKey = options.apiKey ?? null;
    // `defaultBaseUrl` is the fallback when `baseUrl` is empty/whitespace —
    // `enforceOllamaLimits` callers (ollama) MUST pass `SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL`
    // here (see `systemOneEndpoint`'s doc comment); omitting it would silently
    // resolve to TypeSafe's cloud endpoint instead of a local Ollama server.
    this.url = systemOneEndpoint(options.baseUrl, options.defaultBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.enforceOllamaLimits = options.enforceOllamaLimits ?? false;
  }

  async systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<SystemOneResponse> {
    const body = JSON.stringify(request);
    if (this.enforceOllamaLimits) {
      const problem = ollamaWireLimitProblem(request, body);
      if (problem) throw new Error(`decision model (ollama): ${problem}`);
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetchImpl(this.url, { method: "POST", headers, body, signal: options.signal });
    const text = await response.text();
    if (!response.ok) throw new SystemOneApiError(response.status, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`decision model: response is not JSON (${text.slice(0, 120)})`);
    }
    return requireAnswers(parsed);
  }
}

/** Ollama's documented per-question cap — stricter than TypeSafe's 255/2-10 (`DECISIONS_MAX_CHOICE_OPTIONS`/`DECISIONS_MIN_SCORE_LEVELS`/`DECISIONS_MAX_SCORE_LEVELS`), so it is checked again here, against the ACTUAL wire request, not at option-set-declaration time. */
export const SYSTEM_ONE_OLLAMA_MIN_OPTIONS = 2;
export const SYSTEM_ONE_OLLAMA_MAX_OPTIONS = 26;
/** Ollama rejects an over-budget request rather than truncating it (verified 0.35) — 64 KiB, checked against the serialized UTF-8 body. */
export const SYSTEM_ONE_OLLAMA_MAX_BODY_BYTES = 64 * 1024;
/** Below this `decisions.timeout_ms`, `piquette doctor` warns about Ollama's cold-start latency (first call after a model load). */
export const SYSTEM_ONE_OLLAMA_COLD_START_TIMEOUT_MS = 5_000;
/** The Ollama version System One (`/v1/systemone`) first shipped in. */
export const SYSTEM_ONE_OLLAMA_MIN_VERSION = "0.35.0";

/** What is wrong with a request against Ollama's own wire limits, or `null`. Exported so a test can assert the exact message without round-tripping a real decision. */
export function ollamaWireLimitProblem(request: SystemOneRequest, body: string = JSON.stringify(request)): string | null {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > SYSTEM_ONE_OLLAMA_MAX_BODY_BYTES) {
    return `request body is ${bytes} bytes, over Ollama's ${SYSTEM_ONE_OLLAMA_MAX_BODY_BYTES}-byte (64 KiB) limit — Ollama rejects an oversized body rather than truncating it`;
  }
  for (const [name, question] of Object.entries(request.questions)) {
    const count = question.type === "score" ? question.criteria.length : question.type === "choice" ? Object.keys(question.criteria).length : null;
    if (count === null) continue; // a "noul" question is always a fixed true/false pair
    if (count < SYSTEM_ONE_OLLAMA_MIN_OPTIONS || count > SYSTEM_ONE_OLLAMA_MAX_OPTIONS) {
      return `question "${name}" has ${count} options, outside Ollama's ${SYSTEM_ONE_OLLAMA_MIN_OPTIONS}-${SYSTEM_ONE_OLLAMA_MAX_OPTIONS} range`;
    }
  }
  return null;
}

function requireAnswers(parsed: unknown): SystemOneResponse {
  if (!parsed || typeof parsed !== "object" || !("answers" in parsed) || !(parsed as { answers: unknown }).answers || typeof (parsed as { answers: unknown }).answers !== "object") {
    throw new Error("decision model: response has no `answers` object");
  }
  return parsed as SystemOneResponse;
}

/** Workers AI catalog id of Cloudflare's System One-compatible decision model (Clef). Jev is not in the Workers AI catalog (#164). */
export const SYSTEM_ONE_CLOUDFLARE_MODEL = "@cf/cloudflare/clef";

/**
 * Workers AI's REST endpoint for a model, or the AI Gateway endpoint in
 * front of it when `gateway` is set. Account id and gateway id are
 * URL-encoded path segments; the model id's own `/` is kept (it IS a path).
 */
export function systemOneCloudflareEndpoint(accountId: string, gateway: string, model: string = SYSTEM_ONE_CLOUDFLARE_MODEL): string {
  const account = encodeURIComponent(accountId.trim());
  const modelPath = model.trim().split("/").map(encodeURIComponent).join("/");
  const gw = gateway.trim();
  return gw
    ? `https://gateway.ai.cloudflare.com/v1/${account}/${encodeURIComponent(gw)}/workers-ai/${modelPath}`
    : `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${modelPath}`;
}

/**
 * A System One model (Clef) through Cloudflare Workers AI (optionally via AI Gateway). Same wire
 * body as TypeSafe's API minus `model` (Workers AI takes the model in the
 * URL and rejects unknown input keys), and the same `{model, answers,
 * usage}` answer — but wrapped in Cloudflare's REST envelope
 * `{result, success, errors, messages}`, which is unwrapped here so
 * `decide()` never sees a difference. A 200 with `success: false` is an
 * API error, not an empty answer. Like `HttpSystemOneClient`, the token never
 * appears in an error.
 */
export class CloudflareSystemOneClient implements DecisionClient {
  private readonly apiToken: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiToken: string; accountId: string; gateway?: string; model?: string; fetchImpl?: typeof fetch }) {
    this.apiToken = options.apiToken;
    this.url = systemOneCloudflareEndpoint(options.accountId, options.gateway ?? "", options.model);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<SystemOneResponse> {
    const { model: _model, ...body } = request;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new SystemOneApiError(response.status, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`decision model: response is not JSON (${text.slice(0, 120)})`);
    }
    if (parsed && typeof parsed === "object" && "success" in parsed) {
      const envelope = parsed as { success: unknown; result?: unknown; errors?: unknown };
      if (envelope.success !== true) throw new SystemOneApiError(response.status, JSON.stringify(envelope.errors ?? []));
      return requireAnswers(envelope.result);
    }
    return requireAnswers(parsed);
  }
}

// ── client resolution (and the one test hook) ────────────────────────────────

export type DecisionClientFactory = (config: DecisionsConfig, env: NodeJS.ProcessEnv) => DecisionClient | null;

let clientFactoryOverride: DecisionClientFactory | null = null;

/**
 * Process-wide client override, for tests whose code path builds its own
 * `Decider` (e.g. `startRun` -> `Run.decider`) where injecting a client directly is
 * not practical. Pass `null` to restore the real behavior — always do so in
 * a `finally`/`after`. An override skips the API-key check (a fake needs no
 * key). NEVER call this from non-test code.
 */
export function setDecisionClientFactory(factory: DecisionClientFactory | null): void {
  clientFactoryOverride = factory;
}

/** The env var names a provider needs, in the order an operator would set them. Empty for `ollama` — a bare local server has no auth of its own. */
export function systemOneCredentialEnvs(config: DecisionsConfig): string[] {
  if (config.systemone.provider === "cloudflare") return [config.systemone.cloudflare.api_token_env, config.systemone.cloudflare.account_id_env];
  if (config.systemone.provider === "ollama") return [];
  return [config.systemone.api_key_env];
}

/** Which of `systemOneCredentialEnvs` are unset/blank — empty means a real client can be built. */
export function missingSystemOneCredentials(config: DecisionsConfig, env: NodeJS.ProcessEnv): string[] {
  return systemOneCredentialEnvs(config).filter((name) => !env[name]?.trim());
}

function notSet(names: string[]): string {
  return names.length > 1 ? `${names.join(", ")} are not set` : `${names[0] ?? "credentials"} is not set`;
}

/** The URL a real call would hit — for doctor and diagnostics only (the clients build their own). */
export function systemOneResolvedEndpoint(config: DecisionsConfig, env: NodeJS.ProcessEnv): string {
  if (config.systemone.provider === "ollama") return systemOneEndpoint(config.systemone.ollama.base_url, SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL);
  if (config.systemone.provider !== "cloudflare") return systemOneEndpoint(config.systemone.base_url);
  const cf = config.systemone.cloudflare;
  const accountId = env[cf.account_id_env]?.trim();
  // An unset account renders as a readable `<ENV_NAME>` hole, not its URL-encoded `%3C...%3E`.
  return accountId ? systemOneCloudflareEndpoint(accountId, cf.gateway, cf.model) : systemOneCloudflareEndpoint("ACCOUNT", cf.gateway, cf.model).replace("ACCOUNT", `<${cf.account_id_env}>`);
}

/**
 * Explicit client > test override > the provider's real client > `null`
 * (every decision then falls back with `no_api_key`) — except `ollama`,
 * which has no credential to be missing and so always resolves to a real
 * client (its own wire limits are enforced inside `HttpSystemOneClient`, not here).
 */
function resolveClient(config: DecisionsConfig, env: NodeJS.ProcessEnv, explicit: DecisionClient | null | undefined): DecisionClient | null {
  if (explicit) return explicit;
  if (clientFactoryOverride) return clientFactoryOverride(config, env);
  if (config.systemone.provider === "ollama") {
    return new HttpSystemOneClient({ apiKey: null, baseUrl: config.systemone.ollama.base_url, defaultBaseUrl: SYSTEM_ONE_OLLAMA_DEFAULT_BASE_URL, enforceOllamaLimits: true });
  }
  if (config.systemone.provider === "cloudflare") {
    const cf = config.systemone.cloudflare;
    const apiToken = env[cf.api_token_env]?.trim();
    const accountId = env[cf.account_id_env]?.trim();
    if (!apiToken || !accountId) return null;
    return new CloudflareSystemOneClient({ apiToken, accountId, gateway: cf.gateway, model: cf.model });
  }
  const apiKey = env[config.systemone.api_key_env]?.trim();
  if (!apiKey) return null;
  return new HttpSystemOneClient({ apiKey, baseUrl: config.systemone.base_url });
}

// ── policy ─────────────────────────────────────────────────────────────────

/** The fully-resolved knobs for ONE decision kind — global `decisions:` values with `decisions.kinds.<kind>` layered on top. */
export interface DecisionPolicy {
  kind: string;
  /** `decisions.backend` — stamped onto every recorded decision. */
  backend: string;
  /** The transport behind the backend (`typesafe` | `cloudflare` | `ollama` for `systemone`) — stamped onto every recorded decision. */
  provider: string;
  /** `off` whenever `decisions.enabled` is false, regardless of any per-kind override. */
  mode: DecisionMode;
  threshold: number;
  timeout_ms: number;
  model: string;
  /** Everything in `decisions.kinds.<kind>` except `mode`/`threshold`/`timeout_ms` — the feature's own settings, unvalidated. Use `parseDecisionExtras`. */
  extras: Record<string, unknown>;
}

const COMMON_OVERRIDE_KEYS = new Set(["mode", "threshold", "timeout_ms"]);

/** Parse-with-defaults, so callers holding a partial/absent block (tests, `SFConfig["decisions"]` from an older build) get the same answer. */
export function normalizeDecisionsConfig(config: DecisionsConfigInput | null | undefined): DecisionsConfig {
  return v.parse(DecisionsConfigSchema, config ?? {});
}

export function resolveDecisionPolicy(config: DecisionsConfigInput | null | undefined, kind: string): DecisionPolicy {
  return policyFor(normalizeDecisionsConfig(config), kind);
}

/** `resolveDecisionPolicy` over an ALREADY-normalized config — no schema parse. `Decider` holds a normalized config, so a 200-item batch costs 200 cheap lookups, not 200 parses. */
function policyFor(cfg: DecisionsConfig, kind: string): DecisionPolicy {
  const override = cfg.kinds[kind] ?? {};
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(override)) {
    if (!COMMON_OVERRIDE_KEYS.has(key)) extras[key] = value;
  }
  return {
    kind,
    backend: cfg.backend,
    provider: cfg.systemone.provider,
    mode: cfg.enabled ? (override.mode ?? cfg.mode) : "off",
    threshold: override.threshold ?? cfg.threshold,
    timeout_ms: override.timeout_ms ?? cfg.timeout_ms,
    model: cfg.systemone.model,
    extras,
  };
}

/**
 * A feature's own settings from `decisions.kinds.<kind>`, parsed with the
 * schema its `decision_kinds.ts` spec declares. Throws a config-shaped error
 * (`decisions.kinds.<kind>: ...`) — call it at load/startRun time, not deep in
 * a phase. A spec with no `extras` schema returns `{}`-typed extras as-is.
 */
export function parseDecisionExtras<E>(config: DecisionsConfigInput | null | undefined, spec: Pick<DecisionKindSpec<E>, "kind" | "extras">): E {
  const { extras } = resolveDecisionPolicy(config, spec.kind);
  if (!spec.extras) return extras as E;
  const result = v.safeParse(spec.extras, extras);
  if (!result.success) {
    const issues = result.issues.map((i) => `${i.path?.map((p) => String(p.key)).join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`decisions.kinds.${spec.kind}: ${issues}`);
  }
  return result.output;
}

// ── decisions ──────────────────────────────────────────────────────────────

/** One member of a closed option set. `description` is what the decision model reads; `value` is what code acts on. */
export interface DecisionOption<T extends string = string> {
  value: T;
  description: string;
}

/**
 * Why the fallback acted instead of the model's answer — checked in THIS order,
 * first match wins, so `reason` names the EARLIEST thing that disqualified
 * the model's answer. In shadow mode that makes `reason: "shadow"` mean "the decision model
 * answered validly and confidently — act mode WOULD have used it", which is
 * the number shadow-mode analysis actually wants (see `would_act`).
 */
export const FALLBACK_REASONS = [
  "disabled", // decisions.enabled false (or no decisions: block) — nothing called, nothing recorded
  "kind_off", // decisions.kinds.<kind>.mode: off — nothing called, nothing recorded
  "replay_missing", // replay requested (`replay: null`) but nothing was recorded — nothing called
  "no_api_key", // enabled, but the key env var is unset — nothing called
  "timeout",
  "error", // transport / HTTP / non-JSON — `detail` has the message (and status)
  "invalid_response", // answer missing or not the shape the question type returns
  "invalid_choice", // answered with a value outside the closed option set
  "not_permitted", // in the set, but outside the caller's `permitted` subset
  "low_confidence", // below threshold, or confidence unknown
  "shadow", // valid + confident + permitted, but mode is shadow
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export type DecisionQuestionType = "choice" | "score";

export interface DecisionRequest<T extends string = string> {
  /** The decision kind — register it in `core/decision_kinds.ts`. Selects `decisions.kinds.<kind>` policy. */
  kind: string;
  /**
   * Disambiguates repeated decisions of one kind in one run (e.g. `"fix_2"`),
   * so a replay finds the right one. Default `""`. MUST be stable across
   * runs for the same logical question — a finding fingerprint, a round
   * number — NEVER an array index: replay looks up the latest (kind, key)
   * match, so an index key replays the wrong item once the list reorders.
   */
  key?: string;
  /** Default `"choice"`. For `"score"`, `options` is the rubric in ORDER (lowest level first), 2-10 levels. */
  question?: DecisionQuestionType;
  /** The CLOSED set, built by code. Non-empty, unique values, ≤255 (choice) / 2-10 (score). */
  options: readonly DecisionOption<T>[];
  /** The question itself — what the decision model is asked to decide about `state`. */
  instructions: string;
  /** The context the decision model reads (issue body, findings, prompt, ...). Not recorded — only its sha256 is. */
  state: DecisionState;
  /** The deterministic answer. Must be one of `options`. This is what acts whenever the model's answer may not. */
  fallback: T;
  /** Optional subset of `options` the model's answer may ACT on right now (see header §6). Must contain `fallback`. */
  permitted?: readonly T[];
  /**
   * `undefined` (the default): live — call the decision model per policy.
   * A recorded `Decision` (from `findRecordedDecision`): reuse its ANSWER,
   *   no call — provided its kind/key/question/options/fallback still match
   *   this request (else `replay_missing`). The answer is re-judged under
   *   the CURRENT policy and `permitted` (a recorded failure — timeout,
   *   error, ... — replays as that same failure). `input_sha256` is NOT
   *   part of the match (see `Decision.input_sha256`).
   * `null`: replay requested but nothing recorded — fallback, no call.
   * Either way `enabled: false` / kind `off` wins first: `disabled` /
   * `kind_off`, nothing recorded.
   */
  replay?: Decision | null;
  /** Phase this decision belongs to, for the trace event. Default `""` (run-scoped). */
  phase_id?: string;
}

/** A `DecisionRequest` minus `state`, for `decideBatch` (which shares one state across its items). */
export type DecisionBatchItem<T extends string = string> = Omit<DecisionRequest<T>, "state">;

export interface Decision<T extends string = string> {
  kind: string;
  key: string;
  question: DecisionQuestionType;
  options: T[];
  /** THE EFFECTIVE CHOICE — what code acts on. the model's answer when `used_fallback` is false, else `fallback`. */
  choice: T;
  /** What the decision model answered, if it answered with a member of `options`; else `null`. Shadow analysis compares this to `fallback`. */
  model_choice: T | null;
  /**
   * How this decision was answered — `decisions.backend` (`"systemone"`)
   * and the transport behind it (`"typesafe" | "cloudflare" | "ollama"`).
   * `null` on a row recorded before #150 (which had neither field).
   */
  backend: string | null;
  provider: string | null;
  /** 0-1, as reported (or derived from probabilities); `null` when the decision model was not called or reported none. */
  confidence: number | null;
  /** For a score question: the model's continuous probability-weighted score, as returned. `null` otherwise. */
  score: number | null;
  /** Per-option probabilities as returned (keys are option values for choice; level indices for score). */
  probabilities: Record<string, number> | null;
  fallback: T;
  used_fallback: boolean;
  /** `null` exactly when `used_fallback` is false. */
  reason: FallbackReason | null;
  /** Human-readable context for `reason` (error message, confidence vs threshold, ...). Never contains the API key. */
  detail: string;
  /** True when act mode would have used the model's answer (valid + confident + permitted) — independent of the actual mode. */
  would_act: boolean;
  /** `model_choice === fallback`, or `null` when there is no `model_choice`. */
  agrees: boolean | null;
  latency_ms: number;
  mode: DecisionMode;
  threshold: number;
  model: string | null;
  usage: DecisionUsage | null;
  /**
   * sha256 of `{state, instructions, options}`, for OFFLINE analysis only
   * (e.g. "did the input change between these two runs?"). Replay does NOT
   * compare it — replay identity is (kind, key, question, options,
   * fallback) — because any state formatting change would otherwise break
   * every replay. `""` on a `disabled` / `kind_off` decision (never
   * recorded, so never hashed).
   */
  input_sha256: string;
  /** True when this Decision was reused from the trace rather than decided now. */
  replayed: boolean;
}

/** Receives every decision made while the decision model is enabled for its kind. Errors are swallowed (see `Decider.record`). */
export type DecisionRecorder = (decision: Decision, meta: { phase_id: string }) => void | Promise<void>;

/**
 * What is wrong with an option set + fallback (+ `permitted`), or `null` if
 * nothing is. This is exactly the check `decide()` throws on — exported so
 * a feature whose options come from RUN-TIME or OPERATOR data (a chain menu
 * from `watch.chains`, one option per finding, ...) can test the set FIRST
 * and, when it is degenerate (empty, duplicated, missing the fallback),
 * skip `decide()` and use its heuristic directly. `decide()` throwing is
 * meant for statically-built sets, where it fails the call site's own unit
 * test; a thrown error from operator data would turn a run that worked
 * with no `decisions:` block into a crash (invariant 1).
 */
export function optionSetProblem<T extends string>(
  options: readonly DecisionOption<T>[],
  fallback: T,
  extra: { question?: DecisionQuestionType; permitted?: readonly T[] } = {},
): string | null {
  const question = extra.question ?? "choice";
  const values = options.map((o) => o.value);
  if (values.length === 0) return "options is empty";
  if (new Set(values).size !== values.length) return "duplicate option values";
  if (values.some((value) => typeof value !== "string" || value.length === 0)) return "every option value must be a non-empty string";
  if (question === "choice" && values.length > DECISIONS_MAX_CHOICE_OPTIONS) return `at most ${DECISIONS_MAX_CHOICE_OPTIONS} choice options`;
  if (question === "score" && (values.length < DECISIONS_MIN_SCORE_LEVELS || values.length > DECISIONS_MAX_SCORE_LEVELS)) {
    return `a score rubric needs ${DECISIONS_MIN_SCORE_LEVELS}-${DECISIONS_MAX_SCORE_LEVELS} levels`;
  }
  if (!values.includes(fallback)) return `fallback ${JSON.stringify(fallback)} is not one of the options`;
  if (extra.permitted) {
    const stray = extra.permitted.filter((p) => !values.includes(p));
    if (stray.length > 0) return `permitted names non-options ${JSON.stringify(stray)}`;
    if (!extra.permitted.includes(fallback)) return "permitted must include the fallback";
  }
  return null;
}

/** `optionSetProblem(...) === null` — the guard a run-time-built option set goes through before `decide()`. */
export function isValidOptionSet<T extends string>(
  options: readonly DecisionOption<T>[],
  fallback: T,
  extra: { question?: DecisionQuestionType; permitted?: readonly T[] } = {},
): boolean {
  return optionSetProblem(options, fallback, extra) === null;
}

/** Programmer-error checks — see header §3. Runs even when the decision model is disabled, so a bad call site fails its own unit test. */
function validateRequest<T extends string>(item: DecisionBatchItem<T>): void {
  if (!item.kind) throw new Error("decide(): kind is required");
  const problem = optionSetProblem(item.options, item.fallback, { question: item.question, permitted: item.permitted });
  if (problem !== null) throw new Error(`decide(${JSON.stringify(item.kind)}): ${problem}`);
}

function inputDigest(state: DecisionState, item: DecisionBatchItem): string {
  return createHash("sha256")
    .update(JSON.stringify({ state, instructions: item.instructions, options: item.options }))
    .digest("hex");
}

function toQuestion(item: DecisionBatchItem): DecisionQuestion {
  if ((item.question ?? "choice") === "score") {
    return { type: "score", instructions: item.instructions, criteria: item.options.map((o) => o.description) };
  }
  return { type: "choice", instructions: item.instructions, criteria: Object.fromEntries(item.options.map((o) => [o.value, o.description])) };
}

const ProbabilitiesSchema = v.record(v.string(), v.number());
const ChoiceAnswerSchema = v.looseObject({
  choice: v.string(),
  probabilities: v.optional(ProbabilitiesSchema),
  confidence: v.optional(v.number()),
});
const ScoreAnswerSchema = v.looseObject({
  score: v.optional(v.number()),
  legend: v.optional(v.record(v.string(), v.string())),
  probabilities: v.optional(ProbabilitiesSchema),
  confidence: v.optional(v.number()),
});

/** TypeSafe's published confidence formula: `(n * peak - 1) / (n - 1)` — 0 for a uniform spread, 1 for certainty. */
export function confidenceFromProbabilities(probabilities: Record<string, number>, n: number): number | null {
  const values = Object.values(probabilities);
  if (values.length === 0 || n < 2) return null;
  const peak = Math.max(...values);
  return Math.min(1, Math.max(0, (n * peak - 1) / (n - 1)));
}

interface ParsedAnswer {
  /** Raw answered value (may be outside the option set — checked by the caller). `null` = unparseable. */
  value: string | null;
  confidence: number | null;
  score: number | null;
  probabilities: Record<string, number> | null;
  problem: string;
}

/**
 * Map a score answer onto a rubric level. Level keys in `probabilities`/
 * `legend` are indices whose BASE (0 or 1) the research could not pin down,
 * so it is inferred: from `legend`'s keys when present, else from
 * `probabilities`' keys, else 0. The level is the probability argmax when
 * probabilities exist (the continuous `score` is a weighted mean and can
 * sit between levels), else `round(score)`.
 */
function parseScoreAnswer(answer: unknown, options: readonly DecisionOption[]): ParsedAnswer {
  const parsed = v.safeParse(ScoreAnswerSchema, answer);
  if (!parsed.success) return { value: null, confidence: null, score: null, probabilities: null, problem: "score answer did not parse" };
  const { score, legend, probabilities, confidence } = parsed.output;
  const indexKeys = Object.keys(legend ?? probabilities ?? {})
    .map(Number)
    .filter((n) => Number.isInteger(n));
  const base = indexKeys.length > 0 && Math.min(...indexKeys) === 1 ? 1 : 0;
  let index: number | null = null;
  if (probabilities && Object.keys(probabilities).length > 0) {
    const [bestKey] = Object.entries(probabilities).reduce((best, entry) => (entry[1] > best[1] ? entry : best));
    const byDescription = options.findIndex((o) => o.description === bestKey);
    const asIndex = bestKey.trim() === "" ? Number.NaN : Number(bestKey);
    if (byDescription < 0 && !Number.isInteger(asIndex)) {
      // A wire-shape problem, not "the model answered outside the set" — file it
      // under invalid_response so shadow analysis groups it correctly.
      const derived = confidence ?? confidenceFromProbabilities(probabilities, options.length);
      return { value: null, confidence: derived, score: score ?? null, probabilities, problem: "score probabilities keyed by neither level index nor description" };
    }
    index = byDescription >= 0 ? byDescription : asIndex - base;
  } else if (typeof score === "number") {
    index = Math.round(score) - base;
  }
  const derived = confidence ?? (probabilities ? confidenceFromProbabilities(probabilities, options.length) : null);
  if (index === null || !Number.isInteger(index) || index < 0 || index >= options.length) {
    return { value: `level:${String(index)}`, confidence: derived, score: score ?? null, probabilities: probabilities ?? null, problem: `score level ${String(index)} is outside the ${options.length}-level rubric` };
  }
  return { value: options[index]!.value, confidence: derived, score: score ?? null, probabilities: probabilities ?? null, problem: "" };
}

function parseAnswer(answer: unknown, item: DecisionBatchItem): ParsedAnswer {
  if (answer === undefined || answer === null) return { value: null, confidence: null, score: null, probabilities: null, problem: "no answer for this question" };
  if ((item.question ?? "choice") === "score") return parseScoreAnswer(answer, item.options);
  const parsed = v.safeParse(ChoiceAnswerSchema, answer);
  if (!parsed.success) return { value: null, confidence: null, score: null, probabilities: null, problem: "choice answer did not parse" };
  const { choice, probabilities, confidence } = parsed.output;
  const derived = confidence ?? (probabilities ? confidenceFromProbabilities(probabilities, item.options.length) : null);
  return { value: choice, confidence: derived, score: null, probabilities: probabilities ?? null, problem: "" };
}

function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function baseDecision<T extends string>(item: DecisionBatchItem<T>, policy: DecisionPolicy, digest: string): Decision<T> {
  return {
    kind: item.kind,
    key: item.key ?? "",
    question: item.question ?? "choice",
    options: item.options.map((o) => o.value),
    choice: item.fallback,
    model_choice: null,
    backend: policy.backend,
    provider: policy.provider,
    confidence: null,
    score: null,
    probabilities: null,
    fallback: item.fallback,
    used_fallback: true,
    reason: null,
    detail: "",
    would_act: false,
    agrees: null,
    latency_ms: 0,
    mode: policy.mode,
    threshold: policy.threshold,
    model: null,
    usage: null,
    input_sha256: digest,
    replayed: false,
  };
}

function withFallback<T extends string>(decision: Decision<T>, reason: FallbackReason, detail: string): Decision<T> {
  return { ...decision, choice: decision.fallback, used_fallback: true, reason, detail };
}

/** Turn one parsed answer into the final Decision — the whole shadow/act/threshold/permitted policy, in `FALLBACK_REASONS` order. */
function judge<T extends string>(decision: Decision<T>, item: DecisionBatchItem<T>, policy: DecisionPolicy, answer: ParsedAnswer): Decision<T> {
  const values: readonly string[] = decision.options;
  const out: Decision<T> = { ...decision, confidence: answer.confidence, score: answer.score, probabilities: answer.probabilities };
  if (answer.value === null) return withFallback(out, "invalid_response", answer.problem);
  if (!values.includes(answer.value)) {
    return withFallback(out, "invalid_choice", answer.problem || `answered ${JSON.stringify(answer.value)}, not one of ${JSON.stringify(values)}`);
  }
  const modelChoice = answer.value as T;
  out.model_choice = modelChoice;
  out.agrees = modelChoice === item.fallback;
  if (item.permitted && !item.permitted.includes(modelChoice)) {
    return withFallback(out, "not_permitted", `answered ${JSON.stringify(modelChoice)}, permitted now: ${JSON.stringify(item.permitted)}`);
  }
  if (answer.confidence === null || answer.confidence < policy.threshold) {
    return withFallback(out, "low_confidence", `confidence ${answer.confidence === null ? "unknown" : answer.confidence.toFixed(3)} < threshold ${policy.threshold}`);
  }
  out.would_act = true;
  if (policy.mode === "shadow") return withFallback(out, "shadow", `shadow: the decision model chose ${JSON.stringify(modelChoice)}, fallback ${JSON.stringify(item.fallback)} acts`);
  return { ...out, choice: modelChoice, used_fallback: false, reason: null, detail: "" };
}

/**
 * Replay: reuse a recorded ANSWER without calling the decision model, then re-judge it
 * under TODAY's policy and `permitted` — the same `judge()` a live answer
 * goes through. That is what keeps invariant 6 intact on replay: an
 * `escalate_tier` recorded under the spend ceiling is `not_permitted` when
 * replayed above it, and a kind moved back to `shadow` does not act on an
 * old answer. Under an unchanged policy the effective choice is identical
 * to the recorded one. A recorded failure (no `model_choice`: timeout,
 * error, invalid answer, no key) replays as that same failure, fallback
 * acting. Latency/model/usage are the recorded call's; `input_sha256` is
 * today's input (compare it with the recorded one offline to see drift).
 */
function replayed<T extends string>(base: Decision<T>, item: DecisionBatchItem<T>, policy: DecisionPolicy): Decision<T> {
  const recorded = item.replay!;
  const values: readonly string[] = base.options;
  const matches =
    recorded.kind === item.kind &&
    recorded.key === (item.key ?? "") &&
    recorded.question === base.question &&
    recorded.fallback === item.fallback &&
    sameOptions(recorded.options, base.options) &&
    values.includes(recorded.choice) &&
    (recorded.model_choice === null || values.includes(recorded.model_choice));
  if (!matches) {
    // A recorded decision for a DIFFERENT question is not a replay of this
    // one — fall back rather than act on a stale answer, and say why.
    return withFallback({ ...base, replayed: true }, "replay_missing", "recorded decision does not match this request (kind/key/question/options/fallback changed)");
  }
  const carried: Decision<T> = { ...base, replayed: true, latency_ms: recorded.latency_ms, model: recorded.model, usage: recorded.usage, backend: recorded.backend, provider: recorded.provider };
  if (recorded.model_choice === null) {
    const reason: FallbackReason =
      recorded.reason === null || recorded.reason === "disabled" || recorded.reason === "kind_off" ? "replay_missing" : recorded.reason;
    return withFallback(
      { ...carried, confidence: recorded.confidence, score: recorded.score, probabilities: recorded.probabilities },
      reason,
      recorded.detail || "recorded decision had no usable model answer",
    );
  }
  return judge(carried, item, policy, {
    value: recorded.model_choice,
    confidence: recorded.confidence,
    score: recorded.score,
    probabilities: recorded.probabilities,
    problem: "",
  });
}

function describeError(error: unknown): { reason: "timeout" | "error"; detail: string } {
  if (error instanceof DecisionTimeoutError) return { reason: "timeout", detail: error.message };
  if (error instanceof Error && error.name === "AbortError") return { reason: "timeout", detail: "decision model: aborted at timeout" };
  if (error instanceof SystemOneApiError) return { reason: "error", detail: error.message };
  return { reason: "error", detail: error instanceof Error ? error.message : String(error) };
}

function nowMs(): number {
  return performance.now();
}

export interface DeciderOptions {
  /** `cfg.kinds` — absent/partial is fine (normalized with defaults, i.e. disabled). */
  config?: DecisionsConfigInput | null;
  /** Inject a client (tests: `FakeDecisionClient`). Skips the API-key requirement. */
  client?: DecisionClient | null;
  /** Where the API key is read from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Receives every recorded decision — `traceDecisionRecorder(...)` for a run. */
  recorder?: DecisionRecorder | null;
}

/**
 * One configured Decider — config + (lazily) a client + a recorder. Cheap to
 * construct: nothing touches the network or the env until a decision is
 * actually made with the decision model enabled for its kind. `Run.decider` is one of these,
 * already wired to the run's trace.
 */
export class Decider {
  readonly config: DecisionsConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly explicitClient: DecisionClient | null;
  private readonly recorder: DecisionRecorder | null;
  private client: DecisionClient | null | undefined = undefined;
  private recordErrorWarned = false;

  constructor(options: DeciderOptions = {}) {
    this.config = normalizeDecisionsConfig(options.config);
    this.env = options.env ?? process.env;
    this.explicitClient = options.client ?? null;
    this.recorder = options.recorder ?? null;
  }

  /** Same config/client/env, different recorder — e.g. a `Decider` built before its run's tracer existed. */
  withRecorder(recorder: DecisionRecorder | null): Decider {
    return new Decider({ config: this.config, client: this.explicitClient, env: this.env, recorder });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  policy(kind: string): DecisionPolicy {
    return policyFor(this.config, kind);
  }

  /** One decision, one call. See the module header for the full contract. */
  async decide<T extends string>(request: DecisionRequest<T>): Promise<Decision<T>> {
    const { state, ...item } = request;
    const [decision] = await this.decideBatch(state, [item]);
    return decision!;
  }

  /**
   * Several decisions over ONE shared `state`, in ONE HTTP call — TypeSafe's
   * headline feature (questions are answered in parallel and in isolation,
   * so a batch costs little more latency than one question). Each item gets
   * its own policy, fallback, and trace event exactly as if decided alone;
   * items whose kind is off/disabled or which carry a `replay` never reach
   * the wire. The call's timeout is the LARGEST `timeout_ms` among the live
   * items (one request can only have one deadline). Results are in item order.
   * Items may mix kinds; each is judged under its own kind's policy.
   *
   * Order of precedence per item (matches `FALLBACK_REASONS`): disabled ->
   * kind_off -> replay (a recorded Decision, or `null` = replay_missing) ->
   * live. So `enabled: false` is a total no-op even for a caller that
   * passes a recorded decision: nothing acts but the fallback, nothing is
   * recorded, and `state` is never even hashed (no O(state) work while off).
   */
  async decideBatch<T extends string>(state: DecisionState, items: readonly DecisionBatchItem<T>[]): Promise<Decision<T>[]> {
    for (const item of items) validateRequest(item);
    const results: Decision<T>[] = new Array(items.length);
    const policies = items.map((item) => policyFor(this.config, item.kind));
    const digests: Array<string | undefined> = new Array(items.length);
    const digest = (i: number): string => (digests[i] ??= inputDigest(state, items[i]!));
    const live: number[] = [];

    items.forEach((item, i) => {
      const policy = policies[i]!;
      if (!this.config.enabled) {
        results[i] = withFallback(baseDecision(item, policy, ""), "disabled", "");
      } else if (policy.mode === "off") {
        results[i] = withFallback(baseDecision(item, policy, ""), "kind_off", `decisions.kinds.${item.kind}.mode is off`);
      } else if (item.replay) {
        results[i] = replayed(baseDecision(item, policy, digest(i)), item, policy);
      } else if (item.replay === null) {
        results[i] = withFallback(baseDecision(item, policy, digest(i)), "replay_missing", "replay requested, no recorded decision");
      } else {
        live.push(i);
      }
    });

    if (live.length > 0) {
      if (this.client === undefined) this.client = resolveClient(this.config, this.env, this.explicitClient);
      const client = this.client;
      if (!client) {
        for (const i of live) {
          results[i] = withFallback(baseDecision(items[i]!, policies[i]!, digest(i)), "no_api_key", notSet(missingSystemOneCredentials(this.config, this.env)));
        }
      } else {
        await this.callLive(client, state, items, live, policies, digest, results);
      }
    }

    // Record everything the decision model was enabled for — see header §1/§5. `disabled`
    // and `kind_off` are never recorded: that is the "off is a total no-op"
    // guarantee, in the trace as well as on the wire.
    for (let i = 0; i < items.length; i++) {
      const decision = results[i]!;
      if (decision.reason === "disabled" || decision.reason === "kind_off") continue;
      await this.record(decision, items[i]!.phase_id ?? "");
    }
    return results;
  }

  private async callLive<T extends string>(
    client: DecisionClient,
    state: DecisionState,
    items: readonly DecisionBatchItem<T>[],
    live: number[],
    policies: readonly DecisionPolicy[],
    digest: (i: number) => string,
    results: Decision<T>[],
  ): Promise<void> {
    const questions: Record<string, DecisionQuestion> = {};
    for (const i of live) questions[`q${i}`] = toQuestion(items[i]!);
    const timeoutMs = Math.max(...live.map((i) => policies[i]!.timeout_ms));
    // `decisions.systemone.model` (default `jev-latest`) is a TypeSafe catalog id Ollama does
    // not serve — `decisions.systemone.ollama.model` (default `nimble`) goes in the body
    // instead, same as `decisions.systemone.cloudflare.model` is what Workers AI's URL takes
    // (and which `CloudflareSystemOneClient` strips back out of the body itself).
    const requestModel = this.config.systemone.provider === "ollama" ? this.config.systemone.ollama.model : this.config.systemone.model;
    const request: SystemOneRequest = { model: requestModel, state, questions };

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const started = nowMs();
    let response: SystemOneResponse | null = null;
    let failure: unknown = null;
    try {
      const call = Promise.resolve().then(() => client.systemOne(request, { signal: controller.signal }));
      call.catch(() => {}); // a late rejection after the timeout won the race must never be unhandled
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DecisionTimeoutError(timeoutMs));
        }, timeoutMs);
        // Deliberately NOT unref'd: a caller is awaiting this decision, so
        // the deadline must keep the loop alive until it fires — an unref'd
        // timer beside a handle-less hung call would let the process exit
        // mid-decision. It is always cleared in `finally` below.
      });
      response = await Promise.race([call, deadline]);
    } catch (error) {
      failure = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const latency = Math.round(nowMs() - started);
    const usage: DecisionUsage | null = response?.usage
      ? { input_tokens: response.usage.input_tokens ?? 0, output_tokens: response.usage.output_tokens ?? 0 }
      : null;

    for (const i of live) {
      const item = items[i]!;
      const policy = policies[i]!;
      const base: Decision<T> = { ...baseDecision(item, policy, digest(i)), latency_ms: latency, model: response?.model ?? requestModel, usage };
      if (failure !== null || !response) {
        const { reason, detail } = describeError(failure);
        results[i] = withFallback(base, reason, detail);
        continue;
      }
      results[i] = judge(base, item, policy, parseAnswer(response.answers?.[`q${i}`], item));
    }
  }

  /** Never throws: a trace-write failure must not turn an advisory decision into a failed phase. Warns once per `Decider`. */
  private async record(decision: Decision, phaseId: string): Promise<void> {
    if (!this.recorder) return;
    try {
      await this.recorder(decision, { phase_id: phaseId });
    } catch (error) {
      if (!this.recordErrorWarned) {
        this.recordErrorWarned = true;
        process.stderr.write(`[piquette] decisions: could not record a decision (${(error as Error).message}) — continuing\n`);
      }
    }
  }
}

export function createDecider(options: DeciderOptions = {}): Decider {
  return new Decider(options);
}

/** Free-function form of `Decider.decide`, for call sites that hold a `Decider` but read better as `decide(decider, {...})`. */
export function decide<T extends string>(decider: Decider, request: DecisionRequest<T>): Promise<Decision<T>> {
  return decider.decide(request);
}

// ── trace: record + look up ──────────────────────────────────────────────────

/**
 * The event a decision is recorded as. `type: "log"` with `name:
 * "decision"`, NOT a new `EventRecordType`: that picklist is closed and
 * mirrored by the UI (data_types.ts's EVENT_RECORD_TYPES <->
 * ui/shared/types.ts's EventType — `tiering.test.ts` pins it), and a
 * decision is a note about the run, not a new lifecycle stage — the same
 * reasoning `startRun`'s `chain_source` and `tiering` events follow. The UI
 * already renders log payloads generically. otel never exports `log`
 * events, so decision payloads (which name every option value and the
 * fallback) stay local.
 */
export function decisionEventRecord(decision: Decision, adwId: string, phaseId = ""): EventRecord {
  return makeEventRecord({
    adw_id: adwId,
    phase_id: phaseId,
    type: "log",
    name: DECISION_EVENT,
    payload: { ...decision } as unknown as Record<string, unknown>,
  });
}

/** The recorder a run uses — `Run` wires one into `run.decider`. `phase_id` comes from the request, not from here. */
export function traceDecisionRecorder(tracer: { event(record: EventRecord): Promise<string> }, adwId: string): DecisionRecorder {
  return async (decision, meta) => {
    await tracer.event(decisionEventRecord(decision, adwId, meta.phase_id));
  };
}

/** `jev_choice` -> `model_choice` on a pre-#150 payload. Anything that is not a plain object is returned untouched (the schema rejects it). */
export function upgradeLegacyDecisionPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !("jev_choice" in payload)) return payload;
  const { jev_choice: legacyChoice, ...rest } = payload as Record<string, unknown>;
  return "model_choice" in rest ? rest : { ...rest, model_choice: legacyChoice };
}

const RecordedDecisionSchema = v.looseObject({
  kind: v.string(),
  key: v.optional(v.string(), ""),
  question: v.optional(v.picklist(["choice", "score"]), "choice"),
  options: v.array(v.string()),
  choice: v.string(),
  model_choice: v.optional(v.nullable(v.string()), null),
  backend: v.optional(v.nullable(v.string()), null),
  provider: v.optional(v.nullable(v.string()), null),
  confidence: v.optional(v.nullable(v.number()), null),
  score: v.optional(v.nullable(v.number()), null),
  probabilities: v.optional(v.nullable(v.record(v.string(), v.number())), null),
  fallback: v.string(),
  used_fallback: v.boolean(),
  reason: v.optional(v.nullable(v.picklist(FALLBACK_REASONS)), null),
  detail: v.optional(v.string(), ""),
  would_act: v.optional(v.boolean(), false),
  agrees: v.optional(v.nullable(v.boolean()), null),
  latency_ms: v.optional(v.number(), 0),
  mode: v.picklist(["off", "shadow", "act"]),
  threshold: v.optional(v.number(), 0),
  model: v.optional(v.nullable(v.string()), null),
  usage: v.optional(v.nullable(v.object({ input_tokens: v.number(), output_tokens: v.number() })), null),
  input_sha256: v.optional(v.string(), ""),
  replayed: v.optional(v.boolean(), false),
});

/**
 * A `decision` (or pre-#150 `jev_decision`) payload back into a `Decision`,
 * or `null` if it is not one (older/foreign/corrupt row). A legacy payload
 * names the model's answer `jev_choice`; it is read as `model_choice` (and
 * the legacy key dropped from the result), so an old row replays exactly
 * like the new one it would be today. When BOTH keys are present
 * `model_choice` wins.
 */
export function parseRecordedDecision(payload: unknown): Decision | null {
  const parsed = v.safeParse(RecordedDecisionSchema, upgradeLegacyDecisionPayload(payload));
  if (!parsed.success) return null;
  const out = parsed.output;
  if (!out.options.includes(out.choice) || !out.options.includes(out.fallback)) return null;
  return out as Decision;
}

export interface RecordedEventLike {
  type: string;
  name: string;
  payload: unknown;
}

/** Every recorded decision in `events` (in-memory rows, a parsed `events.jsonl`, ...), in the order given, optionally filtered. */
export function decisionsFromEvents(events: Iterable<RecordedEventLike>, filter: { kind?: string; key?: string } = {}): Decision[] {
  const out: Decision[] = [];
  for (const event of events) {
    if (event.type !== "log" || !DECISION_EVENT_NAMES.includes(event.name)) continue;
    const decision = parseRecordedDecision(event.payload);
    if (!decision) continue;
    if (filter.kind !== undefined && decision.kind !== filter.kind) continue;
    if (filter.key !== undefined && decision.key !== filter.key) continue;
    out.push(decision);
  }
  return out;
}

/** Every recorded decision for a run, oldest first, from the trace db (local sqlite or D1 — `run.tracer.db`). */
export async function listRecordedDecisions(db: TraceDb, adwId: string, filter: { kind?: string; key?: string } = {}): Promise<Decision[]> {
  const rows = await db
    .query<{ payload_json: string; name: string }, [string, string, string, string]>(
      "SELECT payload_json, name FROM events WHERE adw_id=? AND type=? AND name IN (?, ?) ORDER BY started_at, rowid",
    )
    .all(adwId, "log", DECISION_EVENT, LEGACY_DECISION_EVENT);
  const events: RecordedEventLike[] = [];
  for (const row of rows) {
    try {
      events.push({ type: "log", name: row.name, payload: JSON.parse(row.payload_json) });
    } catch {
      // A corrupt row is not a decision — skip it, never fail a replay over it.
    }
  }
  return decisionsFromEvents(events, filter);
}

/**
 * The MOST RECENT recorded decision of `kind` (+ `key`) for a run, or
 * `null`. Pass the result straight into `DecisionRequest.replay` — a
 * `null` there means "replay mode, nothing recorded: use the fallback, do
 * not call the model".
 */
export async function findRecordedDecision(db: TraceDb, adwId: string, kind: string, key = ""): Promise<Decision | null> {
  const all = await listRecordedDecisions(db, adwId, { kind, key });
  return all.length > 0 ? all[all.length - 1]! : null;
}

// ── piquette doctor ──────────────────────────────────────────────────────────────

export interface DecisionsDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity?: "info" | "warn";
}

/**
 * Everything `piquette doctor` reports about `decisions:` — pure (env passed in), so it
 * is unit-tested without running doctor. EMPTY when the decision model is disabled: an
 * unused block must be invisible, the same rule doctor applies to a disabled
 * `tiering:` ladder. Only a malformed `base_url` or a known kind's invalid
 * feature settings fail doctor; everything else is info/warn, because every
 * other problem already degrades to the deterministic fallback at run time.
 */
export function decisionsDoctorChecks(
  config: DecisionsConfigInput | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  kinds: Readonly<Record<string, DecisionKindSpec<unknown>>> = DECISION_KINDS,
): DecisionsDoctorCheck[] {
  const cfg = normalizeDecisionsConfig(config);
  if (!cfg.enabled) return [];
  const checks: DecisionsDoctorCheck[] = [];
  const endpoint = systemOneResolvedEndpoint(cfg, env);
  const model = cfg.systemone.provider === "cloudflare" ? cfg.systemone.cloudflare.model : cfg.systemone.provider === "ollama" ? cfg.systemone.ollama.model : cfg.systemone.model;
  checks.push({
    name: "decisions",
    ok: true,
    detail: `provider=${cfg.systemone.provider} mode=${cfg.mode} model=${model} threshold=${cfg.threshold} timeout=${cfg.timeout_ms}ms endpoint=${endpoint}`,
    severity: "info",
  });
  // The http(s) URL-shape check applies to `typesafe` AND `ollama` — both
  // resolve `endpoint` from a configured base_url (`cfg.systemone.base_url` /
  // `cfg.systemone.ollama.base_url` respectively) that an operator could still set to
  // something malformed (schema validation only rejects BLANK, not a
  // non-http(s) scheme). `cloudflare` has no base_url of its own — its
  // endpoint is always derived from `systemOneCloudflareEndpoint()`, never
  // operator-typed — so it is excluded here, same as before.
  if (cfg.systemone.provider === "typesafe" || cfg.systemone.provider === "ollama") {
    let urlOk = true;
    try {
      const url = new URL(endpoint);
      urlOk = url.protocol === "https:" || url.protocol === "http:";
    } catch {
      urlOk = false;
    }
    if (!urlOk) {
      const badName = cfg.systemone.provider === "ollama" ? "decisions.systemone.ollama.base_url" : "decisions base_url";
      const badValue = cfg.systemone.provider === "ollama" ? cfg.systemone.ollama.base_url : cfg.systemone.base_url;
      checks.push({ name: badName, ok: false, detail: `${JSON.stringify(badValue)} is not an http(s) URL` });
    }
  }
  // The top-level `decisions.systemone.base_url` is ignored (not merely redundant) whenever
  // the provider is NOT `typesafe` — worth a warn so an operator who set it
  // under `cloudflare`/`ollama` learns which key actually controls the
  // endpoint instead.
  // Workers AI catalog ids carry a namespace prefix (`@cf/...`, `@hf/...`).
  // Without it the call 404s ("No route for that URI"), which `decide()`
  // turns into `reason: error` — every decision silently falls back (#164).
  if (cfg.systemone.provider === "cloudflare" && !/^@(cf|hf)\//.test(cfg.systemone.cloudflare.model.trim())) {
    checks.push({
      name: "decisions.systemone.cloudflare.model",
      ok: true,
      detail: `${JSON.stringify(cfg.systemone.cloudflare.model)} has no @cf/ or @hf/ prefix — Workers AI ids do (e.g. @cf/cloudflare/clef); without it every call 404s and every decision falls back`,
      severity: "warn",
    });
  }
  if (cfg.systemone.provider !== "typesafe" && cfg.systemone.base_url.trim()) {
    const instead = cfg.systemone.provider === "cloudflare" ? "decisions.systemone.cloudflare.gateway to route through AI Gateway" : "decisions.systemone.ollama.base_url";
    checks.push({ name: "decisions base_url", ok: true, detail: `ignored with provider: ${cfg.systemone.provider} — use ${instead} instead`, severity: "warn" });
  }
  // Ollama is local and has no auth of its own — there is no key to be
  // missing, so there is no "decisions api key" check at all for it (an empty
  // check would just read oddly: "" set). Its own reachability/version/
  // pulled-model probes are `systemOneOllamaDoctorChecks`, called separately by
  // `piquette doctor` (a live network probe, unlike this function — see there).
  if (cfg.systemone.provider !== "ollama") {
    const names = systemOneCredentialEnvs(cfg);
    const missing = missingSystemOneCredentials(cfg, env);
    checks.push({
      name: "decisions api key",
      ok: true, // a missing key degrades every decision to its fallback (reason no_api_key) — never a hard failure
      detail: missing.length === 0 ? `${names.join(", ")} set` : `${notSet(missing)} — every decision will fall back (reason: no_api_key)`,
      severity: missing.length === 0 ? "info" : "warn",
    });
  } else if (cfg.timeout_ms < SYSTEM_ONE_OLLAMA_COLD_START_TIMEOUT_MS) {
    // A locally-served model pays a one-time load cost on its first call
    // (sometimes several seconds) that a hosted API never does — a 2s
    // default timeout (tuned for TypeSafe) can time out that first call
    // for no reason other than the model not being warm yet.
    checks.push({
      name: "decisions timeout_ms",
      ok: true,
      detail: `decisions.timeout_ms is ${cfg.timeout_ms}ms — Ollama's first call after a model load can take several seconds; consider >= ${SYSTEM_ONE_OLLAMA_COLD_START_TIMEOUT_MS}ms`,
      severity: "warn",
    });
  }
  for (const kind of Object.keys(cfg.kinds).sort()) {
    const policy = resolveDecisionPolicy(cfg, kind);
    const spec = kinds[kind];
    if (!spec) {
      const known = Object.keys(kinds);
      checks.push({
        name: `decisions kind "${kind}"`,
        ok: true,
        detail: `not a known decision kind — this entry does nothing (known: ${known.length > 0 ? known.join(", ") : "none yet"})`,
        severity: "warn",
      });
      continue;
    }
    try {
      parseDecisionExtras(cfg, spec);
      checks.push({
        name: `decisions kind "${kind}"`,
        ok: true,
        detail: `${spec.summary} — mode=${policy.mode} threshold=${policy.threshold} timeout=${policy.timeout_ms}ms${spec.options ? ` options=${spec.options.join("|")}` : ""}`,
        severity: "info",
      });
    } catch (error) {
      checks.push({ name: `decisions kind "${kind}"`, ok: false, detail: (error as Error).message });
    }
  }
  return checks;
}

/**
 * `decisions.systemone.ollama.base_url` is `{host}/v1` (the System One path lives at
 * `{host}/v1/systemone`), but Ollama's own introspection endpoints
 * (`/api/version`, `/api/tags`) live at the bare host, not under `/v1` — so
 * the host is recovered by stripping exactly that suffix. Exported so a
 * test can assert the exact URL a probe hits without re-deriving this rule.
 */
export function systemOneOllamaHost(baseUrl: string): string {
  const trimmed = (baseUrl || "").trim().replace(/\/+$/, "");
  const host = trimmed.replace(/\/v1$/, "");
  return host || "http://localhost:11434";
}

/** `a >= b` for two dotted version strings, comparing numerically segment by segment (`"0.9" < "0.35"`, unlike a string compare). A non-numeric segment compares as `0`. */
function versionAtLeast(version: string, min: string): boolean {
  const parts = (s: string): number[] => s.split(".").map((p) => parseInt(p, 10) || 0);
  const a = parts(version);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

const SYSTEM_ONE_OLLAMA_PROBE_TIMEOUT_MS = 3_000; // same budget piquette doctor's own probeGet uses

export interface SystemOneOllamaVersionProbeResult {
  ok: boolean;
  version?: string;
  error?: string;
}

export interface SystemOneOllamaTagsProbeResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

/** Injectable network probes — a test passes its own, so `systemOneOllamaDoctorChecks` never touches a real socket. */
export interface SystemOneOllamaProbes {
  version?: (host: string) => Promise<SystemOneOllamaVersionProbeResult>;
  tags?: (host: string) => Promise<SystemOneOllamaTagsProbeResult>;
}

async function defaultOllamaVersionProbe(host: string): Promise<SystemOneOllamaVersionProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYSTEM_ONE_OLLAMA_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${host}/api/version`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? { ok: true, version: body.version } : { ok: false, error: "response had no `version` field" };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultOllamaTagsProbe(host: string): Promise<SystemOneOllamaTagsProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYSTEM_ONE_OLLAMA_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
    const models = (body.models ?? [])
      .map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : null))
      .filter((n): n is string => n !== null);
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** `wanted` ("nimble") matches a served tag ("nimble", "nimble:latest", "nimble:7b", ...) by exact name or `name:` prefix — Ollama tags always carry a `:tag` suffix once pulled. */
function ollamaModelPulled(wanted: string, served: readonly string[]): boolean {
  return served.some((tag) => tag === wanted || tag.startsWith(`${wanted}:`));
}

/**
 * The LIVE half of the decision layer's Ollama doctor support — `decisionsDoctorChecks` never
 * probes the network (a TypeSafe/Cloudflare call there would spend the
 * operator's tokens), but Ollama is local and these two GETs are free, so
 * `piquette doctor` calls this SEPARATELY (gated on `--no-probe` like every other
 * live probe it runs) to warn about a stale/unreachable server or an
 * unpulled model before a run ever hits "model not found". EMPTY when the decision model
 * is disabled or the provider is not `ollama` — same invisibility rule as
 * `decisionsDoctorChecks`. Never fails doctor: every finding here is `ok: true`,
 * `severity: "warn"` at worst, because an unreachable/stale/unpulled Ollama
 * already degrades every decision to its fallback at run time.
 */
export async function systemOneOllamaDoctorChecks(config: DecisionsConfigInput | null | undefined, probes: SystemOneOllamaProbes = {}): Promise<DecisionsDoctorCheck[]> {
  const cfg = normalizeDecisionsConfig(config);
  if (!cfg.enabled || cfg.systemone.provider !== "ollama") return [];
  const host = systemOneOllamaHost(cfg.systemone.ollama.base_url);
  const versionProbe = probes.version ?? defaultOllamaVersionProbe;
  const tagsProbe = probes.tags ?? defaultOllamaTagsProbe;
  const checks: DecisionsDoctorCheck[] = [];

  const version = await versionProbe(host);
  if (!version.ok) {
    checks.push({
      name: "decisions ollama version",
      ok: true,
      detail: `${host}/api/version unreachable${version.error ? ` (${version.error})` : ""} — every decision will fall back`,
      severity: "warn",
    });
  } else if (!versionAtLeast(version.version!, SYSTEM_ONE_OLLAMA_MIN_VERSION)) {
    checks.push({ name: "decisions ollama version", ok: true, detail: `Ollama ${version.version} — decisions.systemone.provider: ollama needs >= ${SYSTEM_ONE_OLLAMA_MIN_VERSION} (System One)`, severity: "warn" });
  } else {
    checks.push({ name: "decisions ollama version", ok: true, detail: `Ollama ${version.version}`, severity: "info" });
  }

  const tags = await tagsProbe(host);
  if (!tags.ok) {
    checks.push({
      name: "decisions ollama model",
      ok: true,
      detail: `${host}/api/tags unreachable${tags.error ? ` (${tags.error})` : ""} — could not check whether "${cfg.systemone.ollama.model}" is pulled`,
      severity: "warn",
    });
  } else {
    const pulled = ollamaModelPulled(cfg.systemone.ollama.model, tags.models ?? []);
    checks.push({
      name: "decisions ollama model",
      ok: true,
      detail: pulled
        ? `"${cfg.systemone.ollama.model}" is pulled (served: ${tags.models!.join(", ") || "none"})`
        : `"${cfg.systemone.ollama.model}" is NOT in \`ollama list\` — run \`ollama pull ${cfg.systemone.ollama.model}\``,
      severity: pulled ? "info" : "warn",
    });
  }

  return checks;
}
