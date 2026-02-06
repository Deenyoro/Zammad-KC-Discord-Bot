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

/**
 * Split a long message into chunks that fit within Discord's 2000 char limit.
 * Tries to split at natural boundaries (newlines, then spaces) for readability.
 */
export function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point
    let splitIndex = maxLength;

    // First try to split at a newline
    const lastNewline = remaining.lastIndexOf("\n", maxLength);
    if (lastNewline > maxLength * 0.5) {
      splitIndex = lastNewline + 1; // Include the newline in the first chunk
    } else {
      // Fall back to splitting at a space
      const lastSpace = remaining.lastIndexOf(" ", maxLength);
      if (lastSpace > maxLength * 0.5) {
        splitIndex = lastSpace + 1;
      }
      // Otherwise just hard split at maxLength
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
