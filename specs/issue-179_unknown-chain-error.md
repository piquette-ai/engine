# Plan: short, useful error for `piquette <unknown-chain>` (issue #179)

## Problem
`src/cli/index.ts` `main()` → `default:` branch (≈line 226) prints `unknown command or chain: X\n`, then `reportUnresolvedChain`, then the whole `HELP` (28 lines) to stderr. The `run` branch (≈line 170) prints a one-line error with no suggestions. Exit code is already 1 and must stay non-zero. `--help`/`help`/no-args/`-h` print HELP via `console.log` (exit 0) and must be untouched.

## Changes

1. **New file `src/cli/unknown_name.ts`** (pure, no I/O, no node:sqlite import):
   - `editDistance(a, b): number` — plain Levenshtein (iterative, two rows).
   - `closestNames(typed: string, candidates: string[], max = 3): string[]` — candidates with distance <= max(2, floor(typed.length/3)), OR where one name starts with/contains the other (min length 3); sorted by distance then alphabetically; deduped; capped at `max`. Return `[]` if nothing close (so "no-such-chain-xyz" yields no suggestion).
   - `unknownNameMessage(typed: string | undefined, candidates: string[], kind: "command or chain" | "chain"): string[]` returning lines:
     1. `unknown ${kind}: ${typed}` (for undefined typed: `unknown chain: (none given)`). First line MUST contain the word `unknown` and the typed name verbatim.
     2. (only when suggestions exist) `did you mean: a, b?`
     3. ``run `piquette list` to see every chain, or `piquette --help` for the full usage``
   - Always <= 3 lines.

2. **`src/cli/index.ts`**
   - Import `allChains` from `../chains/index.ts` and the new helpers.
   - Add `const SUBCOMMANDS = ["run","fanout","loop","estimate","list","init","install-skill","migrate","eject","doctor","ui","watch","sessions","phases","events","abort","version","help"]` (keep next to HELP; add a comment saying keep in sync with the switch).
   - `default:` branch: replace the three `console.error` lines with `for (const l of unknownNameMessage(cmd, [...SUBCOMMANDS, ...allChains().map(c=>c.name)], "command or chain")) console.error(l);` then `reportUnresolvedChain(cmd)`; **do not print HELP**. Keep `process.exitCode = 1`.
   - `run` branch: use the same helper with candidates = chain names only, kind `"chain"` (keeps `unknown chain: X`, adds suggestions + `piquette list` pointer).
   - `reportUnresolvedChain`: cap the per-file lines so total output stays <= 10 lines even with broken repo chain files: print the header plus at most 4 `  ! file: message` lines, then `  …and N more (piquette doctor lists them all)` if truncated. Update the doc comment (it says "printed only the full HELP text").
   - Do not change `HELP` or the help branch. The "chain given but no prompt" path (`usageFor(chain)`) is out of scope.

3. **Tests** — new `src/test/unknown_name.test.ts` (tests run from `dist/**/*.test.js` via `node --test`, import with `.js` extension like `src/test/loop_cli.test.ts`):
   - Unit: `editDistance` basics; `closestNames("buidl", [...])` → includes `build`; `closestNames("no-such-chain-xyz", real names)` → `[]`; cap at 3; `unknownNameMessage` first line contains `unknown` + typed name, mentions `piquette list`, `<= 10` lines, suggestion line present only when close.
   - CLI (spawn the built binary with `execFileSync`/`spawnSync(process.execPath, [new URL("../cli/bin.js", import.meta.url).pathname, ...])`, `cwd` = an `fs.mkdtempSync` tmp dir so no repo config/chains interfere; combine stdout+stderr):
     - `no-such-chain-xyz probe`: status non-zero (1), <= 10 lines, line 1 matches /unknown.*no-such-chain-xyz/, contains `piquette list`, does NOT contain `Chain options:` / `piquette fanout`.
     - `buidl probe`: contains `did you mean` and `build`.
     - `run no-such-chain-xyz`: non-zero, <= 10 lines, mentions `piquette list`.
     - `--help`: status 0, contains `piquette list` and `piquette doctor`, and ≥ 20 lines.
   (Check how other tests resolve paths/ESM; `import.meta.url` is fine in dist ESM — verify `package.json` has `"type":"module"`.)

4. **CHANGELOG.md**: add a one-line entry under the unreleased section if the file has one (match its style).

## Verify
- `npm run -s build:cli >/dev/null && node dist/cli/bin.js no-such-chain-xyz probe; echo $?` → ≤10 lines, first line `unknown command or chain: no-such-chain-xyz`, mentions `piquette list`, exit 1.
- `node dist/cli/bin.js buidl x` → suggests `build`.
- `node dist/cli/bin.js --help` → full usage unchanged.
- `npm run typecheck && npm run build:cli && npm test`.

## Journeys
See `journeys.yaml` (same dir; run via `piquette prove`). The `--help` journey passes today by design (regression guard); all others fail on current code.
