/**
 * The PURE half of the `diff_risk` decision kind: the code-owned deterministic
 * floor, the shared clipped diff state, and the closed mapping from risk flags
 * to actions. No I/O, no run, no decision call (invariant 7); `chains/diff_risk.ts`
 * owns the git read, the one `decideBatch` call and the trace.
 *
 * THE QUESTION: "does this diff touch <risk>?" for each of `DIFF_RISK_KEYS`
 * (auth, money, schema, data_loss, state, api_contract, secrets), answered
 * `touches | does_not_touch`. The decision model never names an action.
 *
 * THE FLOOR: a path-glob/regex table (`PATH_RULES`) over every changed path
 * and a regex table (`CONTENT_RULES`) over every ADDED line of the whole diff
 * (not the clipped one) flags risks with no model at all. It is the
 * question's `fallback` per key (`touches` when the floor hit, else
 * `does_not_touch`), so a failing, timing-out or low-confidence model leaves
 * exactly the floor.
 *
 * ADDITIVE ONLY (the invariant this module exists to keep): a risk is flagged
 * when the floor hit it OR the effective model choice is `touches`. There is
 * no code path by which a model answer removes a floor flag, and the only
 * actions (`DIFF_RISK_ACTIONS`) ADD a label and ADD `require_human_signoff`.
 * Labels exist only in the outcome, the trace and the signoff prompt/log.
 * `mergeSignoff` is `configured || flagged`, so it can never turn signoff off,
 * and nothing here touches review rounds, retry ceilings or spend.
 *
 * CLIPPING: the diff the model reads is clipped to a HARD character budget
 * (`max_diff_chars`, headers, clip marks and the omitted-files line included; 0
 * sends the file list only), shared fairly across the files that are shown
 * (small files stay whole, big ones are cut) so one huge file cannot push every
 * other file out of view. Files past what the budget can show are counted in one
 * trailing line, not headed one by one. A clip is never silent: the
 * state carries `diff_clipped` and a note the model reads, and the outcome
 * reports it. The floor always reads the WHOLE diff, so a clip can hide a hunk
 * from the model but never from the floor.
 *
 * REDACTION: the model's state never carries a secret the floor knows how to
 * recognise. Every `CONTENT_RULES` secrets match is replaced by
 * `[redacted: <why>]` BEFORE clipping, and a file whose PATH is a secrets rule
 * (`.env*`, `*.pem`, ssh keys, credentials files) is sent by name only. The
 * floor itself keeps reading the unredacted text.
 */
import { DIFF_RISK_CHOICES, DIFF_RISK_KEYS } from "./decision_kinds.ts";
import type { DecisionOption } from "./decisions.ts";

export type DiffRiskKey = (typeof DIFF_RISK_KEYS)[number];
export type DiffRiskChoice = (typeof DIFF_RISK_CHOICES)[number];

/** One file's slice of a unified diff (or an untracked file rendered as all-added lines). */
export interface DiffChunk {
  path: string;
  text: string;
}

export interface DiffRiskInput {
  /** Every changed path: tracked changes (including deletions) plus untracked files. */
  files: readonly string[];
  /** Per-file diff text, covering the WHOLE diff. */
  chunks: readonly DiffChunk[];
  /**
   * Files whose CONTENT could not be scanned (too large to read, or a git read
   * that failed for that file). Their PATH was still checked. Recorded, never silent.
   */
  unscanned?: readonly string[];
  /**
   * Why the diff could not be read at all (git failed). The floor then ran on
   * whatever was readable, and the outcome FAILS CLOSED: it requires human
   * signoff. `null`/absent means the diff was read.
   */
  unreadable?: string | null;
}

// ── the closed question set ────────────────────────────────────────────────

const RISK_DESCRIPTIONS: Record<DiffRiskKey, string> = {
  auth: "authentication or authorization: logins, sessions, tokens, permissions, roles, access checks, or who is allowed to do what",
  money: "money: billing, payments, prices, invoices, refunds, subscriptions, ledgers, or any arithmetic on amounts of currency",
  schema: "a database or storage schema: migrations, table/column definitions, indexes, constraints, or the shape of persisted records",
  data_loss: "irreversible data loss: dropping or truncating tables/columns, deleting rows or files without a way back, or overwriting stored data",
  state: "shared or persistent state: caches, queues, locks, global or long-lived mutable state, concurrency, or ordering/idempotency of effects",
  api_contract: "a public contract other code or people depend on: HTTP/RPC endpoints, request/response shapes, exported library API, CLI flags, or file formats",
  secrets: "secrets or credentials: API keys, tokens, passwords, private keys, .env files, or code that reads, writes, logs or transmits them",
};

