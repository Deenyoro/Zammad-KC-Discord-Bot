/**
 * Parse a human-readable time string into an ISO 8601 datetime.
 * Wall-clock times are interpreted in the bot's configured timezone
 * (`/setup timezone`, falling back to the container's timezone).
 *
 * Shared by /schedule and /remind-me so both accept the same syntax.
 *
 * Supported formats:
 *   - Relative: "30m", "2h", "1d", "1w", "2mo", combined "1h30m" / "1d 4h",
 *     optionally prefixed with "in" ("in 2h")
 *   - Named: "tomorrow", "tomorrow 9am", "tomorrow 14:30", "today 5pm"
 *   - Weekday: "monday", "fri 3pm" (next occurrence; today if still ahead)
 *   - Time of day: "9am", "17:30" (today if still ahead, else tomorrow)
 *   - Date/time: "2026-10-05", "2026-10-05 14:00", "2026-10-05T14:00",
 *     "2026-10-05 2pm" (bot timezone; a date alone means 9:00)
 *   - ISO 8601 with an explicit offset: "2026-02-10T14:00:00Z",
 *     "2026-02-10T14:00:00-04:00" (used as given)
 *
 * Returns the ISO string or null if unparseable. It does not reject past
 * times; callers decide what is acceptable.
 */

import { nowInBotTz, dateFromBotTz } from "./timezone.js";

const DEFAULT_HOUR = 9;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

function unitKey(raw: string): "m" | "h" | "d" | "w" | "mo" | null {
  const u = raw.toLowerCase();
  if (/^(m|min|mins|minute|minutes)$/.test(u)) return "m";
  if (/^(h|hr|hrs|hour|hours)$/.test(u)) return "h";
  if (/^(d|day|days)$/.test(u)) return "d";
  if (/^(w|wk|wks|week|weeks)$/.test(u)) return "w";
  if (/^(mo|mon|mons|month|months)$/.test(u)) return "mo";
  return null;
}

