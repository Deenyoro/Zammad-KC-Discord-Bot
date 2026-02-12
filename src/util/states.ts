/**
 * Centralized ticket-state helpers.
 * Avoids duplicating the same state checks across sync.ts, backfill.ts, etc.
 */

const CLOSED_STATES = new Set(["closed", "closed (locked)", "closed (locked until)"]);
const HIDDEN_STATES = new Set(["pending close", "waiting for reply"]);

/** True for any variant of "closed" (including locked). */
export function isClosedState(state: string): boolean {
  return CLOSED_STATES.has(state.toLowerCase());
}

/** True for states where the thread should be hidden (members removed / archived). */
export function isHiddenState(state: string): boolean {
  return HIDDEN_STATES.has(state.toLowerCase());
}
