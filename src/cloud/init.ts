/**
 * `piquette cloud init` (#214): pure answers -> config logic. Writes the
 * cloud:/sync: block into the MACHINE-layer file, never a repo's own
 * `.piquette/` — a cloned repo must not be able to steer where a deploy goes
 * or whose credentials get used, the same invariant `deploy` and
 * `provision-factory` already keep. No fs, no Asker, no CLI here: the
 * interview lives in `cli/interview_cloud.ts`, the file I/O and argv parsing
 * in `cli/commands/cloud_init.ts`.
 */
import * as v from "valibot";
import { describeParseError } from "../core/agents.ts";
import { CLOUD_MODULES, SFConfigSchema, type CloudModule, type SFConfig } from "../core/data_types.ts";

/**
 * A syntactically valid but obviously fake AUD. `cloud.access.aud` is
 * required (the schema refuses an empty list) but the real value does not
 * exist until the Access applications are created — a chicken-and-egg this
 * placeholder resolves safely: the Worker fails CLOSED on every request
 * (`ACCESS_AUD` matches nothing real) until it is replaced, never open.
 * `access_plan.ts` warns when it is still present.
 */
export const AUD_PLACEHOLDER = "REPLACE_WITH_YOUR_ACCESS_APP_AUD";

export interface CloudInitAnswers {
  name: string;
  hostname?: string;
  route?: string;
  zone?: string;
  basePath?: string;
  teamDomain: string;
  modules: CloudModule[];
  bucket?: string;
  d1?: string;
  tenant?: string;
  readerEmails: string[];
  readerDomains: string[];
  /** Add (or keep) a `sync: {}` block in the same file, turning on `piquette sync` for every repo on this machine. */
  sync: boolean;
}

/** Pure: answers -> the `cloud:` block, plain JS and YAML-serializable. Not yet schema-validated — `validateMerged` is the gate before anything is written. */
export function buildCloudBlock(a: CloudInitAnswers): Record<string, unknown> {
  const wantsD1 = a.modules.includes("ingest") || a.modules.includes("dashboard");
  const wantsReceipts = a.modules.includes("receipts");
  const wantsDashboard = a.modules.includes("dashboard");
  return {
    provider: "cloudflare",
    name: a.name,
    ...(a.hostname ? { hostname: a.hostname } : {}),
    ...(a.route ? { route: a.route, zone: a.zone } : {}),
    ...(a.basePath ? { base_path: a.basePath } : {}),
    modules: a.modules,
    access: { team_domain: a.teamDomain, aud: [AUD_PLACEHOLDER] },
    ...(wantsReceipts && a.bucket ? { r2: { bucket: a.bucket } } : {}),
    ...(wantsD1 && a.d1 ? { d1: { database: a.d1 } } : {}),
    ...(wantsDashboard && a.tenant
      ? {
          tenants: [
            {
              id: a.tenant,
              readers: {
                ...(a.readerEmails.length ? { emails: a.readerEmails } : {}),
                ...(a.readerDomains.length ? { email_domains: a.readerDomains } : {}),
              },
            },
          ],
        }
      : {}),
  };
}

/** Merge into whatever the machine-layer file already holds: every OTHER top-level key (review, notifications, ...) survives untouched. `sync` gains an (empty if new) block only when `wantSync` is true, and is never removed when it is false — "don't turn it on" is not "turn it off". */
export function mergeMachineConfig(existing: Record<string, unknown>, cloudBlock: Record<string, unknown>, wantSync: boolean): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, cloud: cloudBlock };
  if (wantSync) {
    const prior = existing.sync;
    merged.sync = { ...(typeof prior === "object" && prior !== null ? (prior as Record<string, unknown>) : {}) };
  }
  return merged;
}

export type ValidateResult = { ok: true; cfg: SFConfig } | { ok: false; message: string };

/** The authoritative gate: nothing is written to disk unless the WHOLE merged document parses against the exact schema `piquette doctor` and every `piquette cloud` subcommand already load through. */
export function validateMerged(merged: Record<string, unknown>): ValidateResult {
  const result = v.safeParse(SFConfigSchema, merged);
  if (result.success) return { ok: true, cfg: result.output };
  return { ok: false, message: describeParseError(new v.ValiError(result.issues)) };
}

export { CLOUD_MODULES };
