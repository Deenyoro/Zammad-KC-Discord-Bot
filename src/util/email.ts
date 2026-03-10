/**
 * Robust email validation and parsing utilities.
 *
 * Handles every format users might paste, type, or get from autocomplete:
 *   - bare:         user@example.com
 *   - angle:        <user@example.com>
 *   - display:      John Doe <user@example.com>
 *   - quoted:       "John Doe" <user@example.com>
 *   - mixed case:   John DOE <User@Example.COM>
 *   - extra spaces: "  John Doe  " < user@example.com >
 *   - mailto:       mailto:user@example.com
 *   - parenthetical:user@example.com (John Doe)
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Basic email format validation on a bare email string. */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

/**
 * Extract a bare, validated email address from any reasonable format.
 * Returns the lowercase bare email or null if nothing valid can be extracted.
 *
 * This is THE function to use for all user-supplied email input.
 */
export function parseEmailAddress(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;

  let input = raw.trim();
  if (!input) return null;

  // Strip mailto: prefix
  input = input.replace(/^mailto:/i, "");

  // Try angle brackets first: anything <email>
  const angleMatch = input.match(/<\s*([^<>\s]+)\s*>/);
  if (angleMatch) {
    const inner = angleMatch[1].trim();
    if (EMAIL_REGEX.test(inner)) return inner.toLowerCase();
  }

  // Strip trailing parenthetical comment: user@example.com (John Doe)
  const parenStripped = input.replace(/\s*\([^)]*\)\s*$/, "").trim();

  // Strip any remaining display name prefix (anything before the last space-separated email-like token)
  // Try the whole cleaned string first
  if (EMAIL_REGEX.test(parenStripped)) return parenStripped.toLowerCase();

  // Try extracting just the email-looking part from a "Name email" string
  const tokens = parenStripped.split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i].replace(/^<|>$/g, "").trim();
    if (EMAIL_REGEX.test(token)) return token.toLowerCase();
  }

  // Last resort: look for anything that looks like an email anywhere in the string
  const globalMatch = input.match(/[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+/);
  if (globalMatch && EMAIL_REGEX.test(globalMatch[0])) {
    return globalMatch[0].toLowerCase();
  }

  return null;
}

/**
 * Parse a display name from an email header string.
 * "John Doe" <john@example.com> → "John Doe"
 * John Doe <john@example.com> → "John Doe"
 * john@example.com (John Doe) → "John Doe"
 * john@example.com → null
 */
export function parseDisplayName(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;

  // "Name" <email> or Name <email>
  const angleMatch = raw.match(/^"?([^"<]+)"?\s*</);
  if (angleMatch) {
    const name = angleMatch[1].trim();
    // Make sure we didn't just grab the email itself as the name
    if (name && !EMAIL_REGEX.test(name)) return name;
  }

  // email (Name)
  const parenMatch = raw.match(/\(([^)]+)\)/);
  if (parenMatch) {
    const name = parenMatch[1].trim();
    if (name) return name;
  }

  return null;
}