/** Parse "9", "9am", "9:30pm", "14:00" into 24h hour/minute. */
function parseClock(hRaw: string | undefined, mRaw: string | undefined, meridiem: string | undefined):
  { hour: number; minute: number } | null {
  if (hRaw === undefined) return null;
  let hour = parseInt(hRaw, 10);
  const minute = mRaw ? parseInt(mRaw, 10) : 0;
  const mer = meridiem?.toLowerCase();
  if (mer) {
    if (hour < 1 || hour > 12) return null;
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function weekdayIndex(word: string): number {
  const w = word.toLowerCase();
  if (w.length < 3) return -1;
  return WEEKDAYS.findIndex((d) => d.startsWith(w));
}

/** Calendar date `days` after the bot-timezone date of `now`. */
function addDays(now: Date, days: number): { year: number; month: number; day: number } {
  const cur = nowInBotTz(now);
  const d = new Date(Date.UTC(cur.year, cur.month - 1, cur.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function parseTime(input: string, now: Date = new Date()): string | null {
  const trimmed = input.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > 64) return null;

  // ISO-ish dates
  const dateMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:(?:[T ])(\d{1,2})(?::(\d{2}))?(?::(\d{2})(?:\.\d+)?)?\s*(am|pm)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i,
  );
  if (dateMatch) {
    const [, y, mo, d, hh, mi, ss, mer, zone] = dateMatch;
    const year = +y, month = +mo, day = +d;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Reject dates like 2026-02-31 that Date would roll over.
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCMonth() !== month - 1) return null;
    if (zone) {
      if (hh === undefined || mer) return null;
      const iso = `${y}-${mo}-${d}T${hh.padStart(2, "0")}:${mi ?? "00"}:${ss ?? "00"}${zone.length === 5 && zone !== "Z" ? zone.slice(0, 3) + ":" + zone.slice(3) : zone}`;
      const dt = new Date(iso);
      return isNaN(dt.getTime()) ? null : dt.toISOString();
    }
    let clock = { hour: DEFAULT_HOUR, minute: 0 };
    if (hh !== undefined) {
      const c = parseClock(hh, mi, mer);
      if (!c) return null;
      clock = c;
    }
    return dateFromBotTz(year, month, day, clock.hour, clock.minute).toISOString();
  }

  // Relative durations from NOW (timezone-independent): "2h", "1h30m", "in 3d"
  const rel = trimmed.replace(/^in /i, "");
  if (/^(\d+\s*[a-z]+\s*)+$/i.test(rel)) {
    const parts = [...rel.matchAll(/(\d+)\s*([a-z]+)/gi)];
    const result = new Date(now.getTime());
    let ok = parts.length > 0;
    for (const [, n, u] of parts) {
      const key = unitKey(u);
      const amount = parseInt(n, 10);
      if (!key || !Number.isFinite(amount)) { ok = false; break; }
      if (key === "mo") result.setUTCMonth(result.getUTCMonth() + amount);
      else result.setTime(result.getTime() + amount * UNIT_MS[key]);
    }
    if (ok) return isNaN(result.getTime()) ? null : result.toISOString();
  }

  // "tomorrow" with optional time
  const tomorrowMatch = trimmed.match(new RegExp(`^tomorrow(?: (?:at )?${CLOCK})?$`, "i"));
  if (tomorrowMatch) {
    const clock = tomorrowMatch[1] !== undefined
      ? parseClock(tomorrowMatch[1], tomorrowMatch[2], tomorrowMatch[3])
      : { hour: DEFAULT_HOUR, minute: 0 };
    if (!clock) return null;
    const t = addDays(now, 1);
    return dateFromBotTz(t.year, t.month, t.day, clock.hour, clock.minute).toISOString();
  }

  // "today" with optional time (no time: one hour from the current hour)
  const todayMatch = trimmed.match(new RegExp(`^today(?: (?:at )?${CLOCK})?$`, "i"));
  if (todayMatch) {
    const current = nowInBotTz(now);
    const clock = todayMatch[1] !== undefined
      ? parseClock(todayMatch[1], todayMatch[2], todayMatch[3])
      : { hour: current.hour + 1, minute: 0 };
    if (!clock) return null;
    return dateFromBotTz(current.year, current.month, current.day, clock.hour, clock.minute).toISOString();
  }

  // Weekday names: "monday", "fri 3pm"
  const wdMatch = trimmed.match(new RegExp(`^(?:next )?([a-z]+)(?: (?:at )?${CLOCK})?$`, "i"));
  if (wdMatch && weekdayIndex(wdMatch[1]) >= 0) {
    const target = weekdayIndex(wdMatch[1]);
    const clock = wdMatch[2] !== undefined
      ? parseClock(wdMatch[2], wdMatch[3], wdMatch[4])
      : { hour: DEFAULT_HOUR, minute: 0 };
    if (!clock) return null;
    const cur = nowInBotTz(now);
    const todayDow = new Date(Date.UTC(cur.year, cur.month - 1, cur.day)).getUTCDay();
    let delta = (target - todayDow + 7) % 7;
    let d = addDays(now, delta);
    let at = dateFromBotTz(d.year, d.month, d.day, clock.hour, clock.minute);
    if (at.getTime() <= now.getTime()) {
      delta += 7;
      d = addDays(now, delta);
      at = dateFromBotTz(d.year, d.month, d.day, clock.hour, clock.minute);
    }
    return at.toISOString();
  }

  // Bare time of day: "9am", "17:30" (needs am/pm or a colon to avoid
  // confusing a bare number with a duration)
  const clockMatch = trimmed.match(/^(?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (clockMatch && (clockMatch[2] !== undefined || clockMatch[3] !== undefined)) {
    const clock = parseClock(clockMatch[1], clockMatch[2], clockMatch[3]);
    if (!clock) return null;
    const cur = nowInBotTz(now);
    let at = dateFromBotTz(cur.year, cur.month, cur.day, clock.hour, clock.minute);
    if (at.getTime() <= now.getTime()) {
      const t = addDays(now, 1);
      at = dateFromBotTz(t.year, t.month, t.day, clock.hour, clock.minute);
    }
    return at.toISOString();
  }

  return null;
}
