// Writes assets/sync/payload.v1.schema.json from the compiled contract
// (dist/core/sync/contract.js) — run `npm run build:cli` first. A test fails
// when the committed file drifts from the contract.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toJsonSchema } from "@valibot/to-json-schema";
import { SyncBatchSchema } from "../dist/core/sync/contract.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "assets", "sync", "payload.v1.schema.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(toJsonSchema(SyncBatchSchema)) + "\n");
console.log(`wrote ${path.relative(root, out)}`);
