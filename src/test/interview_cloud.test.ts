/**
 * `piquette cloud init`'s interview (`cli/interview_cloud.ts`) — driven through
 * the `Asker` seam with the same scripted fake `cli/init`'s own interview
 * test uses, never a real TTY.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runCloudInitInterview } from "../cli/interview_cloud.js";
import { createFakeAsker } from "./fake_asker.js";

test("hostname path: full answers, including bucket/d1/tenant/readers/sync, when every confirm defaults yes", async () => {
  const asker = createFakeAsker({
    text: {
      "Worker name": "piquette",
      Hostname: "piquette.example.com",
      "Access team domain": "example.cloudflareaccess.com",
      "email domain": "example.com, Example.COM", // dedup/lowercase is buildCloudBlock's job, not the interview's — raw split/trim/lowercase only
      "email(s)": "a@example.com",
      "Tenant id": "default",
    },
    confirm: { "Mount via a Workers route": false, "Enable receipts": true, "Enable ingest": true, "Enable dashboard": true, "Turn on piquette sync": true },
  });
  const answers = await runCloudInitInterview(asker);
  assert.equal(answers.hostname, "piquette.example.com");
  assert.equal(answers.route, undefined);
  assert.deepEqual(answers.modules, ["receipts", "ingest", "dashboard"]);
  assert.equal(answers.bucket, "piquette-receipts"); // default kept (no "R2 bucket" key scripted)
  assert.equal(answers.d1, "piquette-hub");
  assert.equal(answers.tenant, "default");
  assert.deepEqual(answers.readerDomains, ["example.com", "example.com"]); // lowercased, not yet deduped
  assert.deepEqual(answers.readerEmails, ["a@example.com"]);
  assert.equal(answers.sync, true);
});

test("declining every module still returns an empty, well-typed modules list (buildCloudBlock then has nothing to add)", async () => {
  const asker = createFakeAsker({
    text: { "Worker name": "piquette", Hostname: "piquette.example.com", "Access team domain": "example.cloudflareaccess.com" },
    confirm: { "Mount via a Workers route": false, "Enable receipts": false, "Enable ingest": false, "Enable dashboard": false },
  });
  const answers = await runCloudInitInterview(asker);
  assert.deepEqual(answers.modules, []);
  assert.equal(answers.bucket, undefined);
  assert.equal(answers.d1, undefined);
  assert.equal(answers.tenant, undefined);
  assert.equal(answers.sync, false); // no ingest/dashboard -> never asked, defaults off
});

test("route path: route+zone collected, hostname and base_path never asked", async () => {
  const asker = createFakeAsker({
    text: { "Worker name": "piquette", "Workers route": "example.com/piquette*", Zone: "example.com", "Access team domain": "example.cloudflareaccess.com" },
    confirm: { "Mount via a Workers route": true, "Enable receipts": true, "Enable ingest": false, "Enable dashboard": false },
  });
  const answers = await runCloudInitInterview(asker);
  assert.equal(answers.hostname, undefined);
  assert.equal(answers.route, "example.com/piquette*");
  assert.equal(answers.zone, "example.com");
  assert.equal(answers.basePath, undefined);
});

test("dashboard off: tenant and reader prompts are never asked, even if receipts is on", async () => {
  const asker = createFakeAsker({
    text: { "Worker name": "piquette", Hostname: "piquette.example.com", "Access team domain": "example.cloudflareaccess.com" },
    confirm: { "Mount via a Workers route": false, "Enable receipts": true, "Enable ingest": true, "Enable dashboard": false, "Turn on piquette sync": false },
  });
  const answers = await runCloudInitInterview(asker);
  assert.equal(answers.tenant, undefined);
  assert.deepEqual(answers.readerEmails, []);
  assert.deepEqual(answers.readerDomains, []);
});
