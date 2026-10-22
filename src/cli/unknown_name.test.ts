import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closestNames, unknownNameMessage } from "./unknown_name.ts";

test("closestNames suggests near names only", () => {
  assert.deepEqual(closestNames("bild", ["build", "scout", "review"]), ["build"]);
  assert.deepEqual(closestNames("no-such-chain-xyz", ["build", "scout"]), []);
});

test("unknownNameMessage is short and names the input", () => {
  const m = unknownNameMessage("chain", "zzz", ["build"]).split("\n");
  assert.ok(m.length <= 3);
  assert.match(m[0]!, /unknown chain: zzz/);
  assert.match(m.at(-1)!, /spf list/);
});

const bin = path.resolve(import.meta.dirname, "bin.js");
function run(args: string[]) {
  const cwd = mkdtempSync(path.join(tmpdir(), "spf-unk-"));
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
}

test("cli: unknown chain gives a short error and non-zero exit", () => {
  const r = run(["no-such-chain-xyz", "probe"]);
  const out = (r.stdout + r.stderr).trimEnd().split("\n");
  assert.notEqual(r.status, 0);
  assert.ok(out.length <= 10, out.join("\n"));
  assert.match(out[0]!, /unknown.*no-such-chain-xyz/);
  assert.match(out.join("\n"), /spf list/);
});

test("cli: --help still prints full usage", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /spf list/);
  assert.match(r.stdout, /spf doctor/);
});
