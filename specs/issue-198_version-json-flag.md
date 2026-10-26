# Plan: `piquette version --json` + reject unknown version options

## Files
- `src/cli/commands/version.ts` — change `versionCommand()` to `versionCommand(args: string[] = [])`.
- `src/cli/index.ts` (~line 167-169) — pass `rest` through: `versionCommand(rest)` (for `version`, `--version`, `-v` alike).
- `src/cli/commands/version.test.ts` (new) — tests (see below).
- Optionally `src/cli/index.ts` HELP line 64: `piquette version [--json]   print the installed version`.

## Behaviour
Parse `args`:
- `--json` → print `JSON.stringify({ name: pkg.name, version: pkg.version })` (key order name, version; single line), return 0.
- No args → unchanged `${pkg.name} ${pkg.version}`, return 0.
- Global flags `--cwd <v>` and `--config <v>` are read by main() before dispatch (`findCwdFlag`/`findConfigFlag`): tolerate them and skip their value so they aren't rejected as unknown.
- Any other arg (starts with `-` or positional) → write to **stderr**, return 1:
  - line 1: `unknown option for version: <arg>` (must contain the typed option verbatim, e.g. `--jsno`)
  - line 2 (only if near miss): `did you mean: --json?` — use `closestNames(arg, ["--json"])` from `src/cli/unknown_name.ts` (levenshtein on the full string; `--jsno` vs `--json` is distance 2, within limit max(2, floor(6/3))=2). For the zzz case no suggestion should appear; verify `closestNames("--zzzzzzzz", ["--json"])` returns [].
  - last line: `usage: piquette version [--json]`
  - Max 3 lines. Nothing on stdout.
- Do not change the unknown-command path or anything else.

## Tests (node:test, compiled to dist and run by `npm test`)
New `src/cli/commands/version.test.ts`, spawn `dist/cli/bin.js` like `src/cli/unknown_name.test.ts` does (`import.meta.dirname`-relative path to `../bin.js`, temp cwd via mkdtempSync, spawnSync):
1. `version --json`: status 0, stdout is one line, `JSON.parse` gives `name === "@piquette/engine"` and semver `version`, and equals package.json's version.
2. `version`: status 0, stdout `@piquette/engine <version>`.
3. `version --jsno`: status non-zero, first line of stderr+stdout includes `--jsno`, output includes `--json`, stdout has no version line.
4. `version --zzzzzzzz`: non-zero, names the option, no "did you mean".
5. `--version` / `-v` still print plain version, exit 0.

## Verify
- `npm run typecheck && npm test` (pretest builds).
- Journeys in `journeys.yaml` (P01-P04): P01/P03/P04 fail today, pass after; P02 is a regression guard.
