import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const bin = path.resolve(import.meta.dirname, "..", "bin.js");
function run(args: string[]) {
  const cwd = mkdtempSync(path.join(tmpdir(), "spf-ver-"));
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
}

test("version --json prints one JSON line", () => {
  const r = run(["version", "--json"]);
  assert.equal(r.status, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 1);
  const j = JSON.parse(lines[0]!);
  assert.equal(j.name, "@gr8ful/spf");
  assert.match(j.version, /^\d+\.\d+\.\d+/);
});

test("version without flag is unchanged", () => {
  const r = run(["version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^@gr8ful\/spf \d+\.\d+\.\d+/);
});

test("version --jsno is rejected and suggests --json", () => {
  const r = run(["version", "--jsno"]);
  assert.notEqual(r.status, 0);
  const lines = r.stderr.trimEnd().split("\n");
  assert.ok(lines.length <= 3);
  assert.match(lines[0]!, /--jsno/);
  assert.match(r.stderr, /--json/);
});

test("version --zzzzzzzz is rejected without a suggestion", () => {
  const r = run(["version", "--zzzzzzzz"]);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /did you mean/);
});

test("version accepts global --cwd value", () => {
  const r = run(["version", "--cwd", tmpdir()]);
  assert.equal(r.status, 0);
});
