/**
 * The `diff_risk` decision kind: a code-owned floor + a batched model question
 * over one shared clipped diff, whose ONLY effect is to add a signoff
 * requirement and labels.
 *
 * Pure parts (floor, clipping, additive-only mapping) are tested directly. The
 * decision call goes through a real `startRun` Run with a `FakeDecisionClient`
 * (nothing touches the network); the signoff seam is driven through the REAL
 * `simple_sdlc.main` with only the agents scripted.
 */
import "./hermetic_git.js";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EnvelopeBase, ReviewOutputT } from "../core/data_types.js";
import { DECISION_EVENT, SystemOneApiError, parseRecordedDecision, setDecisionClientFactory } from "../core/decisions.js";
import { DECISION_KINDS, DIFF_RISK_CHOICES, DIFF_RISK_KEYS, DIFF_RISK_KIND } from "../core/decision_kinds.js";
import {
  DIFF_RISK_ACTIONS,
  DIFF_RISK_OPTIONS,
  MAX_FILES_IN_STATE,
  SignoffRequiredError,
  floorRuleKeys,
  buildDiffRiskState,
  diffRiskFloor,
  diffRiskInstructions,
  emptyFloor,
  floorChoice,
  redactSecrets,
  secretPathReason,
  mergeSignoff,
  resolveDiffRiskOutcome,
  splitDiff,
  type DiffChunk,
  type DiffRiskChoice,
  type DiffRiskFloor,
  type DiffRiskInput,
  type DiffRiskKey,
} from "../core/diff_risk.js";
import { DIFF_RISK_EVENT, MAX_UNTRACKED_FILE_BYTES, collectDiff, decideDiffRisk, diffRiskFailure, resolveDiffRisk } from "../chains/diff_risk.js";
import * as simpleSdlc from "../chains/simple_sdlc.js";
import * as steps from "../chains/steps.js";
import { Run, type PhaseHandle } from "../core/runner.js";
import { Decider } from "../core/decisions.js";
import { FakeDecisionClient } from "./fake_decisions.js";

// ── fixtures ────────────────────────────────────────────────────────────────

// Secret-shaped strings are assembled at run time so this file never contains one verbatim.
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const GH_TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const PEM = "-----BEGIN " + "RSA PRIVATE KEY-----";

function chunk(path: string, added: string[] = []): DiffChunk {
  return { path, text: [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...added.map((l) => `+${l}`)].join("\n") };
}

function inputOf(files: string[], chunks: DiffChunk[] = files.map((f) => chunk(f))): DiffRiskInput {
  return { files, chunks };
}

function flaggedKeys(input: DiffRiskInput): DiffRiskKey[] {
  const floor = diffRiskFloor(input);
  return DIFF_RISK_KEYS.filter((k) => floor[k].length > 0);
}

// ── registry ────────────────────────────────────────────────────────────────

test("diff_risk: registered kind; seven keys; options and actions are built from the kind's own tuples", () => {
  assert.equal(DECISION_KINDS["diff_risk"], DIFF_RISK_KIND);
  assert.deepEqual([...DIFF_RISK_KEYS], ["auth", "money", "schema", "data_loss", "state", "api_contract", "secrets"]);
  assert.deepEqual([...DIFF_RISK_CHOICES], ["touches", "does_not_touch"]);
  assert.deepEqual(DIFF_RISK_KIND.options, DIFF_RISK_CHOICES);
  assert.deepEqual(
    DIFF_RISK_OPTIONS.map((o) => o.value),
    [...DIFF_RISK_CHOICES],
  );
  assert.deepEqual(Object.keys(DIFF_RISK_ACTIONS), [...DIFF_RISK_KEYS]);
  for (const key of DIFF_RISK_KEYS) {
    assert.equal(DIFF_RISK_ACTIONS[key].label, `risk:${key}`);
    assert.equal(DIFF_RISK_ACTIONS[key].require_human_signoff, true);
    assert.ok(diffRiskInstructions(key).length > 0);
  }
});

// ── the floor ───────────────────────────────────────────────────────────────

test("floor: path table flags each risk with no model", () => {
  const cases: Array<[string, DiffRiskKey]> = [
    ["db/migrations/0001_init.sql", "schema"],
    ["migrations/002.ts", "schema"],
    ["queries/report.sql", "schema"],
    ["prisma/schema.prisma", "schema"],
    ["src/auth/session.ts", "auth"],
    ["lib/oauth_client.rb", "auth"],
    ["src/billing/invoice.ts", "money"],
    ["app/payments/refund.py", "money"],
    ["src/state/store.ts", "state"],
    ["openapi.yaml", "api_contract"],
    ["proto/user.proto", "api_contract"],
    ["src/api/users.ts", "api_contract"],
    [".env", "secrets"],
    [".env.production", "secrets"],
    ["config/.env.local", "secrets"],
    ["certs/server.pem", "secrets"],
    ["deploy/credentials.json", "secrets"],
  ];
  for (const [file, key] of cases) {
    assert.ok(flaggedKeys(inputOf([file])).includes(key), `${file} should flag ${key}`);
  }
});

test("floor: a benign diff flags nothing; .env.example is a template, not a secret", () => {
  assert.deepEqual(flaggedKeys(inputOf(["README.md", "src/util.ts", "docs/notes.md", ".env.example", ".env.sample"])), []);
});

test("floor: content table flags secret-shaped and destructive ADDED lines only", () => {
  const secrets = chunk("src/config.ts", [`const k = "${AWS_KEY}";`, `token: "${GH_TOKEN}"`, PEM, `password = "hunter2hunter2hunter2"`]);
  assert.ok(flaggedKeys(inputOf(["src/config.ts"], [secrets])).includes("secrets"));
  assert.deepEqual(flaggedKeys(inputOf(["src/config.ts"], [chunk("src/config.ts", ["const apiKeyEnv = process.env.API_KEY;", 'api_key_env: "SYSTEMONE_API_KEY"'])])), []);

  const drop = chunk("src/cleanup.ts", ["await db.exec('DROP TABLE users');"]);
  assert.ok(flaggedKeys(inputOf(["src/cleanup.ts"], [drop])).includes("data_loss"));
  const trunc = chunk("src/cleanup.ts", ["TRUNCATE TABLE audit_log;"]);
  assert.ok(flaggedKeys(inputOf(["src/cleanup.ts"], [trunc])).includes("data_loss"));

  // A REMOVED line and a context line are not additions.
  const removed: DiffChunk = { path: "src/x.ts", text: `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n-const k = "${AWS_KEY}";\n const ok = 1;` };
  assert.deepEqual(flaggedKeys(inputOf(["src/x.ts"], [removed])), []);
});

