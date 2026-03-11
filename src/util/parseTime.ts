/**
 * Parse a human-readable time string into an ISO 8601 datetime.
 * All times are interpreted in the bot's configured timezone.
 *
 * Supported formats:
 *   - Relative: "30m", "2h", "1d", "1w"
 *   - Named: "tomorrow 9am", "tomorrow 2pm", "tomorrow"
 *   - ISO 8601: "2026-02-10T14:00:00Z"
 *
 * Returns the ISO string or null if unparseable.
 */

import { nowInBotTz, dateFromBotTz } from "./timezone.js";

export function parseTime(input: string): string | null {
  const trimmed = input.trim();

  // ISO 8601 — if it parses directly, use it as-is (user gave an explicit timestamp)
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
  }

  // Relative: 30m, 2h, 1d, 1w — these are duration offsets from NOW, timezone doesn't matter
  const relMatch = trimmed.match(/^(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days|w|wk|wks)$/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const now = new Date();
    if (unit.startsWith("m")) {
      now.setMinutes(now.getMinutes() + amount);
    } else if (unit.startsWith("h")) {
      now.setHours(now.getHours() + amount);
    } else if (unit.startsWith("d")) {
      now.setDate(now.getDate() + amount);
    } else if (unit.startsWith("w")) {
      now.setDate(now.getDate() + amount * 7);
    }
    return now.toISOString();
  }

  // "tomorrow" with optional time — interpreted in bot's configured timezone
  const tomorrowMatch = trimmed.match(/^tomorrow\s*(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (tomorrowMatch) {
    const current = nowInBotTz();
    const tomorrowDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    const tYear = tomorrowDay.getUTCFullYear();
    const tMonth = tomorrowDay.getUTCMonth() + 1;
    const tDay = tomorrowDay.getUTCDate();

    let hour = tomorrowMatch[1] ? parseInt(tomorrowMatch[1], 10) : 9;
    const minutes = tomorrowMatch[2] ? parseInt(tomorrowMatch[2], 10) : 0;
    const meridiem = tomorrowMatch[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    const result = dateFromBotTz(tYear, tMonth, tDay, hour, minutes);
    return result.toISOString();
  }

  // "today" with optional time — interpreted in bot's configured timezone
  const todayMatch = trimmed.match(/^today\s*(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (todayMatch) {
    const current = nowInBotTz();
    let hour = todayMatch[1] ? parseInt(todayMatch[1], 10) : current.hour + 1;
    const minutes = todayMatch[2] ? parseInt(todayMatch[2], 10) : 0;
    const meridiem = todayMatch[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    const result = dateFromBotTz(current.year, current.month, current.day, hour, minutes);
    return result.toISOString();
  }

  return null;
}
