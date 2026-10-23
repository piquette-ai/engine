/**
 * What each run figure means, for hover titles. The token numbers in particular
 * are read wrong without one: the headline is billed volume, not distinct tokens.
 * Shared by StatChip and the run detail's key-value sidebar.
 */
export type StatKind = 'cost' | 'tokens' | 'runtime' | 'read' | 'written'

export const STAT_TITLES: Record<StatKind, string> = {
  cost: 'Cost — dollars billed for this run, all agents combined.',
  tokens:
    'Tokens exchanged (billed) — everything sent or generated, counted once per turn. ' +
    'Each turn re-sends the whole conversation, so this is far larger than the ' +
    'conversation itself: it is spend, not size. The gap between it and read + ' +
    'written is cached context re-read on later turns.',
  runtime: 'Duration — wall-clock from the first phase starting to the last one ending.',
  read:
    'Read — raw tokens the models took in: prompts, file contents and tool results, ' +
    'counted the first time they enter the context. Excludes cached re-reads of ' +
    'material already counted here.',
  written:
    'Written — tokens the models actually generated. Each one produced exactly ' +
    'once, so this is a true count of output.',
}
