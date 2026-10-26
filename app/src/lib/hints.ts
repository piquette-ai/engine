/** Cold-start copy for the InfoHint marks: words a first-time reader may not know. */
export const HINTS = {
  phases:
    'A run is a chain of phases. Agent phases read and decide; code phases run a known command like your tests. Each phase finishes before the next starts.',
  gate: "A gate is a check written in code, such as tests or a typecheck, that a phase's output must pass. A failed gate stops the run or sends it to a fix phase.",
  chain: 'The sequence of phases this run followed, defined in .piquette/piquette.config.yaml.',
} as const
