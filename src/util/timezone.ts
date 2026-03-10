import { getSetting } from "../db/index.js";

/**
 * Get the current hour (0-23) in the bot's configured timezone.
 * Falls back to system timezone if no TIMEZONE setting is configured.
 */
export function getCurrentHourInTz(): number {
  const tz = getSetting("TIMEZONE");
  if (!tz) return new Date().getHours();

  try {
    const str = new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false });
    const hour = parseInt(str, 10);
    return isNaN(hour) ? new Date().getHours() : hour;
  } catch {
    return new Date().getHours();
  }
}
