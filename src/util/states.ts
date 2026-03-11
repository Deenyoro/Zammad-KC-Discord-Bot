/**
 * Centralized ticket-state helpers.
 * Avoids duplicating the same state checks across sync.ts, backfill.ts, etc.
 */

const CLOSED_STATES = new Set(["closed", "closed (locked)", "closed (locked until)"]);
const HIDDEN_STATES = new Set(["pending close", "waiting for reply", "on-site", "project"]);

/** States that get their own dashboard thread in Discord. */
export const DASHBOARD_STATES = ["waiting for reply", "on-site", "project"] as const;

/** True for any variant of "closed" (including locked). */
export function isClosedState(state: string): boolean {
  return CLOSED_STATES.has(state.toLowerCase());
}

/** True for states where the thread should be hidden (members removed / archived). */
export function isHiddenState(state: string): boolean {
  return HIDDEN_STATES.has(state.toLowerCase());
}

/** True for states that have a dashboard thread. */
export function isDashboardState(state: string): boolean {
  return (DASHBOARD_STATES as readonly string[]).includes(state.toLowerCase());
}
