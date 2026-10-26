/** The route contract against the real local app (`piquette ui` over a tracer-written piquette.db). */
import "./hermetic_git.js";
import { after, before } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tracer } from "../core/tracer.js";
import { makeEventRecord } from "../core/data_types.js";
import { runUi, type UiHandle } from "../ui/server/serve.js";
import { LocalReceiptReader } from "../ui/server/receipt_reader_node.js";
import { runObjects, writeLocal } from "./receipt_fixture.js";
import { runRouteContract } from "./route_contract_suite.js";

const ADW = "contract-1";
let dir: string;
let handle: UiHandle;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "piquette-route-contract-"));
  const dbPath = join(dir, "piquette.db");
  const tracer = await Tracer.open(dbPath, join(dir, "sessions", ADW, "events.jsonl"));
  await tracer.sessionStart(ADW, "tester", "quality");
  const phase = {
    phase_id: `${ADW}_01_plan`,
    adw_id: ADW,
    seq: 1,
    params: { name: "plan", kind: "agent" as const, owner: "planner", description: "plan it", retries: 0 },
    status: "success" as const,
    attempt: 0,
    error: null,
    started_at: null,
    ended_at: null,
  };
  await tracer.phaseUpsert(phase);
  await tracer.event(makeEventRecord({ adw_id: ADW, phase_id: phase.phase_id, type: "log", name: "request", payload: { input: "seed" } }));
  await tracer.sessionLinks(ADW, { issue: { label: "BT-1221", url: "https://acme.atlassian.net/browse/BT-1221" }, pr: { label: "#217", url: "https://github.com/acme/api/pull/217" } });
  await tracer.sessionFinish(ADW, true);
  await tracer.close();
  const prompts = join(dir, "sessions", ADW, "planner", "prompts");
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, "system.md"), "SYSTEM");
  writeFileSync(join(prompts, "user.md"), "USER");
  const store = join(dir, "receipts");
  writeLocal(store, runObjects("repo-a", "dup-run"));
  writeLocal(store, runObjects("repo-b", "dup-run"));
  handle = await runUi({
    db: { kind: "sqlite", path: dbPath },
    sessionsDir: join(dir, "sessions"),
    webDir: join(import.meta.dirname, "..", "..", "web"),
    port: 0,
    open: false,
    receipts: new LocalReceiptReader(store),
  });
});
after(async () => {
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

runRouteContract((path, init) => fetch(handle.url + path, init), {
  adwId: ADW,
  agent: "planner",
  hosted: false,
  expectPrompts: true,
  conflictRun: "dup-run",
  links: { issue_label: "BT-1221", issue_url: "https://acme.atlassian.net/browse/BT-1221", pr_label: "#217", pr_url: "https://github.com/acme/api/pull/217" },
});
