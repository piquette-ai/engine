# Plan: validate `piquette sessions --limit` (issue #216)

## Problem
`src/cli/commands/sessions.ts` line 8: `const limit = options["limit"] ? Number.parseInt(options["limit"], 10) : 20;`. `abc` → NaN, `-3`/`0` pass through, and `2abc` silently parses as 2. All print the list and exit 0.

## Changes

1. **`src/cli/commands/sessions.ts`**
   - Add an exported pure helper `parseLimit(raw: string | undefined): number | string`-style, or simpler: `export function parseLimit(raw: string | undefined, fallback = 20): { ok: true; value: number } | { ok: false; message: string }`.
     - `undefined` → `{ok:true, value: 20}` (no `--limit` is unchanged).
     - Valid only if `/^\d+$/.test(raw)` AND `Number(raw) >= 1` AND `Number.isSafeInteger(Number(raw))`. This rejects `abc`, `-3`, `0`, `1.5`, `2abc`, `""`, ` 5`, `+3`, `1e3`.
     - Invalid → message exactly one line: `` `--limit must be a positive integer, got "${raw}"` `` (names the bad value verbatim, says positive integer).
   - In `sessionsCommand`: call `parseCli`, then **validate `--limit` BEFORE `openTrace(options)`** (so no DB is opened on bad input). On invalid: `console.error(message); return 1;`. Otherwise use `value` in `db.sessions(value)`.
   - Note `parseCli` already throws for `--limit` with no value (`--limit requires a value`) → caught by `main()` catch; leave as is.
   - Do not touch other commands, HELP text (already `[--limit N]`; optional: leave).

2. **Tests** — new `src/test/sessions_limit.test.ts` (tests run from `dist/**/*.test.js` via `node --test`; import siblings with `.ts` extension like `src/test/fanout_cli.test.ts`, which imports `../cli/commands/fanout.ts`):
   - Unit `parseLimit`: `"5"`→5, `undefined`→20, `"1"`→1; invalid for `abc`, `-3`, `0`, `1.5`, `2abc`, `""`; message is one line (no `\n`), contains the raw value and `positive integer`.
   - CLI via `spawnSync(process.execPath, [<path to dist/cli/bin.js>, "sessions", "--limit", X], { cwd: mkdtempSync(tmpdir()...) , encoding: "utf8" })` (see how other CLI tests locate bin.js, e.g. `src/test/loop_cli.test.ts`, and copy its approach; use a tmp cwd so no repo state interferes): for `abc`, `-3`, `0` assert status non-zero, combined output is one non-empty line containing the value and `positive integer`. For `--limit 2`, assert status 0.
   - If a tmp cwd makes `openTrace` fail for `--limit 2`, drop that CLI assertion in favour of calling `sessionsCommand(["--limit","2", ...])` as `fanout_cli.test.ts` does with captured console, or run it in the repo cwd (read-only).

3. **Verify**: `npm run -s typecheck && npm test` (pretest builds) and the journeys in `journeys.yaml`.

## Journeys
See `journeys.yaml` alongside this file: abc / -3 / 0 / 1.5 / 2abc rejected with exit non-zero and a one-line message naming the value; `--limit 2` exits 0.
