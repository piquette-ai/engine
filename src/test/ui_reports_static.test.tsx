import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChainList, renderTable } from "../cli/ui/reports.js";

async function capture(fn: () => Promise<void>): Promise<string> {
  const real = process.stdout.write.bind(process.stdout);
  let buf = "";
  (process.stdout as { write: unknown }).write = (c: string) => ((buf += c), true);
  try {
    await fn();
  } finally {
    (process.stdout as { write: unknown }).write = real;
  }
  return buf;
}

// #183: output taller than the terminal must never emit a screen/scrollback clear.
test("renderChainList taller than the terminal never clears the screen or scrollback", async () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ name: `chain-${i}`, phases: "a -> b", describe: "d", agentsLine: "x" }));
  const out = await capture(() => renderChainList(entries, ["footer line"]));
  assert.ok(!out.includes("\x1b[2J"), "no clear-screen");
  assert.ok(!out.includes("\x1b[3J"), "no clear-scrollback");
  assert.ok(!out.includes("\x1b[H"), "no cursor-home repaint");
  assert.ok(out.includes("chain-0") && out.includes("chain-39") && out.includes("footer line"));
  assert.ok(out.endsWith("\n"));
});

test("renderTable writes every row exactly once", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => [`row${i}`, "v"]);
  const out = await capture(() => renderTable(rows));
  assert.ok(!out.includes("\x1b[2J") && !out.includes("\x1b[3J"));
  assert.equal(out.split("row7 ").length - 1, 1);
});
