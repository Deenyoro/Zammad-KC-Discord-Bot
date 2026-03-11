import { getSetting } from "../db/index.js";

/**
 * Get the bot's configured IANA timezone, or undefined if not set.
 */
export function getBotTimezone(): string | undefined {
  return getSetting("TIMEZONE") || undefined;
}

/**
 * Get the current hour (0-23) in the bot's configured timezone.
 * Falls back to system timezone if no TIMEZONE setting is configured.
 */
export function getCurrentHourInTz(): number {
  const tz = getBotTimezone();
  if (!tz) return new Date().getHours();

  try {
    const str = new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false });
    const hour = parseInt(str, 10);
    return isNaN(hour) ? new Date().getHours() : hour;
  } catch {
    return new Date().getHours();
  }
}

/**
 * Format a Date or ISO string for display in the bot's configured timezone.
 * Example: "3/10/2026, 5:49 PM"
 */
export function formatInBotTz(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const tz = getBotTimezone();
  try {
    return d.toLocaleString("en-US", {
      timeZone: tz,
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return d.toLocaleString();
  }
}

/**
 * Get the current date/time components in the bot's configured timezone.
 * Returns { year, month (1-12), day, hour (0-23), minute }.
 */
export function nowInBotTz(): { year: number; month: number; day: number; hour: number; minute: number } {
  const tz = getBotTimezone();
  const now = new Date();

  if (!tz) {
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }

  try {
    // Use Intl.DateTimeFormat to get parts in the target timezone
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);
    return {
      year: get("year"),
      month: get("month"),
      day: get("day"),
      hour: get("hour") % 24, // hour12:false can return 24 for midnight in some locales
      minute: get("minute"),
    };
  } catch {
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
  }
}

/**
 * Build a UTC Date from components interpreted in the bot's timezone.
 * E.g., "tomorrow 9am EST" → correct UTC timestamp for 9am EST.
 */
export function dateFromBotTz(year: number, month: number, day: number, hour: number, minute: number): Date {
  const tz = getBotTimezone();
  if (!tz) {
    return new Date(year, month - 1, day, hour, minute, 0, 0);
  }

  // Build a locale string in the target timezone, then compute the UTC offset
  // by comparing what we want vs what UTC thinks
  const target = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  // Get what time it is in the target TZ when UTC shows our desired time
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = fmt.formatToParts(target);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? "0", 10);
  const tzHour = get("hour") % 24;
  const tzMinute = get("minute");
  const tzDay = get("day");
  const tzMonth = get("month");

  // Compute the offset: what the TZ shows minus what we put in UTC
  // This tells us: to get our desired local time, shift UTC by this offset
  let offsetMs = 0;
  const tzDate = new Date(Date.UTC(get("year"), tzMonth - 1, tzDay, tzHour, tzMinute, 0, 0));
  offsetMs = tzDate.getTime() - target.getTime();

  // Subtract the offset to get the correct UTC time
  return new Date(target.getTime() - offsetMs);
}
