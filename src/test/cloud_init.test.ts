/**
 * `piquette cloud init` (#214): the pure answers -> config pipeline
 * (`cloud/init.ts`) and the CLI's non-interactive path. The interview itself
 * is covered against a scripted fake `Asker` in `interview_cloud.test.ts`.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { AUD_PLACEHOLDER, buildCloudBlock, mergeMachineConfig, validateMerged, type CloudInitAnswers } from "../cloud/init.js";
import { cloudInitCommand } from "../cli/commands/cloud_init.js";

const BASE: CloudInitAnswers = {
  name: "piquette",
  hostname: "piquette.example.com",
  teamDomain: "example.cloudflareaccess.com",
  modules: ["receipts", "ingest", "dashboard"],
  bucket: "piquette-receipts",
  d1: "piquette-hub",
  tenant: "default",
  readerEmails: [],
  readerDomains: ["example.com"],
  sync: true,
};

test("buildCloudBlock: every field lands, aud is the placeholder, tenant only appears for dashboard", () => {
  const block = buildCloudBlock(BASE) as any;
  assert.equal(block.provider, "cloudflare");
  assert.equal(block.hostname, "piquette.example.com");
  assert.deepEqual(block.modules, ["receipts", "ingest", "dashboard"]);
  assert.deepEqual(block.access, { team_domain: "example.cloudflareaccess.com", aud: [AUD_PLACEHOLDER] });
  assert.deepEqual(block.r2, { bucket: "piquette-receipts" });
  assert.deepEqual(block.d1, { database: "piquette-hub" });
  assert.deepEqual(block.tenants, [{ id: "default", readers: { email_domains: ["example.com"] } }]);
});

test("buildCloudBlock: no dashboard means no tenants block, even with reader fields set", () => {
  const block = buildCloudBlock({ ...BASE, modules: ["receipts"], tenant: undefined }) as any;
  assert.equal(block.tenants, undefined);
  assert.equal(block.d1, undefined); // no ingest/dashboard -> no d1 either
});

test("buildCloudBlock: route mode carries route+zone, no hostname, no base_path prompt artifact", () => {
  const block = buildCloudBlock({ ...BASE, hostname: undefined, route: "example.com/piquette*", zone: "example.com" }) as any;
  assert.equal(block.hostname, undefined);
  assert.equal(block.route, "example.com/piquette*");
  assert.equal(block.zone, "example.com");
});

test("mergeMachineConfig: unrelated top-level keys survive; sync is added only when wanted, never removed when not", () => {
  const existing = { notifications: { events: "attention" }, sync: { on_watch: false } };
  const withSync = mergeMachineConfig(existing, { provider: "cloudflare" }, true);
  assert.deepEqual(withSync.notifications, { events: "attention" });
  assert.deepEqual(withSync.sync, { on_watch: false }); // preserved, not clobbered to {}

  const withoutSyncWanted = mergeMachineConfig(existing, { provider: "cloudflare" }, false);
  assert.deepEqual(withoutSyncWanted.sync, { on_watch: false }); // "don't turn on" leaves what's there alone

  const freshWantsSync = mergeMachineConfig({}, { provider: "cloudflare" }, true);
  assert.deepEqual(freshWantsSync.sync, {});
  const freshNoSync = mergeMachineConfig({}, { provider: "cloudflare" }, false);
  assert.equal("sync" in freshNoSync, false);
});

test("validateMerged: a valid block parses to a usable SFConfig; an invalid one reports a readable message and nothing else", () => {
  const good = validateMerged({ cloud: buildCloudBlock(BASE) });
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.cfg.cloud?.hostname, "piquette.example.com");

  const bad = validateMerged({ cloud: buildCloudBlock({ ...BASE, hostname: "not a host!!" }) });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.message, /hostname/);
});

test("validateMerged: dashboard with no tenants is refused by schema (the real gate, not just the interview's own checks)", () => {
  const block = buildCloudBlock({ ...BASE, modules: ["dashboard"], tenant: undefined });
  const result = validateMerged({ cloud: block });
  assert.equal(result.ok, false);
});

// ── CLI non-interactive path ──────────────────────────────────────────────

let home: string;
let configPath: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "piquette-cloud-init-test-"));
  configPath = join(home, "piquette.config.yaml");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args: string[]): Promise<number> {
  return cloudInitCommand(["--config", configPath, "--yes", ...args]);
}

test("writes a valid file from flags, chains into access-plan output, and the placeholder warning appears", async () => {
  const code = await run(["--hostname", "piquette.example.com", "--team-domain", "example.cloudflareaccess.com", "--reader-domain", "example.com"]);
  assert.equal(code, 0);
  assert.ok(existsSync(configPath));
  const written = parse(readFileSync(configPath, "utf-8"));
  assert.equal(written.cloud.hostname, "piquette.example.com");
  assert.deepEqual(written.cloud.access.aud, [AUD_PLACEHOLDER]);
  assert.deepEqual(written.sync, {}); // ingest+dashboard enabled by default -> sync defaults on
});

test("--modules receipts: no d1, no tenants, no sync by default", async () => {
  const code = await run(["--hostname", "piquette.example.com", "--team-domain", "example.cloudflareaccess.com", "--modules", "receipts"]);
  assert.equal(code, 0);
  const written = parse(readFileSync(configPath, "utf-8"));
  assert.equal(written.cloud.d1, undefined);
  assert.equal(written.cloud.tenants, undefined);
  assert.equal(written.sync, undefined);
});

test("missing --hostname and --route is a clean error, nothing written", async () => {
  const code = await cloudInitCommand(["--config", configPath, "--yes", "--team-domain", "example.cloudflareaccess.com"]);
  assert.equal(code, 1);
  assert.equal(existsSync(configPath), false);
});

test("an unknown module name is refused before anything is written", async () => {
  const code = await run(["--hostname", "piquette.example.com", "--team-domain", "example.cloudflareaccess.com", "--modules", "receipts,bogus"]);
  assert.equal(code, 1);
  assert.equal(existsSync(configPath), false);
});

test("re-running without --force leaves an existing cloud: block alone, exit 0", async () => {
  await run(["--hostname", "a.example.com", "--team-domain", "example.cloudflareaccess.com"]);
  const before = readFileSync(configPath, "utf-8");
  const code = await run(["--hostname", "b.example.com", "--team-domain", "example.cloudflareaccess.com"]);
  assert.equal(code, 0);
  assert.equal(readFileSync(configPath, "utf-8"), before);
});

test("--force overwrites the cloud: block but preserves unrelated top-level keys already in the file", async () => {
  await run(["--hostname", "a.example.com", "--team-domain", "example.cloudflareaccess.com"]);
  const existing = parse(readFileSync(configPath, "utf-8"));
  existing.notifications = { events: "attention" };
  const { writeFileSync } = await import("node:fs");
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(existing));

  const code = await run(["--hostname", "b.example.com", "--team-domain", "example.cloudflareaccess.com", "--force"]);
  assert.equal(code, 0);
  const written = parse(readFileSync(configPath, "utf-8"));
  assert.equal(written.cloud.hostname, "b.example.com");
  assert.deepEqual(written.notifications, { events: "attention" });
});

test("--skip-access-plan prints the placeholder warning itself instead of relying on access-plan's", async () => {
  const out: string[] = [];
  const origLog = console.log;
  console.log = (line: string) => out.push(line);
  try {
    await run(["--hostname", "piquette.example.com", "--team-domain", "example.cloudflareaccess.com", "--skip-access-plan"]);
  } finally {
    console.log = origLog;
  }
  assert.ok(out.some((l) => l.includes("placeholder")));
  assert.ok(!out.some((l) => l.includes("Reader application")));
});

// ── --add-tenant: a second (third, ...) tenant without hand-editing the YAML ──

test("--add-tenant appends to an existing cloud.tenants, preserving the first tenant and every unrelated top-level key", async () => {
  await run(["--hostname", "a.example.com", "--team-domain", "example.cloudflareaccess.com", "--modules", "receipts,ingest,dashboard", "--tenant", "default", "--reader-domain", "example.com"]);
  const code = await cloudInitCommand(["--config", configPath, "--add-tenant", "--tenant", "acme-client", "--reader-email", "person@acme-client.com"]);
  assert.equal(code, 0);
  const written = parse(readFileSync(configPath, "utf-8"));
  assert.deepEqual(written.cloud.tenants, [
    { id: "default", readers: { email_domains: ["example.com"] } },
    { id: "acme-client", readers: { emails: ["person@acme-client.com"] } },
  ]);
  assert.equal(written.cloud.hostname, "a.example.com"); // untouched by --add-tenant
  assert.deepEqual(written.sync, {}); // the first run's sync: {} survives
});

test("--add-tenant with no cloud: block yet is a clean error pointing at plain cloud init, nothing written", async () => {
  const code = await cloudInitCommand(["--config", configPath, "--add-tenant", "--tenant", "acme-client", "--reader-domain", "acme-client.com"]);
  assert.equal(code, 1);
  assert.equal(existsSync(configPath), false);
});

test("--add-tenant: missing --tenant, or neither --reader-email nor --reader-domain, is refused before anything is written", async () => {
  await run(["--hostname", "a.example.com", "--team-domain", "example.cloudflareaccess.com"]);
  const before = readFileSync(configPath, "utf-8");
  let code = await cloudInitCommand(["--config", configPath, "--add-tenant", "--reader-domain", "acme-client.com"]);
  assert.equal(code, 1);
  code = await cloudInitCommand(["--config", configPath, "--add-tenant", "--tenant", "acme-client"]);
  assert.equal(code, 1);
  assert.equal(readFileSync(configPath, "utf-8"), before);
});

test("--add-tenant: a duplicate id is refused without --force, and --force replaces readers in place rather than appending a duplicate", async () => {
  await run(["--hostname", "a.example.com", "--team-domain", "example.cloudflareaccess.com", "--tenant", "default", "--reader-domain", "example.com"]);
  let code = await cloudInitCommand(["--config", configPath, "--add-tenant", "--tenant", "default", "--reader-domain", "other.com"]);
  assert.equal(code, 1);
  code = await cloudInitCommand(["--config", configPath, "--add-tenant", "--tenant", "default", "--reader-domain", "other.com", "--force"]);
  assert.equal(code, 0);
  const written = parse(readFileSync(configPath, "utf-8"));
  assert.deepEqual(written.cloud.tenants, [{ id: "default", readers: { email_domains: ["other.com"] } }]);
});

test("--add-tenant chains into access-plan by default, showing the WIDENED reader policy across both tenants", async () => {
  await run(["--hostname", "a.example.com", "--team-domain", "example.cloudflareaccess.com", "--tenant", "default", "--reader-domain", "example.com"]);
  const out: string[] = [];
  const origLog = console.log;
  console.log = (line: string) => out.push(line);
  try {
    await cloudInitCommand(["--config", configPath, "--add-tenant", "--tenant", "acme-client", "--reader-email", "person@acme-client.com"]);
  } finally {
    console.log = origLog;
  }
  const joined = out.join("\n");
  assert.match(joined, /email domain in \{example\.com\}.*email in \{person@acme-client\.com\}/);
  assert.match(joined, /next: piquette cloud deploy.*provision-factory --tenant acme-client/s);
});
