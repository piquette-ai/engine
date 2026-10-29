/** `piquette cloud access-plan` (#214): pure config -> text, no network call, nothing created. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as v from "valibot";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { accessPlan, computeAccessPlan, type AccessPlan } from "../cloud/access_plan.js";

const ACCESS = { team_domain: "test-team.cloudflareaccess.com", aud: ["aud-reader-0001"] };
const cfgOf = (cloud: Record<string, unknown> = {}): SFConfig => v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", hostname: "piquette.example.com", modules: ["receipts"], access: ACCESS, ...cloud } });

function run(cfg: SFConfig, extra: Partial<Parameters<typeof accessPlan>[1]> = {}): { code: number; out: string[]; json?: AccessPlan } {
  const out: string[] = [];
  const code = accessPlan(cfg, { out: (l) => out.push(l), ...extra });
  const json = extra.json ? (JSON.parse(out[0]!) as AccessPlan) : undefined;
  return { code, out, json };
}

test("no cloud: block is exit 2 and prints the same message as status/deploy", () => {
  const { code, out } = run(v.parse(SFConfigSchema, {}));
  assert.equal(code, 2);
  assert.deepEqual(out, ["no cloud: block in any config layer"]);
});

test("receipts + ingest: two apps, right domain/path/policy type, and the reminder to wire the AUD back in", () => {
  const { code, json } = run(cfgOf({ modules: ["receipts", "ingest"], d1: { database: "piquette-hub" } }), { json: true });
  assert.equal(code, 0);
  assert.equal(json!.warnings.length, 0);
  assert.equal(json!.apps.length, 2);
  const [reader, ingest] = json!.apps;
  assert.equal(reader!.purpose, "reader");
  assert.equal(reader!.domain, "piquette.example.com");
  assert.equal(reader!.path, "/*");
  assert.equal(reader!.policy_type, "identity");
  assert.match(reader!.after_creating, /cloud\.access\.aud/);
  assert.equal(ingest!.purpose, "ingest");
  assert.equal(ingest!.path, "/ingest*");
  assert.equal(ingest!.policy_type, "service_auth");
  assert.match(ingest!.policy, /Any valid Service Token/);
  assert.match(ingest!.policy, /factory_credentials/);
});

test("mounted under a path: both app paths carry the base, ingest nested under it", () => {
  const plan = computeAccessPlan(cfgOf({ modules: ["receipts", "ingest"], base_path: "/piquette", d1: { database: "piquette-hub" } }).cloud!);
  assert.equal(plan.apps[0]!.path, "/piquette/*");
  assert.equal(plan.apps[1]!.path, "/piquette/ingest*");
});

test("reader policy is drawn from cloud.tenants[].readers, deduped and sorted across tenants", () => {
  const plan = computeAccessPlan(
    cfgOf({
      modules: ["dashboard"],
      d1: { database: "piquette-hub" },
      tenants: [
        { id: "b", readers: { emails: ["z@example.com"], email_domains: ["example.com"] } },
        { id: "a", readers: { emails: ["z@example.com", "a@example.com"] } },
      ],
    }).cloud!,
  );
  assert.equal(plan.apps.length, 1);
  assert.match(plan.apps[0]!.policy, /email domain in \{example\.com\}/);
  assert.match(plan.apps[0]!.policy, /email in \{a@example\.com, z@example\.com\}/);
});

test("no tenants configured yet: generic guidance, not an error", () => {
  const plan = computeAccessPlan(cfgOf().cloud!); // receipts only, no dashboard -> tenants optional and unset
  assert.equal(plan.apps.length, 1);
  assert.match(plan.apps[0]!.policy, /No cloud\.tenants\[\]\.readers are configured/);
});

test("ingest module alone (no receipts/dashboard): only the ingest app", () => {
  const plan = computeAccessPlan(cfgOf({ modules: ["ingest"], d1: { database: "piquette-hub" } }).cloud!);
  assert.equal(plan.apps.length, 1);
  assert.equal(plan.apps[0]!.purpose, "ingest");
});

test("no hostname, route or public_url resolvable: one warning, no apps, still exit 0", () => {
  const { code, json } = run(v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", modules: ["receipts"], access: ACCESS } }), { json: true });
  assert.equal(code, 0);
  assert.equal(json!.apps.length, 0);
  assert.match(json!.warnings[0]!, /set cloud\.hostname/);
});

test("workers.dev public_url: a warning, but the apps are still printed", () => {
  // No hostname/route set, so workers_dev resolves true by default; public_url is the only way to a URL here.
  const plan = computeAccessPlan(v.parse(SFConfigSchema, { cloud: { provider: "cloudflare", modules: ["receipts"], access: ACCESS, public_url: "https://piquette.myaccount.workers.dev" } }).cloud!);
  assert.equal(plan.apps.length, 1);
  assert.match(plan.warnings[0]!, /workers\.dev subdomain/);
});

test("a repo-layer cloud block gets a non-blocking note, not a refusal", () => {
  const { code, out } = run(cfgOf(), { origins: { cloud: "repo", cloudPath: ".piquette/piquette.config.yaml" } });
  assert.equal(code, 0);
  assert.match(out[0]!, /repo layer/);
  assert.ok(out.some((l) => l.includes("Reader application")));
});

test("text mode never calls fetch and creates nothing: just printed lines ending in the no-op reminder", () => {
  const { out } = run(cfgOf({ modules: ["receipts", "ingest"], d1: { database: "piquette-hub" } }));
  assert.ok(out.some((l) => l.includes("Nothing was created")));
});

test("--json with a repo-layer origin is still exactly one JSON value: the repo note folds into warnings, not an out-of-band line", () => {
  const { out, json } = run(cfgOf(), { json: true, origins: { cloud: "repo", cloudPath: ".piquette/piquette.config.yaml" } });
  assert.equal(out.length, 1, "exactly one line of output: the JSON itself");
  assert.match(json!.warnings[0]!, /repo layer/);
});
