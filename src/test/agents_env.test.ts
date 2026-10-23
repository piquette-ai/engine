/**
 * Regression tests for `spf.config.yaml`'s `env:` block — a declarative,
 * committable alternative to an out-of-band shell export for non-secret
 * settings like `SPF_CLAUDE_CMD` (see `SFConfigSchema`'s doc comment in
 * `data_types.ts` and `agents.ts`'s `applyConfigEnv`/`interpolateEnvValue`).
 * `env: config merges into `SFConfig` (loadConfig's own merge behavior) is
 * covered separately in `data_types.test.ts` — this file is specifically
 * about applying that map to `process.env`: precedence against an
 * already-set var, `${VAR}` interpolation, and the fail-loud contract for a
 * reference to something genuinely unset.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { agentEnv, applyConfigEnv, interpolateEnvValue, loadConfig } from "../core/agents.js";
import { AgentConfigSchema } from "../core/data_types.js";
import { operatorEnv } from "../core/utils.js";

const PROBE_KEYS = ["SPF_TEST_ENV_A", "SPF_TEST_ENV_B", "SPF_TEST_ENV_SECRET", "SPF_TEST_ENV_UNDEFINED"];

/** Saves/restores a set of process.env keys around a test — this module mutates real global state. */
function withEnv(fn: () => void): void {
  const saved = new Map(PROBE_KEYS.map((k) => [k, process.env[k]]));
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("applyConfigEnv: a key not already in process.env gets set from cfg.env", () => {
  withEnv(() => {
    delete process.env.SPF_TEST_ENV_A;
    applyConfigEnv({ SPF_TEST_ENV_A: "from-config" });
    assert.equal(process.env.SPF_TEST_ENV_A, "from-config");
  });
});

test("applyConfigEnv: an already-set process.env value wins — cfg.env supplies a default, never forces an override", () => {
  withEnv(() => {
    process.env.SPF_TEST_ENV_A = "from-shell";
    applyConfigEnv({ SPF_TEST_ENV_A: "from-config" });
    assert.equal(process.env.SPF_TEST_ENV_A, "from-shell", "matches process.loadEnvFile()'s own precedence for .env");
  });
});

test("applyConfigEnv: ${VAR} interpolates from process.env at call time — a real secret can live in .env and be referenced without being written into spf.config.yaml", () => {
  withEnv(() => {
    delete process.env.SPF_TEST_ENV_B;
    process.env.SPF_TEST_ENV_SECRET = "sekrit-value";
    applyConfigEnv({ SPF_TEST_ENV_B: "prefix-${SPF_TEST_ENV_SECRET}-suffix" });
    assert.equal(process.env.SPF_TEST_ENV_B, "prefix-sekrit-value-suffix");
  });
});

test("applyConfigEnv: multiple entries apply independently, each against its own precedence check", () => {
  withEnv(() => {
    process.env.SPF_TEST_ENV_A = "already-set";
    delete process.env.SPF_TEST_ENV_B;
    applyConfigEnv({ SPF_TEST_ENV_A: "ignored", SPF_TEST_ENV_B: "applied" });
    assert.equal(process.env.SPF_TEST_ENV_A, "already-set");
    assert.equal(process.env.SPF_TEST_ENV_B, "applied");
  });
});

test("interpolateEnvValue: a plain value with no ${...} passes through untouched", () => {
  assert.equal(interpolateEnvValue("SPF_CLAUDE_CMD", "ollama launch claude --model {model}"), "ollama launch claude --model {model}");
});

test("interpolateEnvValue: an undefined ${VAR} reference throws, naming both the config key and the missing var — fail loud, not a silent empty string", () => {
  withEnv(() => {
    delete process.env.SPF_TEST_ENV_UNDEFINED;
    assert.throws(
      () => interpolateEnvValue("SOME_KEY", "${SPF_TEST_ENV_UNDEFINED}"),
      /env\.SOME_KEY: references \$\{SPF_TEST_ENV_UNDEFINED\}, which is not set/,
    );
  });
});

test("applyConfigEnv: an undefined ${VAR} reference throws even when applying (not silently skipped or emptied)", () => {
  withEnv(() => {
    delete process.env.SPF_TEST_ENV_A;
    delete process.env.SPF_TEST_ENV_UNDEFINED;
    assert.throws(() => applyConfigEnv({ SPF_TEST_ENV_A: "${SPF_TEST_ENV_UNDEFINED}" }));
    assert.equal(process.env.SPF_TEST_ENV_A, undefined, "the throwing key is never partially applied");
  });
});

// ── sync credentials never reach a subprocess (#135, #33) ────────────────────

test("the default sync credential vars are absent from operatorEnv() and from agentEnv, even when allowlisted", () => {
  const saved = [process.env.SPF_SYNC_CLIENT_ID, process.env.SPF_SYNC_CLIENT_SECRET];
  try {
    process.env.SPF_SYNC_CLIENT_ID = "id-value-123";
    process.env.SPF_SYNC_CLIENT_SECRET = "secret-value-456";
    const env = operatorEnv();
    assert.equal(env.SPF_SYNC_CLIENT_ID, undefined);
    assert.equal(env.SPF_SYNC_CLIENT_SECRET, undefined);
    assert.ok(env.PATH, "ordinary vars still pass");
    const agent = v.parse(AgentConfigSchema, {
      name: "builder",
      prompt_engineering: { system: "s.md", user: "u.md" },
      env_allowlist: ["SPF_SYNC_CLIENT_ID", "SPF_SYNC_CLIENT_SECRET", "PATH"],
    });
    const filtered = agentEnv(agent)!;
    assert.equal(filtered.SPF_SYNC_CLIENT_ID, undefined);
    assert.equal(filtered.SPF_SYNC_CLIENT_SECRET, undefined);
    assert.ok(filtered.PATH);
  } finally {
    for (const [i, k] of ["SPF_SYNC_CLIENT_ID", "SPF_SYNC_CLIENT_SECRET"].entries()) {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    }
  }
});

test("custom sync.client_*_env names are denied once the config loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-sync-deny-test-"));
  try {
    const file = join(dir, "spf.config.yaml");
    writeFileSync(file, "sync:\n  endpoint: https://hub.example.com\n  client_id_env: MY_HUB_ID\n  client_secret_env: MY_HUB_SECRET\n");
    process.env.MY_HUB_ID = "custom-id-123";
    process.env.MY_HUB_SECRET = "custom-secret-456";
    assert.equal(operatorEnv().MY_HUB_ID, "custom-id-123", "not denied before a config names it");
    loadConfig([file]);
    const env = operatorEnv();
    assert.equal(env.MY_HUB_ID, undefined);
    assert.equal(env.MY_HUB_SECRET, undefined);
    const agent = v.parse(AgentConfigSchema, { name: "b", prompt_engineering: { system: "s.md", user: "u.md" }, env_allowlist: ["MY_HUB_ID", "MY_HUB_SECRET"] });
    assert.deepEqual(Object.keys(agentEnv(agent)!).filter((k) => k.startsWith("MY_HUB")), []);
  } finally {
    delete process.env.MY_HUB_ID;
    delete process.env.MY_HUB_SECRET;
    rmSync(dir, { recursive: true, force: true });
  }
});
