import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "../core/tracer.js";
import { sessionsCommand } from "../cli/commands/sessions.ts";

async function run(args: string[]): Promise<{ code: number; err: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "spf-sessions-limit-"));
  const tracer = await Tracer.open(join(dir, ".spf", "data", "spf.db"), join(dir, ".spf", "data", "sessions", "adw_1", "events.jsonl"));
  await tracer.sessionStart("adw_1", "tester", "plan");
  await tracer.close();
  const err: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  console.log = () => {};
  try {
    const code = await sessionsCommand(["--cwd", dir, ...args]);
    return { code, err };
  } finally {
    console.error = origErr;
    console.log = origLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const bad of ["abc", "-3", "0", "2abc", "1.5"]) {
  test(`sessions --limit ${bad} is rejected`, async () => {
    const { code, err } = await run(["--limit", bad]);
    assert.equal(code, 1);
    assert.equal(err.length, 1);
    assert.ok(err[0]!.includes(`"${bad}"`));
    assert.ok(err[0]!.includes("positive integer"));
  });
}

test("sessions --limit 2 works", async () => {
  const { code, err } = await run(["--limit", "2"]);
  assert.equal(code, 0);
  assert.equal(err.length, 0);
});