const CHOICE_DESCRIPTIONS: Record<DiffRiskChoice, string> = {
  touches: "The diff changes, adds or removes something in this risk area, even partly or indirectly.",
  does_not_touch: "The diff does not change anything in this risk area.",
};

/** Built from the kind's own tuple, so the doctor-displayed `options` and the wire options cannot drift. */
export const DIFF_RISK_OPTIONS: readonly DecisionOption<DiffRiskChoice>[] = DIFF_RISK_CHOICES.map((value) => ({
  value,
  description: CHOICE_DESCRIPTIONS[value],
}));

/** One short constant instruction per key; it never restates the diff, which is in `state` once. */
export function diffRiskInstructions(key: DiffRiskKey): string {
  return (
    `Using ONLY \`state.diff\` and \`state.files\`, does this change touch ${RISK_DESCRIPTIONS[key]}? ` +
    "Answer `touches` only for a change you can see; if `state.diff_clipped` is true, judge what is shown."
  );
}

/** The replay key for one question: the risk key itself (one decision per key per run). */
export function diffRiskDecisionKey(key: DiffRiskKey): string {
  return key;
}

// ── the deterministic floor ────────────────────────────────────────────────

interface Rule {
  key: DiffRiskKey;
  re: RegExp;
  why: string;
}

