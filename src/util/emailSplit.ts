/**
 * Split email HTML into the "new reply" portion and the "context" portion
 * (quoted replies, signatures, forwarded content).  This lets the Discord
 * formatter show the actual reply prominently and collapse the rest.
 */

export interface EmailParts {
  /** The new/primary reply content (HTML). */
  reply: string;
  /** Quoted replies, signatures, forwarded content (HTML).  Empty if none found. */
  context: string;
}

// Each pattern matches from the start of the "context" region to the end of
// the string.  We test them all and pick the one with the earliest match
// position, ensuring we split at the right boundary even when multiple
// markers are present (e.g. signature before a blockquote).
const SPLIT_PATTERNS: RegExp[] = [
  // Zammad's own signature marker — very reliable
  /<div\s[^>]*data-signature=["']true["']/i,

  // Gmail quote container
  /<div\s[^>]*class=["']gmail_quote["']/i,

  // Outlook "appendonsend" marker
  /<div\s[^>]*id=["']appendonsend["']/i,

  // Yahoo quoted container
  /<div\s[^>]*class=["']yahoo_quoted["']/i,

  // First <blockquote> (standard email quoting)
  /<blockquote[\s>]/i,

  // Outlook (desktop / OWA / Microsoft 365) reply divider: an <hr> immediately
  // followed by a bold "From: … Sent|Date: …" quoted-header block. This is the
  // dominant reply format for Outlook and is NOT preceded by dashes, so the
  // older "---/___ From:" pattern below never matches it. Split at the <hr>.
  /<hr[^>]*>(?=[\s\S]{0,800}?<b>\s*From:\s*<\/b>[\s\S]{0,800}?<b>\s*(?:Sent|Date):)/i,

  // Outlook quoted-header block with no <hr> divider: a <div>/<p> wrapping a
  // bold "From:" line followed by a bold "Sent:"/"Date:" line.
  /<(?:div|p)[^>]*>\s*(?:<[^>]+>\s*)*<b>\s*From:\s*<\/b>[\s\S]{0,800}?<b>\s*(?:Sent|Date):/i,

  // "On <date> <person> wrote:" — plain-text style quote intro
  /On\s.{10,120}wrote:\s*(?:<br|<\/p>|<\/div>|\n)/i,

  // Standard email signature delimiter: "-- " on its own line
  // Look for it after a line break element
  /(?:<br\s*\/?>|<\/p>|<\/div>)\s*--\s*(?:<br\s*\/?>|<\/p>|<\/div>)/i,

  // Outlook-style plain-text separator: "___" or "---" followed by From: header
  /[-_]{3,}[\s\S]{0,200}?From:\s/i,
];

/**
 * Split email HTML into reply + context.
 *
 * Returns the earliest split point found.  If no recognizable context
 * boundary is found, everything is returned as `reply` with empty `context`.
 */
export function splitEmailHtml(html: string): EmailParts {
  let earliestIndex = -1;

  for (const pattern of SPLIT_PATTERNS) {
    const match = pattern.exec(html);
    if (match && match.index !== undefined) {
      if (earliestIndex === -1 || match.index < earliestIndex) {
        earliestIndex = match.index;
      }
    }
  }

  if (earliestIndex <= 0) {
    return { reply: html, context: "" };
  }

  const reply = html.slice(0, earliestIndex);
  const context = html.slice(earliestIndex);

  // Only accept the split if the reply portion has meaningful text content
  // (at least a few real characters after stripping tags)
  const replyTextLength = reply.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
  if (replyTextLength < 5) {
    // The "reply" part is too short — the entire message might BE the quote
    // (e.g. a forwarded email with no added commentary).  Don't split.
    return { reply: html, context: "" };
  }

  return { reply, context };
}
