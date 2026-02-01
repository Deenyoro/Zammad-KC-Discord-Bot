/**
 * Truncate a string to a maximum length, appending an ellipsis if truncated.
 * Discord embed limits:
 *   title: 256, description: 4096, field name: 256, field value: 1024,
 *   footer text: 2048, author name: 256, total chars across all embeds: 6000
 */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "\u2026";
}
