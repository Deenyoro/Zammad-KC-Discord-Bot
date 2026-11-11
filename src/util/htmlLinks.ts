// Links in HTML bodies -> Discord text.
//
// HTML-only emails carry their links in <a href> (e.g. a "Sign in" button
// whose href is a magic link). Stripping the tags used to drop the href, so
// the thread got the bare word "Sign in" and the link was lost. Links are now
// kept inline as Discord markdown: [Sign in](<url>), or <url> when the text is
// the address itself. The angle brackets stop Discord from adding a preview
// embed for every link (mail footers have many). Message splitting keeps each
// link whole (see util/truncate.ts).

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const IMG_ALT = /<img\b[^>]*\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
/** Text that is itself an address or a domain ("claude.ai", "https://x.y/z"). */
const URL_LIKE = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i;

function cleanLabel(inner: string): string {
  const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (text) return text;
  const alt = IMG_ALT.exec(inner);
  return alt ? decodeEntities(alt[1] ?? alt[2] ?? "").replace(/\s+/g, " ").trim() : "";
}

/** A URL Discord can show inside <...>: no spaces or angle brackets. */
function cleanUrl(raw: string): string {
  return decodeEntities(raw.trim()).replace(/\s/g, "%20").replace(/</g, "%3C").replace(/>/g, "%3E");
}

function sameAddress(label: string, url: string): boolean {
  const norm = (s: string) => s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "").toLowerCase();
  return norm(label) === norm(url);
}

/** One link as Discord markdown, or plain text when it isn't a web link. */
export function linkToMarkdown(label: string, href: string): string {
  const url = cleanUrl(href);
  if (!/^https?:\/\//i.test(url)) {
    // mailto:, tel:, #anchors, javascript: -> just the visible text
    if (label) return label;
    return /^mailto:/i.test(url) ? url.slice(7).split("?")[0] : "";
  }
  // Image-only links (logos, social icons, tracking pixels) without alt text are noise.
  if (!label) return "";
  if (sameAddress(label, url)) return `<${url}>`;
  // Discord refuses masked links whose text looks like a different address.
  if (URL_LIKE.test(label)) return `${label}: <${url}>`;
  return `[${label.replace(/\[/g, "(").replace(/\]/g, ")")}](<${url}>)`;
}

/**
 * Replace every <a href> in the HTML with a placeholder and return the
 * markdown for each, so tag stripping and entity decoding can't touch the
 * links. Put them back with restoreLinks().
 */
export function protectLinks(html: string): { html: string; links: string[] } {
  const links: string[] = [];
  const out = html.replace(ANCHOR, (_m, attrs: string, inner: string) => {
    const h = HREF.exec(attrs);
    const label = cleanLabel(inner);
    const md = h ? linkToMarkdown(label, h[1] ?? h[2] ?? h[3] ?? "") : label;
    links.push(md);
    return `\u0000${links.length - 1}\u0000`;
  });
  return { html: out, links };
}

export function restoreLinks(text: string, links: string[]): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => links[Number(i)] ?? "");
}

/** Spans of links in Discord text: [label](<url>), [label](url), <url>, bare URLs. */
const LINK_SPAN = /\[[^\]\n]*\]\(<[^>\s]+>\)|\[[^\]\n]*\]\([^)\s]+\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>]+/gi;

export function linkSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(LINK_SPAN)) spans.push([m.index!, m.index! + m[0].length]);
  return spans;
}

/** Move a cut point out of any link it falls inside (to the link's start). */
export function safeCutIndex(text: string, index: number): number {
  for (const [s, e] of linkSpans(text)) {
    if (s >= index) break;
    if (index > s && index < e) return s;
  }
  return index;
}
