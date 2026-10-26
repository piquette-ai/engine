import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Import this in any test file that builds its config through
 * `paths.resolveConfigPaths` / `agents.loadConfig` against a scratch repo.
 *
 * `resolveConfigPaths` layers the MACHINE config (`$PIQUETTE_CONFIG_HOME/
 * piquette.config.yaml`, default `~/.piquette/piquette.config.yaml`) under the repo's own.
 * On a developer machine that file is real: it can turn on hosted sync, an S3
 * receipts store, or decision-layer model calls, none of which a scratch-repo
 * test asked for. The result is a test whose behaviour depends on the
 * machine's config and on whatever network service that config points at.
 *
 * Pointing `PIQUETTE_CONFIG_HOME` at a fresh, empty directory at module load makes
 * the machine layer absent for the whole file (each test file is its own
 * `node --test` process). Tests that exercise the layer itself pass their own
 * `env`/`home` to the resolver and are unaffected.
 */
export const HERMETIC_PIQUETTE_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), "piquette-test-config-home-"));
process.env["PIQUETTE_CONFIG_HOME"] = HERMETIC_PIQUETTE_CONFIG_HOME;
