/**
 * Centralized ticket-state helpers.
 * Avoids duplicating the same state checks across sync.ts, backfill.ts, etc.
 */

// "merged"/"removed" are terminal too: zammad-kc normally rewrites merged
// children to "closed" (Kc::MergeToClosedState), but if that override is ever
// bypassed (upstream merge path, overlay failure) the child sits in "merged"
// forever — and without these entries the bot would treat it as open, keep the
// thread alive, and the backfill would re-add members it had just removed.
const CLOSED_STATES = new Set(["closed", "closed (locked)", "closed (locked until)", "merged", "removed"]);

/** Exported for the Zammad client's open-ticket query — single source of
 *  truth so the fetch filter can never disagree with isClosedState(). */
export const CLOSED_STATE_NAMES: ReadonlySet<string> = CLOSED_STATES;
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
