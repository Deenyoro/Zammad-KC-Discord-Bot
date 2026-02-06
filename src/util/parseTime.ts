/**
 * Parse a human-readable time string into an ISO 8601 datetime.
 *
 * Supported formats:
 *   - Relative: "30m", "2h", "1d", "1w"
 *   - Named: "tomorrow 9am", "tomorrow 2pm", "tomorrow"
 *   - ISO 8601: "2026-02-10T14:00:00Z"
 *
 * Returns the ISO string or null if unparseable.
 */
export function parseTime(input: string): string | null {
  const trimmed = input.trim();

  // ISO 8601 — if it parses directly, use it
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.toISOString();
    return null;
  }

  // Relative: 30m, 2h, 1d, 1w
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

  // "tomorrow" with optional time
  const tomorrowMatch = trimmed.match(/^tomorrow\s*(?:(\d{1,2})\s*(am|pm)?)?$/i);
  if (tomorrowMatch) {
    const now = new Date();
    now.setDate(now.getDate() + 1);
    let hour = tomorrowMatch[1] ? parseInt(tomorrowMatch[1], 10) : 9;
    const meridiem = tomorrowMatch[2]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    now.setHours(hour, 0, 0, 0);
    return now.toISOString();
  }

  return null;
}
