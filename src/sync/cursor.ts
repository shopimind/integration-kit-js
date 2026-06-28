/**
 * Cursor semantics that are SAFE by construction.
 *
 * Golden rule (enforced by the ENGINE, never by the integration): the cursor
 * only advances if the step had NO error. A partial failure replays its window
 * on the next run - no silent data loss.
 */

export type CursorScope = 'global' | 'per-source';

export interface SyncStepOutcome {
  errors: string[];
  /** Upper bound to advance the cursor to IF the run is clean. */
  advanceCursorTo?: Date;
}

export function shouldAdvanceCursor(outcome: SyncStepOutcome): boolean {
  return outcome.errors.length === 0 && outcome.advanceCursorTo != null;
}

/** Returns the new cursor value, or `null` if it should not advance. */
export function nextCursorValue(outcome: SyncStepOutcome): Date | null {
  return shouldAdvanceCursor(outcome) ? (outcome.advanceCursorTo as Date) : null;
}
