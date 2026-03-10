/**
 * Basic email validation and parsing utilities.
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Basic email format validation. Rejects obvious garbage, not RFC 5322 compliant. */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/**
 * Parse a bare email address from a string that may include a display name.
 * Handles: "John Doe" <john@example.com>, <john@example.com>, john@example.com
 * Returns null if no valid email found.
 */
export function parseEmailAddress(raw: string): string | null {
  const angleMatch = raw.match(/<([^>]+)>/);
  if (angleMatch) {
    const inner = angleMatch[1].trim();
    return EMAIL_REGEX.test(inner) ? inner : null;
  }
  const bare = raw.trim();
  return EMAIL_REGEX.test(bare) ? bare : null;
}

/**
 * Parse a display name from an email header string.
 * "John Doe" <john@example.com> → "John Doe"
 * john@example.com → null
 */
export function parseDisplayName(raw: string): string | null {
  const match = raw.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim() || null;
  return null;
}
