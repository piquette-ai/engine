import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { pasteScript, replayEnv } from "../core/recorder.ts";

// The command reaches xterm through a JSON string literal inside eval'd page
// JS (#224): run the generated script against a fake term and check the exact
// text arrives.
function pasteThrough(text: string): { returned: unknown; pasted: string[] } {
  const pasted: string[] = [];
  const window = { term: { paste: (t: string) => pasted.push(t) } };
  const returned = vm.runInNewContext(pasteScript(text), { window });
  return { returned, pasted };
}

test("pasteScript delivers hard commands byte-for-byte", () => {
  const long = `node -e 'const a = "x \\"q\\""; console.log(\`n=\${1}\`, "$HOME", "café ✓")' ` + "pad-".repeat(90);
  for (const text of [long, "echo \"$FOO \\\\ back\\slash\" 'it'\"'\"'s'", "( a\nb )", "emoji \u{1F600}   end"]) {
    const { returned, pasted } = pasteThrough(text);
    assert.equal(returned, "pasted");
    assert.deepEqual(pasted, [text]);
  }
  assert.ok(long.length > 300);
});

test("pasteScript reports unavailable when the page has no term.paste", () => {
  assert.equal(vm.runInNewContext(pasteScript("x"), { window: {} }), "unavailable");
  assert.equal(vm.runInNewContext(pasteScript("x"), { window: { term: {} } }), "unavailable");
});

test("the terminal replay env never carries SPF_EVIDENCE_DIR (#235)", () => {
  const env = replayEnv({ PATH: "/bin", SPF_EVIDENCE_DIR: "/tmp/ev", HOME: "/h" });
  assert.equal("SPF_EVIDENCE_DIR" in env, false);
  assert.equal(env.PATH, "/bin");
  const prev = process.env.SPF_EVIDENCE_DIR;
  process.env.SPF_EVIDENCE_DIR = "/tmp/outer";
  try {
    assert.equal("SPF_EVIDENCE_DIR" in replayEnv(), false);
  } finally {
    if (prev === undefined) delete process.env.SPF_EVIDENCE_DIR;
    else process.env.SPF_EVIDENCE_DIR = prev;
  }
});