test("floor: quoted credentials with a suffixed key name are flagged and redacted; *_env names are not", () => {
  const lines = [
    ["scripts/deploy.sh", 'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"', "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["settings.py", "SECRET_KEY = 'django-insecure-abcdefghij'", "django-insecure-abcdefghij"],
    ["src/cfg.ts", 'const STRIPE_SECRET_KEY = "rk_live_abcdefghijklmnop";', "rk_live_abcdefghijklmnop"],
    ["src/cfg.ts", 'fooTokenValue: "abcdefghijklmnopqrstu"', "abcdefghijklmnopqrstu"],
  ] as const;
  for (const [file, line, secret] of lines) {
    assert.ok(flaggedKeys(inputOf([file], [chunk(file, [line])])).includes("secrets"), line);
    assert.ok(!redactSecrets(line).includes(secret), line);
  }
  for (const line of ['api_key_env: "SYSTEMONE_API_KEY"', 'tokenEnv: "GITHUB_TOKEN_FOR_CI"']) {
    assert.deepEqual(flaggedKeys(inputOf(["src/cfg.ts"], [chunk("src/cfg.ts", [line])])), [], line);
  }
});

test("floor: deterministic, and every flag carries a reason", () => {
  const input = inputOf(["migrations/1.sql", ".env"], [chunk("migrations/1.sql", ["DROP TABLE t;"]), chunk(".env")]);
  assert.deepEqual(diffRiskFloor(input), diffRiskFloor(input));
  const floor = diffRiskFloor(input);
  for (const key of ["schema", "data_loss", "secrets"] as const) assert.ok(floor[key].length > 0 && floor[key][0]!.length > 0, key);
  assert.equal(floorChoice(floor, "schema"), "touches");
  assert.equal(floorChoice(floor, "money"), "does_not_touch");
});

test("splitDiff: one chunk per file, keyed by the b/ path", () => {
  const text = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+one\ndiff --git a/dir/b.ts b/dir/b.ts\n+two";
  const chunks = splitDiff(text);
  assert.deepEqual(
    chunks.map((c) => c.path),
    ["a.ts", "dir/b.ts"],
  );
  assert.match(chunks[1]!.text, /\+two/);
  assert.deepEqual(splitDiff(""), []);
});

// ── additive-only ───────────────────────────────────────────────────────────

function floorFromMask(mask: number): DiffRiskFloor {
  const floor = emptyFloor();
  DIFF_RISK_KEYS.forEach((key, i) => {
    if (mask & (1 << i)) floor[key] = [`reason for ${key}`];
  });
  return floor;
}

function choicesFromMask(mask: number): Partial<Record<DiffRiskKey, DiffRiskChoice>> {
  return Object.fromEntries(DIFF_RISK_KEYS.map((key, i) => [key, mask & (1 << i) ? "touches" : "does_not_touch"]));
}

test("additive-only property: over every floor x every model answer, a floor flag is never removed and signoff is never turned off", () => {
  const n = 1 << DIFF_RISK_KEYS.length;
  for (let f = 0; f < n; f++) {
    const floor = floorFromMask(f);
    for (let m = 0; m < n; m++) {
      for (const applied of [true, false]) {
        const outcome = resolveDiffRiskOutcome(floor, choicesFromMask(m), { clipped: false, applied });
        const flagged = new Set(outcome.flags.map((x) => x.key));
        DIFF_RISK_KEYS.forEach((key, i) => {
          if (f & (1 << i)) assert.ok(flagged.has(key), `floor flag ${key} survived a model answer (f=${f} m=${m})`);
          if (!(f & (1 << i)) && !(m & (1 << i))) assert.ok(!flagged.has(key), "a flag appeared from nowhere");
        });
        assert.equal(outcome.require_human_signoff, flagged.size > 0);
        for (const configured of [true, false]) {
          const merged = mergeSignoff(configured, outcome);
          if (configured) assert.equal(merged, true, "signoff turned off");
          if (!applied) assert.equal(merged, configured, "shadow changed signoff");
          if (applied && flagged.size > 0) assert.equal(merged, true);
        }
      }
    }
  }
  assert.equal(mergeSignoff(true, null), true);
  assert.equal(mergeSignoff(false, null), false);
  // An unreadable diff only ever ADDS a requirement (fail closed), and in shadow still applies nothing.
  const unreadable = resolveDiffRiskOutcome(emptyFloor(), {}, { clipped: false, applied: true, unreadable: "boom" });
  assert.equal(unreadable.require_human_signoff, true);
  assert.equal(mergeSignoff(false, unreadable), true);
  assert.equal(mergeSignoff(false, { ...unreadable, applied: false }), false);
  assert.equal(mergeSignoff(true, { ...unreadable, require_human_signoff: false }), true);
});

// ── clipping ────────────────────────────────────────────────────────────────

test("clipping: an unclipped diff carries no note; a clipped one says so, in the flag and the note", () => {
  const small = buildDiffRiskState(inputOf(["a.ts"], [chunk("a.ts", ["x"])]), 10_000);
  assert.equal(small.clipped, false);
  assert.equal(small.state["diff_clipped"], false);
  assert.equal(small.state["note"], undefined);

  const big = buildDiffRiskState(inputOf(["a.ts"], [chunk("a.ts", ["y".repeat(5_000)])]), 500);
  assert.equal(big.clipped, true);
  assert.equal(big.state["diff_clipped"], true);
  assert.match(String(big.state["note"]), /CLIPPED/);
  assert.match(String(big.state["diff"]), /… \[clipped\]/);
  assert.ok(String(big.state["diff"]).length < 700);
});

test("clipping: one huge file cannot evict the small files (fair per-file share)", () => {
  const huge = chunk("huge.ts", ["z".repeat(50_000)]);
  const small1 = chunk("migrations/001.sql", ["CREATE TABLE a (id int);"]);
  const small2 = chunk("src/b.ts", ["export const b = 2;"]);
  const { state, clipped } = buildDiffRiskState(inputOf(["huge.ts", small1.path, small2.path], [huge, small1, small2]), 2_000);
  assert.equal(clipped, true);
  const diff = String(state["diff"]);
  assert.ok(diff.includes("CREATE TABLE a"), "small file kept whole");
  assert.ok(diff.includes("export const b = 2;"), "small file kept whole");
  assert.ok(diff.length <= 2_000 + 200, `budget respected, got ${diff.length}`);
});

test("clipping: max_diff_chars 0 sends the file list only, and says it was clipped", () => {
  const { state, clipped } = buildDiffRiskState(inputOf(["a.ts"], [chunk("a.ts", ["x"])]), 0);
  assert.equal(clipped, true);
  assert.equal(state["files"] instanceof Array && (state["files"] as string[])[0], "a.ts");
  assert.ok(!String(state["diff"]).includes("+x"));
});

test("clipping: the file list is bounded, the rest is a count", () => {
  const files = Array.from({ length: MAX_FILES_IN_STATE + 7 }, (_, i) => `f${i}.ts`);
  const { state } = buildDiffRiskState(inputOf(files, []), 1_000);
  const listed = state["files"] as string[];
  assert.equal(listed.length, MAX_FILES_IN_STATE + 1);
  assert.match(listed[listed.length - 1]!, /7 more file/);
});

test("clipping never hides a risk from the FLOOR: a secret in the clipped-away tail is still flagged", () => {
  const input = inputOf(["big.ts"], [chunk("big.ts", ["a".repeat(30_000), `const k = "${AWS_KEY}";`])]);
  const { state, clipped } = buildDiffRiskState(input, 1_000);
  assert.equal(clipped, true);
  assert.ok(!String(state["diff"]).includes(AWS_KEY), "the model never saw it");
  assert.deepEqual(flaggedKeys(input), ["secrets"], "the floor read the whole diff");
});

// ── the decision call, through a real Run ──────────────────────────────────

type StartedRun = Awaited<ReturnType<typeof steps.startRun>>;

async function withStartedRun(yaml: string, adwId: string, body: (run: StartedRun) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spf-decisions-diffrisk-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, yaml);
    const run = await steps.startRun({ prompt: "Add a thing", config_paths: [configPath], adw_id: adwId, cwd: dir, chain_name: "simple-sdlc", unattended: true }, [], []);
    try {
      await body(run);
    } finally {
      await run.tracer.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFake(fake: FakeDecisionClient, body: () => Promise<void>): Promise<void> {
  setDecisionClientFactory(() => fake);
  try {
    await body();
  } finally {
    setDecisionClientFactory(null);
  }
}

async function rows(run: StartedRun, adwId: string, name: string): Promise<Array<{ phase_id: string; payload_json: string }>> {
  return (await run.tracer.db.query("SELECT phase_id, payload_json FROM events WHERE adw_id=? AND type='log' AND name=?").all(adwId, name)) as Array<{
    phase_id: string;
    payload_json: string;
  }>;
}

const answerKeys = (touching: DiffRiskKey[], confidence = 0.95) =>
  FakeDecisionClient.answering(
    Object.fromEntries(DIFF_RISK_KEYS.map((key, i) => [`q${i}`, { type: "choice", choice: touching.includes(key) ? "touches" : "does_not_touch", confidence }])),
  );

const MIGRATION_DIFF = inputOf(["db/migrations/001_add.sql"], [chunk("db/migrations/001_add.sql", ["CREATE TABLE t (id int);"])]);
const BENIGN_DIFF = inputOf(["src/util.ts"], [chunk("src/util.ts", ["export const x = 1;"])]);

test("diff_risk: with NO decisions: block it is off — resolveDiffRisk is null, zero calls, zero rows (invariant 1)", async () => {
  const fake = answerKeys(["auth"]);
  await withFake(fake, async () => {
    await withStartedRun("watch:\n  repo: acme/widgets\n", "adw_dr_off", async (run) => {
      assert.equal(resolveDiffRisk(run), null);
      assert.equal(fake.calls.length, 0);
      assert.equal((await rows(run, "adw_dr_off", DECISION_EVENT)).length, 0);
      assert.equal((await rows(run, "adw_dr_off", DIFF_RISK_EVENT)).length, 0);
    });
  });
});

test("diff_risk: decisions enabled but diff_risk mode: off is off too, and its extras are not parsed", async () => {
  await withFake(answerKeys([]), async () => {
    const yaml = "decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: off, max_diff_chars: -5 }\n";
    await withStartedRun(yaml, "adw_dr_kind_off", async (run) => {
      assert.equal(resolveDiffRisk(run), null);
    });
  });
});

test("diff_risk: a bad max_diff_chars fails startRun when the kind is live, before any phase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-decisions-diffrisk-bad-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, "decisions:\n  enabled: true\n  kinds:\n    diff_risk: { max_diff_chars: -5 }\n");
    await assert.rejects(
      steps.startRun({ prompt: "x", config_paths: [configPath], adw_id: "adw_dr_bad", cwd: dir, chain_name: "simple-sdlc", unattended: true }, [], []),
      /decisions\.kinds\.diff_risk/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diff_risk shadow: one batch of seven keyed questions is recorded, but nothing is applied", async () => {
  const fake = answerKeys(["money"]);
  await withFake(fake, async () => {
    const adwId = "adw_dr_shadow";
    await withStartedRun("decisions:\n  enabled: true\n", adwId, async (run) => {
      const settings = resolveDiffRisk(run)!;
      const outcome = await decideDiffRisk(run, MIGRATION_DIFF, { settings, phase_id: "ph1" });
      assert.equal(fake.calls.length, 1, "ONE call for all seven");
      assert.deepEqual(Object.keys(fake.calls[0]!.questions), ["q0", "q1", "q2", "q3", "q4", "q5", "q6"]);
      assert.equal(outcome.applied, false);
      assert.deepEqual(
        outcome.flags.map((f) => f.key),
        ["schema"],
        "shadow acts on the fallback (the floor), never on the model's `money`",
      );
      assert.equal(mergeSignoff(false, outcome), false, "shadow never changes signoff");
      const decisions = (await rows(run, adwId, DECISION_EVENT)).map((r) => parseRecordedDecision(JSON.parse(r.payload_json))!);
      assert.deepEqual(
        decisions.map((d) => d.key),
        [...DIFF_RISK_KEYS],
      );
      assert.equal(decisions.find((d) => d.key === "money")!.model_choice, "touches");
      assert.equal(decisions.find((d) => d.key === "money")!.choice, "does_not_touch");
      const event = JSON.parse((await rows(run, adwId, DIFF_RISK_EVENT))[0]!.payload_json);
      assert.equal(event.mode, "shadow");
      assert.equal(event.applied, false);
      assert.deepEqual(event.model_would_add, ["money"], "the shadow-mode hit rate: what act would have added");
    });
  });
});

test("diff_risk act: the model's `touches` is OR-ed on top of the floor; a model `does_not_touch` never removes a floor flag", async () => {
  const fake = answerKeys(["money"]); // says money, and says does_not_touch for schema (which the floor flagged)
  await withFake(fake, async () => {
    const adwId = "adw_dr_act";
    await withStartedRun("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", adwId, async (run) => {
      const outcome = await decideDiffRisk(run, MIGRATION_DIFF, { settings: resolveDiffRisk(run)!, phase_id: "ph1" });
      assert.equal(outcome.applied, true);
      assert.deepEqual(
        outcome.flags.map((f) => [f.key, f.source]),
        [
          ["money", "model"],
          ["schema", "floor"],
        ],
      );
      assert.deepEqual(outcome.labels, ["risk:money", "risk:schema"]);
      assert.equal(outcome.require_human_signoff, true);
      assert.equal(mergeSignoff(false, outcome), true);
    });
  });
});

test("diff_risk act: a model that agrees with a floor hit is source floor+model", async () => {
  await withFake(answerKeys(["schema"]), async () => {
    await withStartedRun("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", "adw_dr_both", async (run) => {
      const outcome = await decideDiffRisk(run, MIGRATION_DIFF, { settings: resolveDiffRisk(run)!, phase_id: "" });
      assert.equal(outcome.flags[0]!.source, "floor+model");
    });
  });
});

test("diff_risk act: a benign diff and a quiet model flags nothing and requires nothing", async () => {
  await withFake(answerKeys([]), async () => {
    await withStartedRun("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", "adw_dr_quiet", async (run) => {
      const outcome = await decideDiffRisk(run, BENIGN_DIFF, { settings: resolveDiffRisk(run)!, phase_id: "" });
      assert.deepEqual(outcome.flags, []);
      assert.equal(outcome.require_human_signoff, false);
      assert.equal(mergeSignoff(false, outcome), false);
    });
  });
});

test("diff_risk act: a below-threshold model answer falls back to the floor", async () => {
  await withFake(answerKeys(["auth"], 0.1), async () => {
    await withStartedRun("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", "adw_dr_lowconf", async (run) => {
      const outcome = await decideDiffRisk(run, BENIGN_DIFF, { settings: resolveDiffRisk(run)!, phase_id: "" });
      assert.deepEqual(outcome.flags, [], "an unsure model adds nothing");
    });
  });
});

test("diff_risk batch fallback: a model error leaves exactly the floor, for all seven keys, and records why", async () => {
  const fake = FakeDecisionClient.failing(new SystemOneApiError(529, "overloaded"));
  await withFake(fake, async () => {
    const adwId = "adw_dr_error";
    await withStartedRun("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", adwId, async (run) => {
      const outcome = await decideDiffRisk(run, MIGRATION_DIFF, { settings: resolveDiffRisk(run)!, phase_id: "ph1" });
      assert.deepEqual(
        outcome.flags.map((f) => [f.key, f.source]),
        [["schema", "floor"]],
      );
      assert.equal(outcome.require_human_signoff, true, "the deterministic floor still requires signoff in act mode");
      const decisions = (await rows(run, adwId, DECISION_EVENT)).map((r) => parseRecordedDecision(JSON.parse(r.payload_json))!);
      assert.equal(decisions.length, 7);
      for (const d of decisions) {
        assert.equal(d.used_fallback, true);
        assert.equal(d.reason, "error");
        assert.equal(d.choice, d.key === "schema" ? "touches" : "does_not_touch");
      }
    });
  });
});

test("diff_risk: the clip is reported on the outcome and the event; the model's state says it was clipped", async () => {
  const fake = answerKeys([]);
  await withFake(fake, async () => {
    const adwId = "adw_dr_clip";
    await withStartedRun("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act, max_diff_chars: 300 }\n", adwId, async (run) => {
      const input = inputOf(["src/big.ts"], [chunk("src/big.ts", ["q".repeat(5_000)])]);
      const outcome = await decideDiffRisk(run, input, { settings: resolveDiffRisk(run)!, phase_id: "" });
      assert.equal(outcome.clipped, true);
      const state = fake.calls[0]!.state as Record<string, unknown>;
      assert.equal(state["diff_clipped"], true);
      assert.match(String(state["note"]), /CLIPPED/);
      assert.equal(JSON.parse((await rows(run, adwId, DIFF_RISK_EVENT))[0]!.payload_json).clipped, true);
    });
  });
});

// ── collecting the diff from real git ───────────────────────────────────────

test("collectDiff: tracked changes, deletions and untracked files (whole text read for the floor, binary by name) all reach the floor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-diffrisk-git-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, "keep.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "gone.ts"), "export const g = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    git("switch", "-q", "-c", "work"); // commit phases refuse protected branches (#97)
    const base = git("rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "keep.ts"), "export const a = 2;\n");
    git("rm", "-q", "gone.ts");
    mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    writeFileSync(join(dir, "db", "migrations", "001.sql"), "DROP TABLE users;\n");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(dir, "big.txt"), "x".repeat(40 * 1024) + `\n${AWS_KEY}\n`);

    const repo = { repo_root: dir } as unknown as Parameters<typeof collectDiff>[0];
    const input = collectDiff(repo, base);
    assert.ok(input.files.includes("keep.ts") && input.files.includes("gone.ts") && input.files.includes("db/migrations/001.sql") && input.files.includes("blob.bin"));
    const floor = diffRiskFloor(input);
    assert.ok(floor.schema.length > 0, "an untracked migration is seen by path");
    assert.ok(floor.data_loss.length > 0, "an untracked file's added lines are scanned");
    assert.ok(floor.secrets.length > 0, "an untracked file is scanned whole by the floor — a secret far past 16 KiB is still found");
    assert.equal(input.unreadable, null);
    assert.deepEqual(input.unscanned, []);
    const blob = input.chunks.find((c) => c.path === "blob.bin")!;
    assert.ok(!blob.text.includes("\u0001"), "binary content is not read");
    assert.ok(input.chunks.find((c) => c.path === "keep.ts")!.text.includes("+export const a = 2;"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── through the real simple_sdlc chain ─────────────────────────────────────

function approvingReview(): ReviewOutputT {
  return { status: "success", summary: "ok", artifacts: [], notes_for_next_agent: "", approved: true, findings: [], blocking: [] };
}

function sdlcRepo(extraYaml: string): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "spf-decisions-diffrisk-sdlc-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "README.md"), "hi\n");
  writeFileSync(join(dir, "s.md"), "system\n");
  writeFileSync(join(dir, "u.md"), "user\n");
  const configPath = join(dir, "spf.config.yaml");
  const agents = simpleSdlc.REQUIRED_AGENTS.map((name) => `  - {name: ${name}, prompt_engineering: {system: s.md, user: u.md}}\n`).join("");
  writeFileSync(configPath, `agents:\n${agents}quality:\n  checks:\n    - {name: test, operation: build, argv: ["true"]}\n  suites:\n    test: [test]\n${extraYaml}`);
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("switch", "-q", "-c", "work"); // commit phases refuse protected branches (#97)
  return { dir, configPath };
}

/** Real `simple_sdlc.main`, scripted agents. The builder writes `buildFile` (untracked until commit_build); the reviewer approves. */
async function runSdlc(
  extraYaml: string,
  adwId: string,
  buildFile: { path: string; content: string },
): Promise<{ code: number; error: Error | null; phases: string[]; dir: string }> {
  const { dir, configPath } = sdlcRepo(extraYaml);
  const phases: string[] = [];
  const respond = (phase: string): EnvelopeBase => {
    if (phase === "plan") {
      writeFileSync(join(dir, "plan.md"), "the plan\n");
      return { status: "success", summary: "planned", artifacts: [], notes_for_next_agent: "" };
    }
    if (phase === "build") {
      mkdirSync(join(dir, buildFile.path, ".."), { recursive: true });
      writeFileSync(join(dir, buildFile.path), buildFile.content);
      return { status: "success", summary: "built", artifacts: [], notes_for_next_agent: "", changed_files: [buildFile.path], commit_message: "build it" } as EnvelopeBase;
    }
    if (phase.startsWith("review_")) return approvingReview();
    return { status: "success", summary: "documented", artifacts: [], notes_for_next_agent: "", document_path: "", documented_files: [], commit_message: "docs" } as EnvelopeBase;
  };
  const realPhase = Run.prototype.phase;
  const wrapped = mock.method(Run.prototype, "phase", function (this: Run, params: { name: string }, fn: (ph: PhaseHandle) => Promise<unknown>) {
    phases.push(params.name);
    return realPhase.call(this, params as Parameters<typeof realPhase>[0], (ph) =>
      fn({ phase_id: ph.phase_id, log: (p: Record<string, unknown>) => ph.log(p), call: (async () => respond(params.name)) as PhaseHandle["call"] }),
    );
  });
  const originalLog = console.log;
  console.log = () => {};
  try {
    try {
      const code = await simpleSdlc.main({ prompt: "Add a thing", config_paths: [configPath], adw_id: adwId, cwd: dir, chain_name: "simple-sdlc", unattended: true });
      return { code, error: null, phases, dir };
    } catch (error) {
      // `decideSignoff` fails the phase CLOSED by throwing; `main` lets it propagate to the dispatcher.
      return { code: 1, error: error as Error, phases, dir };
    }
  } finally {
    console.log = originalLog;
    wrapped.mock.restore();
  }
}

function traceRows(dir: string, adwId: string, name: string): Array<{ phase_id: string; payload_json: string }> {
  const db = new DatabaseSync(join(dir, ".spf", "data", "spf.db"));
  try {
    return db.prepare("SELECT phase_id, payload_json FROM events WHERE adw_id=? AND type='log' AND name=?").all(adwId, name) as Array<{ phase_id: string; payload_json: string }>;
  } finally {
    db.close();
  }
}

const MIGRATION_FILE = { path: "db/migrations/001_add.sql", content: "CREATE TABLE t (id int);\n" };
const PLAIN_FILE = { path: "src/util.ts", content: "export const x = 1;\n" };

test("simple_sdlc: with NO decisions: block there is no diff_risk phase, no call, and an unattended migration still commits on the AI verdict (invariant 1)", async () => {
  const fake = answerKeys(["auth", "money", "schema", "data_loss", "state", "api_contract", "secrets"]);
  await withFake(fake, async () => {
    const { code, phases, dir } = await runSdlc("", "adw_dr_sdlc_off", MIGRATION_FILE);
    try {
      assert.equal(fake.calls.length, 0);
      assert.ok(!phases.includes("diff_risk"));
      assert.ok(phases.includes("signoff") && phases.includes("commit_build"));
      assert.equal(code, 0);
      assert.equal(traceRows(dir, "adw_dr_sdlc_off", DIFF_RISK_EVENT).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("simple_sdlc shadow: the flag is recorded but the unattended run still commits (signoff untouched)", async () => {
  const fake = answerKeys([]);
  await withFake(fake, async () => {
    const adwId = "adw_dr_sdlc_shadow";
    const { code, phases, dir } = await runSdlc("decisions:\n  enabled: true\n", adwId, MIGRATION_FILE);
    try {
      assert.ok(phases.indexOf("diff_risk") > phases.indexOf("review_1") && phases.indexOf("diff_risk") < phases.indexOf("signoff"), "after the review, before signoff");
      assert.ok(phases.includes("commit_build"));
      assert.equal(code, 0);
      const event = JSON.parse(traceRows(dir, adwId, DIFF_RISK_EVENT)[0]!.payload_json);
      assert.equal(event.applied, false);
      assert.deepEqual(event.labels, ["risk:schema"]);
      assert.equal(fake.calls.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("simple_sdlc act: a floor-flagged migration requires human signoff — the unattended run fails closed, even when the model says nothing is risky", async () => {
  const fake = answerKeys([]);
  await withFake(fake, async () => {
    const adwId = "adw_dr_sdlc_act";
    const { code, error, phases, dir } = await runSdlc("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", adwId, MIGRATION_FILE);
    try {
      assert.ok(phases.includes("diff_risk") && phases.includes("signoff"));
      assert.ok(!phases.includes("commit_build"), "signoff failed closed before any commit of the code");
      assert.notEqual(code, 0);
      assert.match(error?.message ?? "", /require_human_signoff is true but this run is unattended.*diff_risk requires human signoff.*risk:schema/);
      const event = JSON.parse(traceRows(dir, adwId, DIFF_RISK_EVENT)[0]!.payload_json);
      assert.equal(event.applied, true);
      assert.equal(event.require_human_signoff, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("simple_sdlc act: a benign diff with a quiet model changes nothing — the run commits as before", async () => {
  await withFake(answerKeys([]), async () => {
    const { code, phases, dir } = await runSdlc("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", "adw_dr_sdlc_quiet", PLAIN_FILE);
    try {
      assert.ok(phases.includes("diff_risk") && phases.includes("commit_build"));
      assert.equal(code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("simple_sdlc act: a model-only flag (no floor hit) also requires signoff", async () => {
  await withFake(answerKeys(["money"]), async () => {
    const { code, error, phases, dir } = await runSdlc("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", "adw_dr_sdlc_model", PLAIN_FILE);
    try {
      assert.ok(!phases.includes("commit_build"));
      assert.notEqual(code, 0);
      assert.match(error?.message ?? "", /risk:money/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("simple_sdlc act: review.require_human_signoff: true is never turned off by a quiet diff_risk", async () => {
  await withFake(answerKeys([]), async () => {
    const yaml = "review:\n  require_human_signoff: true\ndecisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n";
    const { code, phases, dir } = await runSdlc(yaml, "adw_dr_sdlc_cfg", PLAIN_FILE);
    try {
      assert.ok(!phases.includes("commit_build"), "still fails closed unattended");
      assert.notEqual(code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("simple_sdlc act: a failing decision model leaves the floor in force", async () => {
  await withFake(FakeDecisionClient.failing(new SystemOneApiError(500, "boom")), async () => {
    const { code, error, phases, dir } = await runSdlc("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", "adw_dr_sdlc_err", MIGRATION_FILE);
    try {
      assert.ok(!phases.includes("commit_build"));
      assert.notEqual(code, 0);
      assert.match(error?.message ?? "", /risk:schema/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── review fixes: large diffs, redaction, long lines, non-ASCII, fail closed ──

function scratchRepo(): { dir: string; git: (...args: string[]) => string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "spf-diffrisk-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("switch", "-q", "-c", "work"); // commit phases refuse protected branches (#97)
  return { dir, git, base: git("rev-parse", "HEAD").trim() };
}

test("collectDiff: a diff over git's default 1 MiB buffer still reaches the floor (the path floor never depended on diff text)", () => {
  const { dir, git, base } = scratchRepo();
  try {
    // A regenerated lockfile of ~3 MiB plus a destructive migration.
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: Array.from({ length: 60_000 }, (_, i) => `pkg-${i}-${"x".repeat(40)}`) }));
    mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    writeFileSync(join(dir, "db", "migrations", "001.sql"), "DROP TABLE users;\n");
    git("add", "package-lock.json");
    const input = collectDiff({ repo_root: dir } as Parameters<typeof collectDiff>[0], base);
    assert.equal(input.unreadable, null, "a large diff is read, not thrown away");
    assert.ok(input.chunks.some((c) => c.path === "package-lock.json" && c.text.length > 1024 * 1024), "the large file's diff was read");
    const floor = diffRiskFloor(input);
    assert.ok(floor.schema.length > 0 && floor.data_loss.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectDiff: an unreadable base fails closed in the outcome while the path floor still runs", () => {
  const { dir } = scratchRepo();
  try {
    mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    writeFileSync(join(dir, "db", "migrations", "001.sql"), "SELECT 1;\n");
    const input = collectDiff({ repo_root: dir } as Parameters<typeof collectDiff>[0], "0".repeat(40));
    assert.match(String(input.unreadable), /git diff/);
    assert.ok(input.files.includes("db/migrations/001.sql"), "untracked paths are still listed");
    const outcome = resolveDiffRiskOutcome(diffRiskFloor(input), {}, { clipped: false, applied: true, unreadable: input.unreadable });
    assert.deepEqual(outcome.flags.map((f) => f.key), ["schema"], "the path floor ran with no diff text");
    assert.equal(outcome.require_human_signoff, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectDiff: non-ASCII paths are real paths (quotePath=false), so path rules and untracked reads work", () => {
  const { dir, base } = scratchRepo();
  try {
    writeFileSync(join(dir, "migración_001.sql"), "DROP TABLE users;\n");
    const input = collectDiff({ repo_root: dir } as Parameters<typeof collectDiff>[0], base);
    assert.ok(input.files.includes("migración_001.sql"), "not C-quoted");
    const floor = diffRiskFloor(input);
    assert.ok(floor.schema.length > 0, "the .sql path rule matched");
    assert.ok(floor.data_loss.length > 0, "the untracked file's content was scanned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectDiff: an untracked file past the per-file cap is listed as unscanned, its path still checked", () => {
  const { dir, base } = scratchRepo();
  try {
    writeFileSync(join(dir, "huge.sql"), Buffer.alloc(MAX_UNTRACKED_FILE_BYTES + 1, 97));
    const input = collectDiff({ repo_root: dir } as Parameters<typeof collectDiff>[0], base);
    assert.deepEqual(input.unscanned, ["huge.sql"]);
    assert.ok(diffRiskFloor(input).schema.length > 0);
    const { state } = buildDiffRiskState(input, 1_000);
    assert.match(String(state["note"]), /too large/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("splitDiff: a C-quoted header still starts its own chunk", () => {
  const chunks = splitDiff(['diff --git a/a.ts b/a.ts', "+x", 'diff --git "a/we\\"ird.sql" "b/we\\"ird.sql"', "+DROP TABLE t;"].join("\n"));
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1]!.text.includes("DROP TABLE"));
});

test("floor: a secret on a very long (minified) line is found by windowed scanning, not skipped", () => {
  const long = "a".repeat(9_000) + " " + AWS_KEY + " " + "b".repeat(9_000);
  assert.deepEqual(flaggedKeys(inputOf(["x.json"], [chunk("x.json", [long])])), ["secrets"]);
});

test("redaction: the model's state never contains a secret the floor recognises, and secret-path files are name only", () => {
  const input = inputOf(
    ["src/a.ts", ".env", "certs/server.pem"],
    [
      chunk("src/a.ts", [`const k = "${AWS_KEY}";`, `const t = "${GH_TOKEN}";`, PEM, "const ok = 1;"]),
      chunk(".env", [`AWS=${AWS_KEY}`]),
      chunk("certs/server.pem", [PEM, "MIIEvQIBADANBg"]),
    ],
  );
  const { state } = buildDiffRiskState(input, 100_000);
  const sent = JSON.stringify(state);
  for (const secret of [AWS_KEY, GH_TOKEN, PEM, "MIIEvQIBADANBg"]) assert.ok(!sent.includes(secret), `leaked ${secret.slice(0, 8)}`);
  assert.match(String(state["diff"]), /\[redacted: AWS access key id\]/);
  assert.match(String(state["diff"]), /const ok = 1;/, "non-secret code is still shown");
  assert.deepEqual(state["withheld_files"], [".env", "certs/server.pem"]);
  assert.deepEqual(flaggedKeys(input), ["secrets"], "the floor still reads the unredacted text");
  assert.equal(secretPathReason("src/a.ts"), null);
  assert.equal(redactSecrets("nothing here"), "nothing here");
});

test("redaction: what reaches the decision client (not just the builder) is redacted", async () => {
  const fake = answerKeys([]);
  await withFake(fake, async () => {
    await withStartedRun("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: shadow }\n", "adw_dr_redact", async (run) => {
      const input = inputOf(["src/a.ts"], [chunk("src/a.ts", [`const k = "${AWS_KEY}";`, `const t = "${GH_TOKEN}";`])]);
      const outcome = await decideDiffRisk(run, input, { settings: resolveDiffRisk(run)!, phase_id: "" });
      const sent = JSON.stringify(fake.calls[0]!.state);
      assert.ok(!sent.includes(AWS_KEY) && !sent.includes(GH_TOKEN) && !sent.includes(PEM));
      assert.deepEqual(outcome.flags.map((f) => f.key), ["secrets"], "the floor flagged what the model never saw");
    });
  });
});

test("diff_risk: an unreadable diff in act mode requires signoff and records why; in shadow it applies nothing", async () => {
  for (const mode of ["act", "shadow"] as const) {
    await withFake(answerKeys([]), async () => {
      const adwId = `adw_dr_unreadable_${mode}`;
      await withStartedRun(`decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: ${mode} }\n`, adwId, async (run) => {
        const outcome = await decideDiffRisk(run, { ...BENIGN_DIFF, unreadable: "git diff failed" }, { settings: resolveDiffRisk(run)!, phase_id: "" });
        assert.equal(outcome.applied, mode === "act");
        assert.equal(mergeSignoff(false, outcome), mode === "act");
        const event = JSON.parse((await rows(run, adwId, DIFF_RISK_EVENT))[0]!.payload_json);
        assert.equal(event.unreadable, "git diff failed");
      });
    });
  }
});

test("diffRiskFailure: act mode fails closed with the reason, shadow applies nothing, both leave an event", async () => {
  for (const mode of ["act", "shadow"] as const) {
    await withFake(answerKeys([]), async () => {
      const adwId = `adw_dr_failure_${mode}`;
      await withStartedRun(`decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: ${mode} }\n`, adwId, async (run) => {
        const outcome = await diffRiskFailure(run, new Error("spawn EAGAIN"), "");
        assert.equal(mergeSignoff(false, outcome), mode === "act");
        assert.match(String(outcome.unreadable), /spawn EAGAIN/);
        assert.equal((await rows(run, adwId, DIFF_RISK_EVENT)).length, 1);
      });
    });
  }
});

test("simple_sdlc act: a flagged diff's unattended failure does NOT advise `spf watch`, and says watch/fanout/loop block too", async () => {
  await withFake(answerKeys([]), async () => {
    const { error, dir } = await runSdlc("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", "adw_dr_sdlc_msg", MIGRATION_FILE);
    try {
      const message = error?.message ?? "";
      assert.match(message, /risk:schema/);
      assert.doesNotMatch(message, /where a human merges the PR/);
      assert.match(message, /spf watch.*spf fanout.*blocks the issue.*spf loop.*stops at once/);
      assert.ok(error instanceof SignoffRequiredError, "a typed, terminal stop");
      assert.deepEqual(error.labels, ["risk:schema"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── review round 2: secret shapes, hard clip budget, typed stop, seam coverage ──

const NPM_TOKEN = "npm_" + "aB3dE5gH7j".repeat(3) + "aB3dE5";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLE" + "KEY";

test("floor: every key has at least one floor rule", () => {
  assert.deepEqual(floorRuleKeys(), [...DIFF_RISK_KEYS]);
});

test("floor: credential dotfiles and tool configs are secrets by PATH, and sent to the model by name only", () => {
  for (const file of [".npmrc", "web/.npmrc", ".envrc", ".netrc", ".pypirc", "home/.aws/credentials", "kubeconfig", "deploy/.kube/config", "infra/prod.tfvars", "infra/prod.tfvars.json"]) {
    assert.ok(flaggedKeys(inputOf([file])).includes("secrets"), `${file} should flag secrets`);
    assert.ok(secretPathReason(file) !== null, `${file} is withheld from the model`);
  }
  assert.deepEqual(flaggedKeys(inputOf(["docs/npmrc-howto.md", "src/kubeconfig_loader.ts"])), [], "lookalike names are not flagged");
});

test("floor + redaction: unquoted assignments, YAML values, URL userinfo and npm tokens are flagged and never reach the model", () => {
  const samples: Array<[string, string]> = [
    [`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`, NPM_TOKEN],
    [`export AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, AWS_SECRET],
    ["password: s3cr3tpassw0rd123", "s3cr3tpassw0rd123"],
    ["  api_key: abcdef0123456789abcdef", "abcdef0123456789abcdef"],
    ["DATABASE_URL='postgres://admin:hunter2hunter2@db/x'", "hunter2hunter2"],
    [`const t = "${NPM_TOKEN}";`, NPM_TOKEN],
  ];
  for (const [line, secret] of samples) {
    const input = inputOf(["src/conf.ts"], [chunk("src/conf.ts", [line])]);
    assert.ok(flaggedKeys(input).includes("secrets"), `floor should flag: ${line}`);
    const { state } = buildDiffRiskState(input, 10_000);
    assert.ok(!JSON.stringify(state).includes(secret), `the model must not see: ${line}`);
    assert.ok(!redactSecrets(line).includes(secret));
  }
});

test("floor: references and calls that merely mention a credential name are NOT flagged", () => {
  const lines = [
    "const token = getTokenFromRequest(req);",
    "password: process.env.DB_PASSWORD_VALUE",
    "url: https://user:${PASSWORD}@host/path",
    "token: string | undefined;",
    "api_key: <your-api-key-goes-here>",
    "secret: {{ vault.secret_value_ref }}",
    "const passwordHash = hashPassword(input);",
  ];
  assert.deepEqual(flaggedKeys(inputOf(["src/ok.ts"], [chunk("src/ok.ts", lines)])), []);
});

test("clipping: max_diff_chars is a HARD bound on state.diff even with thousands of files (headers, marks and the omitted line count)", () => {
  const files = Array.from({ length: 3_000 }, (_, i) => `src/gen/file_${i}.ts`);
  const chunks = files.map((f) => chunk(f, ["x".repeat(180)]));
  for (const budget of [16_000, 2_000, 400, 60, 10, 0]) {
    const { state, clipped } = buildDiffRiskState(inputOf(files, chunks), budget);
    const diff = String(state["diff"]);
    assert.ok(diff.length <= budget, `budget ${budget}: diff was ${diff.length}`);
    assert.equal(clipped, true);
    assert.ok((state["files"] as string[]).length <= MAX_FILES_IN_STATE + 1);
    assert.ok(JSON.stringify(state).length < budget + 40_000, "the whole body stays bounded too");
  }
  const zero = buildDiffRiskState(inputOf(files, chunks), 0);
  assert.equal(zero.state["diff"], "", "0 sends the file list only");
  const some = buildDiffRiskState(inputOf(files, chunks), 16_000);
  assert.match(String(some.state["diff"]), /\(\d+ more file\(s\) omitted\)$/);
  assert.match(String(some.state["note"]), /not shown at all/);
  assert.ok(Number(some.state["diff_files_omitted"]) > 0);
});

test("clipping: a diff that fits the budget exactly is not clipped; a cut file ends with the clip mark inside the budget", () => {
  const small = inputOf(["a.ts"], [chunk("a.ts", ["x"])]);
  const whole = String(buildDiffRiskState(small, 100_000).state["diff"]);
  assert.equal(buildDiffRiskState(small, whole.length).clipped, false);
  const cut = buildDiffRiskState(inputOf(["a.ts"], [chunk("a.ts", ["y".repeat(5_000)])]), 500);
  assert.ok(String(cut.state["diff"]).length <= 500);
  assert.match(String(cut.state["diff"]), /… \[clipped\]$/);
});

test("SignoffRequiredError: withholds the WIP only when a secret was flagged or the diff could not be read", () => {
  assert.equal(new SignoffRequiredError("m", ["risk:secrets", "risk:auth"]).withholdsWip, true);
  assert.equal(new SignoffRequiredError("m", [], "git failed").withholdsWip, true);
  assert.equal(new SignoffRequiredError("m", ["risk:schema"]).withholdsWip, false);
  assert.match(new SignoffRequiredError("m", []).message, /^\[spf:signoff-required\] m$/);
});

test("simple_sdlc act: when the decision itself throws, the run still fails CLOSED at signoff (never fails the phase, never commits)", async () => {
  await withFake(answerKeys([]), async () => {
    const boom = mock.method(Decider.prototype, "decideBatch", async () => {
      throw new Error("decision layer exploded");
    });
    try {
      const { code, error, phases, dir } = await runSdlc("decisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n", "adw_dr_sdlc_throw_act", PLAIN_FILE);
      try {
        assert.ok(phases.includes("diff_risk") && phases.includes("signoff"), "diff_risk did not abort the run before signoff");
        assert.ok(!phases.includes("commit_build"));
        assert.notEqual(code, 0);
        assert.ok(error instanceof SignoffRequiredError);
        assert.match(error.message, /diff not fully readable: diff_risk could not run: decision layer exploded/);
        assert.equal(error.withholdsWip, true, "a diff that could not be checked is not pushed");
        const event = JSON.parse(traceRows(dir, "adw_dr_sdlc_throw_act", DIFF_RISK_EVENT)[0]!.payload_json);
        assert.equal(event.applied, true);
        assert.match(event.unreadable, /decision layer exploded/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      boom.mock.restore();
    }
  });
});

test("simple_sdlc shadow: when the decision itself throws, nothing is applied and the run commits as before", async () => {
  await withFake(answerKeys([]), async () => {
    const boom = mock.method(Decider.prototype, "decideBatch", async () => {
      throw new Error("decision layer exploded");
    });
    try {
      const { code, phases, dir } = await runSdlc("decisions:\n  enabled: true\n", "adw_dr_sdlc_throw_shadow", PLAIN_FILE);
      try {
        assert.ok(phases.includes("commit_build"));
        assert.equal(code, 0);
        const event = JSON.parse(traceRows(dir, "adw_dr_sdlc_throw_shadow", DIFF_RISK_EVENT)[0]!.payload_json);
        assert.equal(event.applied, false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      boom.mock.restore();
    }
  });
});

test("simple_sdlc act: with review.require_human_signoff already true, the error names BOTH causes and does not blame diff_risk alone", async () => {
  await withFake(answerKeys([]), async () => {
    const yaml = "review:\n  require_human_signoff: true\ndecisions:\n  enabled: true\n  kinds:\n    diff_risk: { mode: act }\n";
    const { error, dir } = await runSdlc(yaml, "adw_dr_sdlc_both", MIGRATION_FILE);
    try {
      const message = error?.message ?? "";
      assert.match(message, /review\.require_human_signoff is true in the config and the decision layer's diff_risk also requires/);
      assert.match(message, /risk:schema/);
      assert.match(message, /set review\.require_human_signoff to false AND decisions\.kinds\.diff_risk\.mode/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("decideSignoff attended: diff_risk labels are shown to the human and logged with the decision", async () => {
  const warned: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const asker = { confirm: async () => true, close: () => {} } as unknown as NonNullable<simpleSdlc.SignoffParams["asker"]>;
  const outcome = await simpleSdlc.decideSignoff({
    review: approvingReview(),
    canPrompt: true,
    requireHumanSignoff: true,
    diffRisk: { labels: ["risk:schema", "risk:secrets"] },
    signoffTimeoutSeconds: 5,
    asker,
    identity: { name: "Pat", email: "pat@example.com" },
    log: async (payload) => void logged.push(payload),
    warn: (line) => void warned.push(line),
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.recordedYes, true);
  assert.ok(warned.some((l) => /diff risk flagged: risk:schema, risk:secrets/.test(l)), "the human is told what was flagged");
  assert.deepEqual(logged.find((p) => p["decision"] === "approved")?.["diff_risk"], ["risk:schema", "risk:secrets"]);
});

test("decideSignoff attended: a declined prompt still logs the diff_risk cause, and an unreadable diff is shown", async () => {
  const warned: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const asker = { confirm: async () => false, close: () => {} } as unknown as NonNullable<simpleSdlc.SignoffParams["asker"]>;
  const outcome = await simpleSdlc.decideSignoff({
    review: approvingReview(),
    canPrompt: true,
    requireHumanSignoff: true,
    diffRisk: { labels: [], reason: "git diff failed" },
    signoffTimeoutSeconds: 5,
    asker,
    identity: undefined,
    log: async (payload) => void logged.push(payload),
    warn: (line) => void warned.push(line),
  });
  assert.equal(outcome.accepted, false);
  assert.ok(warned.some((l) => /could not be fully read \(git diff failed\)/.test(l)));
  assert.equal(logged.find((p) => p["decision"] === "declined")?.["diff_risk_unreadable"], "git diff failed");
});
