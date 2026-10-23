/** The package `exports` map (#214): the receipts subpath resolves by self-reference, and deep dist imports still work. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A string-typed specifier, so `tsc` (which CI runs before any build) does not try to resolve the
// package's own dist/ — the self-reference is only resolvable at runtime, after build:cli.
const selfImport = (specifier: string): Promise<any> => import(specifier);

test("@gr8ful/spf/receipts self-imports and exposes the embedding surface, not the JWT verify", async () => {
  const mod = await selfImport("@gr8ful/spf/receipts");
  for (const name of ["receiptRoutes", "R2ReceiptReader", "selectRun", "viewerAssetPath", "stripBase", "injectShell", "shellCsp", "chromeFromVars", "accessConfig", "TEAM_DOMAIN"]) {
    assert.ok(name in mod, name);
  }
  assert.ok(!("verifyAccessJwt" in mod));
  assert.equal(mod.stripBase("/spf/r/x", "/spf"), "/r/x");
});

test("@gr8ful/spf/dashboard self-imports the route table and the hosted reader, node-free", async () => {
  const mod = await selfImport("@gr8ful/spf/dashboard");
  for (const name of ["createApp", "D1TraceReader", "AmbiguousSession"]) assert.ok(name in mod, name);
  const src = readFileSync(new URL("../ui/server/app.js", import.meta.url), "utf8") + readFileSync(new URL("../ui/server/trace_reader_d1.js", import.meta.url), "utf8");
  assert.ok(!/from "node:/.test(src), "compiled app and trace_reader_d1 must stay node-free");
});

test("deep dist imports and package.json stay reachable", async () => {
  const core = await selfImport("@gr8ful/spf/dist/core/data_types.js");
  assert.ok("SFConfigSchema" in core);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@gr8ful/spf");
});
