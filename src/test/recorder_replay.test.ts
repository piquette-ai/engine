/**
 * `core/recorder.ts` without a browser (#238): the video is built from the
 * captured run. The plan keeps the original timing (idle gaps capped) and
 * the real exit code, and the program ttyd runs prints that plan and runs
 * nothing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_IDLE_MS, MAX_REPLAY_CHARS, REPLAY_SCRIPT, replayEnv, replayPlan, stepHeader, type ReplayPlan } from "../core/recorder.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("replayPlan keeps each chunk at its original offset, caps idle gaps, and ends with the real exit code and duration", () => {
  const plan = replayPlan(
    [
      { command: "npm run build", transcript: [{ t: 120, text: "building…\n" }, { t: 40_120, text: "built" }], exit: 0, ms: 40_500 },
      { command: "piquette nope", transcript: [], exit: 2, ms: 80 },
    ],
    "proof run-1#1",
  );
  assert.equal(plan.title, "proof run-1#1");
  const [build, nope] = plan.steps;
  assert.equal(build.header, "( npm run build )");
  assert.deepEqual(build.writes.slice(0, 2), [
    { delay_ms: 120, text: "building…\n" },
    { delay_ms: MAX_IDLE_MS, text: "built" },
  ]);
  assert.equal(build.footer, "[step 1/2 · exit 0 · 40.5s]");
  assert.equal(strip(build.writes[2].text), "\n[step 1/2 · exit 0 · 40.5s]\n", "output without a trailing newline gets one before the footer");
  assert.equal(build.play_ms, 120 + MAX_IDLE_MS + 380);
  assert.equal(nope.footer, "[step 2/2 · exit 2 · 0.1s]");
  assert.equal(strip(nope.writes[0].text), "[step 2/2 · exit 2 · 0.1s]\n");
});

test("replayPlan plays only the last MAX_REPLAY_CHARS of a huge output and says what it cut", () => {
  const line = "x".repeat(999) + "\n";
  const transcript = Array.from({ length: 300 }, (_, i) => ({ t: i, text: line }));
  const [step] = replayPlan([{ command: "yes", transcript, exit: 0, ms: 300 }]).steps;
  const played = step.writes.slice(1, -1).map((w) => w.text).join("");
  assert.ok(played.length <= MAX_REPLAY_CHARS);
  assert.equal(played.length, 200 * 1000);
  assert.match(step.writes[0].text, /\[… 100000 earlier characters of output not replayed\]/);
});

function replay(plan: ReplayPlan, enters: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "piquette-replay-"));
  writeFileSync(join(dir, "replay.cjs"), REPLAY_SCRIPT);
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, "replay.cjs"), join(dir, "plan.json")], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      code === 0 ? resolve(out) : reject(new Error(`replay exited ${code}: ${out}`));
    });
    child.stdin.end("\n".repeat(enters));
  });
}

test("the replay program prints the plan — prompt, command, output, footer — and never runs the command", async () => {
  const marker = join(tmpdir(), `piquette-replay-must-not-exist-${process.pid}`);
  const plan = replayPlan(
    [
      { command: `touch ${marker}`, transcript: [{ t: 5, text: "made it\n" }], exit: 0, ms: 10 },
      { command: "echo two; exit 3", transcript: [{ t: 1, text: "two\n" }], exit: 3, ms: 2 },
    ],
    "proof demo",
  );
  const out = strip(await replay(plan, 2));
  assert.equal(
    out,
    [
      "piquette-proof $ # proof demo",
      `piquette-proof $ ${stepHeader(`touch ${marker}`)}`,
      "made it",
      "[step 1/2 · exit 0 · 0.0s]",
      "piquette-proof $ ( echo two; exit 3 )",
      "two",
      "[step 2/2 · exit 3 · 0.0s]",
      "piquette-proof $ ",
    ].join("\n"),
  );
  assert.equal(existsSync(marker), false, "the journey command was shown, not run");
});

test("the replay waits for Enter before playing each step, so the recorder can read the command back first", async () => {
  const plan = replayPlan([{ command: "a", transcript: [{ t: 0, text: "A-output\n" }], exit: 0, ms: 1 }]);
  const dir = mkdtempSync(join(tmpdir(), "piquette-replay-"));
  writeFileSync(join(dir, "replay.cjs"), REPLAY_SCRIPT);
  writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
  const child = spawn(process.execPath, [join(dir, "replay.cjs"), join(dir, "plan.json")], { stdio: ["pipe", "pipe", "inherit"] });
  try {
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    };
    await until(() => out.includes("( a )"));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(out.includes("( a )") && !out.includes("A-output"), `no output before Enter: ${JSON.stringify(out)}`);
    child.stdin.write("\n");
    await until(() => out.includes("[step 1/1"));
    assert.match(strip(out), /\( a \)\nA-output\n\[step 1\/1 · exit 0/);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(child.exitCode, null, "it stays open after the plan (an exiting program would close the terminal)");
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the terminal replay env never carries PIQUETTE_EVIDENCE_DIR (#235)", () => {
  const env = replayEnv({ PATH: "/bin", PIQUETTE_EVIDENCE_DIR: "/tmp/ev", HOME: "/h" });
  assert.equal("PIQUETTE_EVIDENCE_DIR" in env, false);
  assert.equal(env.PATH, "/bin");
  const prev = process.env.PIQUETTE_EVIDENCE_DIR;
  process.env.PIQUETTE_EVIDENCE_DIR = "/tmp/outer";
  try {
    assert.equal("PIQUETTE_EVIDENCE_DIR" in replayEnv(), false);
  } finally {
    if (prev === undefined) delete process.env.PIQUETTE_EVIDENCE_DIR;
    else process.env.PIQUETTE_EVIDENCE_DIR = prev;
  }
});
