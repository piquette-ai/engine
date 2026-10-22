/** Pure helpers for the short "unknown chain/command" error. */

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** Up to `max` known names close to `typed` (edit distance or substring), nearest first. */
export function closestNames(typed: string, known: readonly string[], max = 3): string[] {
  const t = typed.toLowerCase();
  const limit = Math.max(2, Math.floor(t.length / 3));
  return known
    .map((n) => ({ n, d: levenshtein(t, n.toLowerCase()), sub: t.length >= 3 && (n.includes(t) || t.includes(n)) }))
    .filter((x) => x.d <= limit || x.sub)
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, max)
    .map((x) => x.n);
}

/** At most 3 lines: the error, an optional suggestion, the pointer. */
export function unknownNameMessage(kind: "chain" | "command or chain", typed: string, known: readonly string[]): string {
  const lines = [`unknown ${kind}: ${typed}`];
  const close = closestNames(typed, known);
  if (close.length > 0) lines.push(`did you mean: ${close.join(", ")}?`);
  lines.push("run `spf list` to see every chain, or `spf --help` for usage");
  return lines.join("\n");
}
