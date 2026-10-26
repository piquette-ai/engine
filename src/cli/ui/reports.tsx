/**
 * Shared Ink renderers for the CLI's one-shot, non-interactive reports
 * (`doctor`, `sessions`, `phases`, `list`, `fanout`'s summary table). They
 * are rendered to a string once and written like `console.log` (see
 * `paint()`), never mounted as a live Ink instance, so nothing here touches
 * raw mode or repaints the terminal.
 *
 * Every caller stays responsible for its own `--json` branch and its own
 * `isInteractive()`/non-TTY fallback — this module only renders what it's
 * given, on a real terminal. A CI log or a piped `piquette sessions` never
 * imports this file at all (see each command's call site), so nothing here
 * needs to reproduce the exact plain-text formatting the non-TTY path keeps
 * using unchanged.
 */
import type { ReactElement } from "react";
import { renderToString, Box, Text } from "ink";

/**
 * Renders the frame once, statically, and writes it like `console.log`
 * would — so it lands in scrollback and is never cleared.
 *
 * These reports are one-shot: nothing animates or updates. Mounting a live
 * Ink instance for them was the bug behind #183 — Ink's live renderer does
 * a full `clear-screen + clear-scrollback + home` repaint whenever the
 * output is as tall as the terminal (`outputHeight >= stdout.rows`), so a
 * long `piquette list` or `piquette doctor` wiped the user's scrollback. Ink's
 * `renderToString` never touches the terminal, so there is nothing to
 * clear regardless of height. Layout width follows the real terminal.
 */
export async function paint(node: ReactElement, stream: { write(chunk: string): unknown; columns?: number } = process.stdout): Promise<void> {
  const out = renderToString(node, { columns: stream.columns || 80 });
  stream.write(out.endsWith("\n") ? out : `${out}\n`);
}

export type CheckIcon = "ok" | "fail" | "warn" | "info";

export interface CheckLine {
  icon: CheckIcon;
  name: string;
  detail: string;
}

const ICON_GLYPH: Record<CheckIcon, string> = { ok: "✓", fail: "✗", warn: "⚠", info: "ℹ" };
const ICON_COLOR: Record<CheckIcon, string> = { ok: "green", fail: "red", warn: "yellow", info: "cyan" };

/** `piquette doctor`'s check list — same one line per check as the plain-text path, just with the icon colored instead of a bare glyph. */
export async function renderChecklist(lines: CheckLine[], footer: { ok: boolean; message: string }): Promise<void> {
  await paint(
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          <Text color={ICON_COLOR[line.icon]}>{ICON_GLYPH[line.icon]}</Text> {line.name}: {line.detail}
        </Text>
      ))}
      <Text> </Text>
      <Text color={footer.ok ? "green" : "red"}>{footer.message}</Text>
    </Box>,
  );
}

/**
 * A column-aligned table from pre-formatted string cells — callers still own
 * field selection/truncation (same as the `.padEnd()` code this replaces);
 * this only owns column width and alignment, via Ink's own box layout
 * instead of hand-computed pad strings. `rowColor(i)` colors an entire row
 * (e.g. red for a failed phase) — `undefined` leaves the terminal default.
 */
export async function renderTable(rows: string[][], opts?: { rowColor?: (rowIndex: number) => string | undefined }): Promise<void> {
  if (rows.length === 0) return;
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: colCount }, (_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  await paint(
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={i}>
          {row.map((cell, c) => {
            const isLast = c === row.length - 1;
            return (
              <Box key={c} width={isLast ? undefined : widths[c]} marginRight={isLast ? 0 : 2}>
                <Text color={opts?.rowColor?.(i)}>{cell}</Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>,
  );
}

export interface ChainListEntry {
  name: string;
  phases: string;
  describe: string;
  agentsLine: string;
  repoLabel?: string;
}

/** `piquette list` — one styled block per chain (bold name, dimmed description) instead of the plain-text path's hand-padded columns. */
export async function renderChainList(entries: ChainListEntry[], footer: string[]): Promise<void> {
  await paint(
    <Box flexDirection="column">
      {entries.map((entry, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold color="cyan">{entry.name}</Text> {entry.phases}
          </Text>
          <Text dimColor>  {entry.describe}</Text>
          <Text dimColor>  {entry.agentsLine}</Text>
          {entry.repoLabel ? <Text dimColor>  (repo: {entry.repoLabel})</Text> : null}
        </Box>
      ))}
      {footer.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>,
  );
}