/** Tested against the lower-cased, forward-slashed path. */
const PATH_RULES: readonly Rule[] = [
  { key: "auth", re: /(^|\/)(auth|authn|authz|oauth|permissions?|rbac|acl|iam|sso|jwt|passport|login)([\/._-]|$)/, why: "auth path" },
  { key: "money", re: /(^|\/)(billing|payments?|invoices?|checkout|stripe|pricing|subscriptions?|ledger|refunds?|wallet|payouts?)([\/._-]|$)/, why: "money path" },
  { key: "schema", re: /(^|\/)(migrations?|alembic)\//, why: "migrations/**" },
  { key: "schema", re: /(^|\/)db\/migrate\//, why: "db/migrate/**" },
  { key: "schema", re: /\.sql$/, why: "*.sql" },
  { key: "schema", re: /(^|\/)schema\.(prisma|rb|graphql|sql)$/, why: "schema file" },
  { key: "schema", re: /(^|\/)(prisma|drizzle)\//, why: "ORM schema dir" },
  { key: "state", re: /(^|\/)(state|stores?|reducers?|cache|caches|queues?|locks?)([\/._-]|$)/, why: "state path" },
  { key: "api_contract", re: /(^|\/)(openapi|swagger)/, why: "OpenAPI/Swagger file" },
  { key: "api_contract", re: /\.(proto|graphql|gql)$/, why: "interface definition file" },
  { key: "api_contract", re: /(^|\/)(api|routes|endpoints)\//, why: "api/** or routes/**" },
  // `.env*`, except the committed-on-purpose templates (they list key NAMES, not values).
  { key: "secrets", re: /(^|\/)\.env(?!\.(example|sample|template|dist)$)(\.[^/]*)?$/, why: ".env*" },
  { key: "secrets", re: /\.(pem|key|p12|pfx|jks|keystore)$/, why: "key/certificate file" },
  { key: "secrets", re: /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/, why: "ssh key" },
  { key: "secrets", re: /(^|\/)(credentials|secrets?)[^/]*\.(json|ya?ml|toml|ini)$/, why: "credentials file" },
  // Dotfiles and tool configs that routinely carry a token or password with no extension.
  { key: "secrets", re: /(^|\/)\.(npmrc|envrc|netrc|pypirc)$/, why: "credentials dotfile" },
  { key: "secrets", re: /(^|\/)\.aws\/credentials$/, why: ".aws/credentials" },
  { key: "secrets", re: /(^|\/)(kubeconfig|\.kube\/config)$/, why: "kubeconfig" },
  { key: "secrets", re: /\.tfvars(\.json)?$/, why: "*.tfvars" },
];

/** Tested against every ADDED line (without its leading `+`). */
const CONTENT_RULES: readonly Rule[] = [
  { key: "secrets", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, why: "private key block" },
  { key: "secrets", re: /\bAKIA[0-9A-Z]{16}\b/, why: "AWS access key id" },
  { key: "secrets", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, why: "GitHub token" },
  { key: "secrets", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, why: "GitHub fine-grained token" },
  { key: "secrets", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, why: "Slack token" },
  { key: "secrets", re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, why: "API secret key" },
  { key: "secrets", re: /\bAIza[0-9A-Za-z_-]{35}\b/, why: "Google API key" },
  {
    key: "secrets",
    // `\w*` covers suffixed names (AWS_SECRET_ACCESS_KEY, SECRET_KEY, githubTokenValue); a name ending in `_env`/`Env`
    // holds an env var NAME (spf's own `api_key_env: "X_API_KEY"` convention), not a credential.
    re: /(?:secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key)(?![\w]*?_?env\b)\w*["']?\s*[:=]\s*["'][^"'\s$<{][^"'\s]{11,}["']/i,
    why: "literal credential assignment",
  },
  {
    // Unquoted `KEY=value` / YAML `password: value`. A value that ends at whitespace or `,;)` (so a call such as
    // `getToken(req)` does not match), is not a reference (`$VAR`, `<x>`, `{{ x }}`) and does not start like a config lookup.
    key: "secrets",
    re: /(?:secret|token|passw(?:or)?d|api[_-]?key)\w*\s*[:=]\s*(?!(?:process|os|env|import|config|settings|this|self|args|opts|options|params|req|request)\b)[^\s"'$<{(),;]{12,}(?=[\s,;)]|$)/i,
    why: "unquoted credential assignment",
  },
  { key: "secrets", re: /:\/\/[^/\s:@]+:(?![$<{%])[^/\s@]{6,}@/, why: "URL with embedded credentials" },
  { key: "secrets", re: /\bnpm_[A-Za-z0-9]{36}\b/, why: "npm token" },
  { key: "data_loss", re: /\bdrop\s+(?:table|column|database|schema|index|view)\b/i, why: "SQL DROP" },
  { key: "data_loss", re: /\btruncate\s+table\b/i, why: "SQL TRUNCATE TABLE" },
  { key: "data_loss", re: /\bdelete\s+from\s+[\w."`]+\s*(?:;|$|["'`])/i, why: "SQL DELETE without WHERE" },
];

/** A line longer than this (minified/generated) is scanned in overlapping windows of this size, never skipped. */
const SCAN_WINDOW = 4_000;
/** Overlap between windows, longer than any secret shape the tables look for. */
const SCAN_OVERLAP = 1_000;
/** Reasons kept per key (the flag itself is unaffected; this only bounds the trace). */
const MAX_REASONS_PER_KEY = 5;

export type DiffRiskFloor = Record<DiffRiskKey, string[]>;

export function emptyFloor(): DiffRiskFloor {
  return Object.fromEntries(DIFF_RISK_KEYS.map((key) => [key, [] as string[]])) as DiffRiskFloor;
}

function normalizePath(p: string): string {
  return p.replaceAll("\\", "/").toLowerCase();
}

/** The ADDED lines of a diff chunk. `+++` headers are not content. */
export function addedLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) out.push(line.slice(1));
  }
  return out;
}

/**
 * PURE and deterministic: the flags the code-owned tables raise for this diff,
 * with up to `MAX_REASONS_PER_KEY` human-readable reasons each. A key with no
 * reasons was not flagged. Reads the WHOLE input, whatever the model state
 * clipped.
 */
export function diffRiskFloor(input: DiffRiskInput): DiffRiskFloor {
  const floor = emptyFloor();
  const add = (key: DiffRiskKey, reason: string): void => {
    if (floor[key].length < MAX_REASONS_PER_KEY) floor[key].push(reason);
  };
  for (const file of input.files) {
    const p = normalizePath(file);
    for (const rule of PATH_RULES) if (rule.re.test(p)) add(rule.key, `${file}: ${rule.why}`);
  }
  for (const chunk of input.chunks) {
    for (const line of addedLines(chunk.text)) {
      for (const rule of CONTENT_RULES) if (lineMatches(rule.re, line)) add(rule.key, `${chunk.path}: ${rule.why}`);
    }
  }
  return floor;
}

/** `re.test` over the line, or over overlapping bounded windows when the line is very long. */
function lineMatches(re: RegExp, line: string): boolean {
  if (line.length <= SCAN_WINDOW) return re.test(line);
  for (let start = 0; start < line.length; start += SCAN_WINDOW - SCAN_OVERLAP) {
    if (re.test(line.slice(start, start + SCAN_WINDOW))) return true;
    if (start + SCAN_WINDOW >= line.length) break;
  }
  return false;
}

/** The `secrets` path rule a path matches (its reason), or `null`. Such a file is sent to the model by name only. */
export function secretPathReason(file: string): string | null {
  const p = normalizePath(file);
  for (const rule of PATH_RULES) if (rule.key === "secrets" && rule.re.test(p)) return rule.why;
  return null;
}

const SECRET_REDACTORS: ReadonlyArray<{ re: RegExp; why: string }> = CONTENT_RULES.filter((r) => r.key === "secrets").map((r) => ({
  re: new RegExp(r.re.source, r.re.flags.includes("g") ? r.re.flags : r.re.flags + "g"),
  why: r.why,
}));

/** Replace every secret-shaped match in `text` with `[redacted: <why>]`. PURE; applied to everything the model reads. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, why } of SECRET_REDACTORS) {
    re.lastIndex = 0;
    out = out.replace(re, `[redacted: ${why}]`);
  }
  return out;
}

/** The deterministic answer for one key: today's floor, as the question's `fallback`. */
export function floorChoice(floor: DiffRiskFloor, key: DiffRiskKey): DiffRiskChoice {
  return floor[key].length > 0 ? "touches" : "does_not_touch";
}

// ── the shared, clipped state ──────────────────────────────────────────────

/** Split a `git diff` into per-file chunks (`diff --git a/x b/y` headers). Text before the first header is dropped. */
export function splitDiff(diffText: string): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of diffText.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line) ?? /^diff --git "a\/.*" "b\/(.*)"$/.exec(line);
    if (header) {
      if (current) chunks.push({ path: current.path, text: current.lines.join("\n") });
      current = { path: header[1]!, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) chunks.push({ path: current.path, text: current.lines.join("\n") });
  return chunks;
}

/** Most paths listed in the state; the rest are a count. */
export const MAX_FILES_IN_STATE = 100;
const MAX_PATH_CHARS = 200;
const CLIP_MARK = "\n… [clipped]";
/** Reserved inside the budget for the trailing `(N more file(s) omitted)` line. */
const OMIT_RESERVE = 48;
/** A file is shown (whole or cut) only when about this much budget is left per shown file; the rest are counted, not headed. */
const MIN_FILE_SHARE = 300;

/**
 * Per-file shares of `budget` characters by water-filling: files smaller than
 * the fair share keep everything and hand their slack to the larger ones.
 */
function allocate(sizes: readonly number[], budget: number): number[] {
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size);
  const out = new Array<number>(sizes.length).fill(0);
  let left = Math.max(0, budget);
  order.forEach(({ size, i }, rank) => {
    const share = Math.floor(left / (order.length - rank));
    out[i] = Math.min(size, share);
    left -= out[i]!;
  });
  return out;
}

/**
 * Join per-file texts into ONE string of at most `budget` characters, headers,
 * clip marks, separators and the omitted-files line all counted. Whole when it
 * fits. Otherwise the first `K` files (as many as get `MIN_FILE_SHARE`) share
 * the budget fairly and every cut one ends with `CLIP_MARK`; the remaining files
 * are NOT headed one by one but counted in a single trailing line. `budget <= 0`
 * yields "".
 */
function clipToBudget(texts: readonly string[], budget: number): { diff: string; clipped: boolean; omitted: number } {
  const whole = texts.join("\n");
  if (whole.length <= budget) return { diff: whole, clipped: false, omitted: 0 };
  const avail = budget - OMIT_RESERVE;
  if (budget <= 0 || avail <= 0) return { diff: "", clipped: true, omitted: texts.length };
  const k = Math.min(texts.length, Math.max(1, Math.floor(avail / MIN_FILE_SHARE)));
  const shares = allocate(
    texts.slice(0, k).map((t) => t.length),
    avail - (k - 1),
  );
  const pieces = texts.slice(0, k).map((t, i) => {
    const take = shares[i]!;
    if (take >= t.length) return t;
    return take >= CLIP_MARK.length + 20 ? `${t.slice(0, take - CLIP_MARK.length)}${CLIP_MARK}` : t.slice(0, take);
  });
  const omitted = texts.length - k;
  let diff = pieces.join("\n");
  if (omitted > 0) diff += `\n(${omitted} more file(s) omitted)`;
  return { diff, clipped: true, omitted };
}

export interface DiffRiskState {
  state: Record<string, unknown>;
  /** True when any part of the diff is missing from `state.diff`. */
  clipped: boolean;
}

/**
 * The one state shared by all seven questions. PURE. `maxChars` is a hard bound
 * on `state.diff` (headers, clip marks and the omitted-files line included; the
 * file list is separately bounded by `MAX_FILES_IN_STATE`); `0` sends the file
 * list only and `diff` is "".
 */
export function buildDiffRiskState(input: DiffRiskInput, maxChars: number): DiffRiskState {
  // What the model may read: secret-path files by name only, every other chunk with secrets redacted
  // BEFORE clipping (so a cut can never leave half a key). The floor reads `input`, unredacted.
  const withheld: string[] = [];
  const visible: DiffChunk[] = input.chunks.map((c) => {
    const why = secretPathReason(c.path);
    if (why) {
      withheld.push(c.path);
      return { path: c.path, text: `diff --git a/${c.path} b/${c.path}\n[content withheld: ${why}; name only]` };
    }
    return { path: c.path, text: redactSecrets(c.text) };
  });
  const total = visible.reduce((n, c) => n + c.text.length, 0);
  const { diff, clipped, omitted } = clipToBudget(
    visible.map((c) => c.text),
    maxChars,
  );
  const files = input.files.slice(0, MAX_FILES_IN_STATE).map((f) => (f.length > MAX_PATH_CHARS ? `${f.slice(0, MAX_PATH_CHARS)}…` : f));
  const unlisted = input.files.length - files.length;
  const state: Record<string, unknown> = {
    task: "A coding agent produced the change below. Each question asks whether it touches one risk area.",
    files: unlisted > 0 ? [...files, `(${unlisted} more file(s) not listed)`] : files,
    diff,
    diff_clipped: clipped,
    diff_chars: { total, shown: diff.length },
  };
  if (omitted > 0) state["diff_files_omitted"] = omitted;
  if (withheld.length > 0) state["withheld_files"] = withheld.slice(0, MAX_FILES_IN_STATE);
  const notes: string[] = [];
  if (clipped) {
    notes.push(
      "THE DIFF WAS CLIPPED to fit a size budget (cut hunks end with `… [clipped]`" +
        (omitted > 0 ? `; ${omitted} file(s) are not shown at all` : "") +
        "). A risky hunk may be in the part you cannot see. " +
        "Judge what is shown; a separate code-side path/pattern check reads the whole diff.",
    );
  }
  if ((input.unscanned?.length ?? 0) > 0) {
    notes.push(`${input.unscanned!.length} file(s) were too large to include; judge them by name (see \`state.files\`).`);
  }
  if (withheld.length > 0) notes.push("Files in `state.withheld_files` look like secrets, so their content is withheld; judge them by name. Secret-shaped strings elsewhere are shown as `[redacted: ...]`.");
  if (notes.length > 0) state["note"] = notes.join(" ");
  return { state, clipped };
}

// ── actions: the closed menu, code-owned ───────────────────────────────────

export interface DiffRiskAction {
  /** The label added for this risk. Always set: every flagged risk is labelled. */
  label: string;
  /** Every flagged risk requires human signoff. A constant `true`, never a computed or model-supplied value. */
  require_human_signoff: true;
}

const action = (key: DiffRiskKey): DiffRiskAction => ({ label: `risk:${key}`, require_human_signoff: true });

/**
 * The ONLY thing a flag can do. An explicit `Record<DiffRiskKey, ...>` literal, so a key added to
 * `DIFF_RISK_KEYS` is a compile error here until it has an action (like `RISK_DESCRIPTIONS`).
 */
export const DIFF_RISK_ACTIONS: Readonly<Record<DiffRiskKey, DiffRiskAction>> = Object.freeze({
  auth: action("auth"),
  money: action("money"),
  schema: action("schema"),
  data_loss: action("data_loss"),
  state: action("state"),
  api_contract: action("api_contract"),
  secrets: action("secrets"),
});

/** The keys at least one floor rule (path or content) can flag. A test asserts this is every key, so a key without a floor is caught. */
export function floorRuleKeys(): DiffRiskKey[] {
  const keys = new Set<DiffRiskKey>([...PATH_RULES, ...CONTENT_RULES].map((r) => r.key));
  return DIFF_RISK_KEYS.filter((k) => keys.has(k));
}

export interface DiffRiskFlag {
  key: DiffRiskKey;
  /** Why the floor flagged it (empty when only the model did). */
  floor: string[];
  /** The effective model choice was `touches`. */
  model: boolean;
  source: "floor" | "model" | "floor+model";
}

export interface DiffRiskOutcome {
  /** In `DIFF_RISK_KEYS` order. */
  flags: DiffRiskFlag[];
  /** `DIFF_RISK_ACTIONS[key].label` for each flag. */
  labels: string[];
  require_human_signoff: boolean;
  /** Part of the diff was not shown to the model. */
  clipped: boolean;
  /** True in act mode: the flags above are applied. In shadow they are only recorded. */
  applied: boolean;
  /** Files whose content the floor could not scan (path still checked). */
  unscanned: string[];
  /** Why the diff could not be read at all; when set, `require_human_signoff` is true (fail closed). */
  unreadable: string | null;
}

/**
 * PURE. A key is flagged iff the floor hit it OR its effective choice is
 * `touches`. `choices` holds the model's ACTED answers only (absent when the
 * decision used its fallback), so a model `does_not_touch` on a floor-flagged
 * key changes nothing: the floor is OR-ed in unconditionally.
 */
export function resolveDiffRiskOutcome(
  floor: DiffRiskFloor,
  choices: Partial<Record<DiffRiskKey, DiffRiskChoice>>,
  extra: { clipped: boolean; applied: boolean; unscanned?: readonly string[]; unreadable?: string | null },
): DiffRiskOutcome {
  const flags: DiffRiskFlag[] = [];
  for (const key of DIFF_RISK_KEYS) {
    const fromFloor = floor[key].length > 0;
    const model = choices[key] === "touches";
    if (!fromFloor && !model) continue;
    flags.push({ key, floor: [...floor[key]], model, source: fromFloor ? (model ? "floor+model" : "floor") : "model" });
  }
  return {
    flags,
    labels: flags.map((f) => DIFF_RISK_ACTIONS[f.key].label),
    // An unreadable diff FAILS CLOSED: nothing could be checked, so a human looks. Still only ever ADDS a requirement.
    require_human_signoff: flags.some((f) => DIFF_RISK_ACTIONS[f.key].require_human_signoff) || Boolean(extra.unreadable),
    clipped: extra.clipped,
    applied: extra.applied,
    unscanned: [...(extra.unscanned ?? [])],
    unreadable: extra.unreadable ?? null,
  };
}

/**
 * The ONLY way a `diff_risk` outcome reaches `review.require_human_signoff`:
 * `configured || flagged`. Never `false` when `configured` is true, and a
 * shadow (`applied: false`) or absent outcome returns `configured` unchanged.
 */
export function mergeSignoff(configured: boolean, outcome: DiffRiskOutcome | null): boolean {
  return configured || (outcome !== null && outcome.applied && outcome.require_human_signoff);
}

/** A stable tag in the message, so a trace/blocked comment shows the cause even where the error object is gone. */
export const SIGNOFF_REQUIRED_TAG = "[spf:signoff-required]";

/**
 * Thrown by `simple_sdlc`'s signoff when `diff_risk` (act) requires a human and nobody is there. It is a
 * TERMINAL, deliberate stop, not a transient failure: `spf loop` must not re-run the chain (every re-run would
 * re-plan and re-build into the same flagged diff), and `spf watch` must not push a flagged diff that may hold a secret.
 */
export class SignoffRequiredError extends Error {
  readonly labels: readonly string[];
  /** Why the diff could not be fully read, when that (not a flag) is the cause. */
  readonly unreadable: string | null;
  constructor(message: string, labels: readonly string[], unreadable: string | null = null) {
    super(`${SIGNOFF_REQUIRED_TAG} ${message}`);
    this.name = "SignoffRequiredError";
    this.labels = labels;
    this.unreadable = unreadable;
  }
  /** True when the unreviewed work must not leave the machine: a secret was flagged, or the diff could not be read to rule one out. */
  get withholdsWip(): boolean {
    return this.labels.includes(DIFF_RISK_ACTIONS.secrets.label) || this.unreadable !== null;
  }
}
