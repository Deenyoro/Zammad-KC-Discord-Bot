/**
 * Ticket → Markdown export (the /md command).
 *
 * The pure functions here (htmlToMarkdown, buildTicketMarkdown,
 * splitMarkdown) take plain data so they can be tested without Zammad or
 * Discord; src/commands/md.ts fetches the data and delivers the file.
 */

import TurndownService from "turndown";
import { isRawSourceAttachment } from "./sync.js";
import { decodeDataUri, imgSrc, isDecorativeImage } from "../util/inlineImages.js";

export interface ExportTicket {
  id: number;
  number: string;
  title: string;
  state?: string;
  priority?: string;
  group?: string;
  owner?: string;
  customer?: string;
  organization?: string;
  created_at?: string;
  updated_at?: string;
  pending_time?: string | null;
  close_at?: string | null;
  tags?: string[];
}

export interface ExportAttachment {
  id: number;
  filename: string;
  size?: number | string;
  preferences?: unknown;
}

export interface ExportArticle {
  id: number;
  ticket_id?: number;
  created_at: string;
  type?: string;
  sender?: string;
  from?: string | null;
  to?: string | null;
  cc?: string | null;
  subject?: string | null;
  internal?: boolean;
  content_type?: string | null;
  body?: string | null;
  attachments?: ExportAttachment[];
}

export interface ExportContext {
  /** Public Zammad base URL, no trailing slash (links in the document). */
  baseUrl: string;
  /** Formats an ISO timestamp for display (bot timezone). */
  formatTime: (iso: string) => string;
  exportedAt: string;
  exportedBy?: string;
}

// ---------------------------------------------------------------
// HTML → Markdown
// ---------------------------------------------------------------

function attachmentUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

function makeTurndown(baseUrl: string): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.remove(["style", "script", "head", "title", "meta", "link" as any]);

  td.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const el = node as unknown as { outerHTML?: string; getAttribute(n: string): string | null };
      const tag = el.outerHTML ?? "";
      const src = imgSrc(tag) ?? el.getAttribute("src") ?? "";
      const alt = (el.getAttribute("alt") || "").replace(/[[\]]/g, "").trim();
      if (!src) return "";
      if (isDecorativeImage(tag) && !/\/ticket_attachment\//.test(src)) return "";
      const att = /\/api\/v1\/ticket_attachment\/\d+\/\d+\/\d+[^\s"']*/.exec(src);
      if (att) return `![${alt || "inline image"}](${attachmentUrl(baseUrl, att[0])})`;
      if (/^cid:/i.test(src)) return `_[inline image${alt ? `: ${alt}` : ""}]_`;
      if (/^data:/i.test(src)) {
        const decoded = decodeDataUri(src);
        const kb = decoded ? ` ${Math.max(1, Math.round(decoded.data.length / 1024))} KB` : "";
        return `_[embedded image${alt ? `: ${alt}` : ""}${kb}]_`;
      }
      if (/^https?:\/\//i.test(src)) return `![${alt || "image"}](${src})`;
      return "";
    },
  });

  // Keep the text of layout tables readable: one row per line, cells split by " | ".
  td.addRule("tableCell", {
    filter: ["td", "th"],
    replacement: (content) => {
      const c = content.replace(/\n+/g, " ").trim();
      return c ? `${c} | ` : "";
    },
  });
  td.addRule("tableRow", {
    filter: "tr",
    replacement: (content) => {
      const c = content.replace(/\s*\|\s*$/, "").trim();
      return c ? `\n${c}\n` : "";
    },
  });
  td.addRule("tableWrap", {
    filter: ["table", "thead", "tbody", "tfoot"],
    replacement: (content) => `\n\n${content.trim()}\n\n`,
  });

  return td;
}

/** Convert an article's HTML body to clean Markdown. */
export function htmlToMarkdown(html: string, baseUrl: string): string {
  if (!html) return "";
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?o:p[^>]*>/gi, "")
    .replace(/<(style|script|head|title)\b[\s\S]*?<\/\1>/gi, "");
  let md: string;
  try {
    md = makeTurndown(baseUrl).turndown(cleaned);
  } catch {
    md = plainFromHtml(cleaned);
  }
  return tidy(md);
}

function plainFromHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function tidy(md: string): string {
  return md
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/^(>\s*)+$/gm, (m) => m.trimEnd())
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Body of an article as Markdown, whatever its content type. */
export function articleBodyMarkdown(article: ExportArticle, baseUrl: string): string {
  const body = article.body ?? "";
  if (!body.trim()) return "_(empty)_";
  const isHtml = /html/i.test(article.content_type ?? "") || /<\/?[a-z][\s\S]*?>/i.test(body);
  if (isHtml) return htmlToMarkdown(body, baseUrl) || "_(empty)_";
  // Plain text (SMS, notes): keep its line breaks as Markdown hard breaks.
  return tidy(body.replace(/\r\n/g, "\n")).replace(/([^\n])\n(?=[^\n])/g, "$1  \n");
}

// ---------------------------------------------------------------
// Document
// ---------------------------------------------------------------

const cell = (v: string | undefined | null) =>
  (v ?? "").toString().replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "-";

/** Inline text that must not be read as Markdown (headers/addresses). */
const inline = (v: string) => v.replace(/([\\`*_[\]<>|])/g, "\\$1").replace(/\r?\n/g, " ");

function fmtSize(size: number | string | undefined): string {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ticketHeaderMarkdown(ticket: ExportTicket, articleCount: number, ctx: ExportContext): string {
  const url = `${ctx.baseUrl}/#ticket/zoom/${ticket.id}`;
  const t = (iso?: string | null) => (iso ? ctx.formatTime(iso) : "-");
  const rows: [string, string][] = [
    ["Number", `#${ticket.number}`],
    ["Title", ticket.title],
    ["State", ticket.state ?? "-"],
    ["Priority", ticket.priority ?? "-"],
    ["Group", ticket.group ?? "-"],
    ["Owner", ticket.owner ?? "-"],
    ["Customer", ticket.customer ?? "-"],
    ["Organization", ticket.organization ?? "-"],
    ["Created", t(ticket.created_at)],
    ["Updated", t(ticket.updated_at)],
  ];
  if (ticket.pending_time) rows.push(["Pending until", t(ticket.pending_time)]);
  if (ticket.close_at) rows.push(["Closed", t(ticket.close_at)]);
  rows.push(["Tags", ticket.tags && ticket.tags.length ? ticket.tags.join(", ") : "-"]);
  rows.push(["Articles", String(articleCount)]);
  rows.push(["Zammad", url]);

  const lines = [
    `# Ticket #${ticket.number}: ${inline(ticket.title)}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`),
    "",
    `_Exported ${ctx.formatTime(ctx.exportedAt)}${ctx.exportedBy ? ` by ${inline(ctx.exportedBy)}` : ""}._`,
    "",
  ];
  return lines.join("\n");
}

export function articleMarkdown(article: ExportArticle, index: number, ticketId: number, ctx: ExportContext): string {
  const type = article.type ?? "article";
  const sender = article.sender ?? "-";
  const visibility = article.internal ? "internal" : "public";
  const lines: string[] = [
    `## ${index}. ${ctx.formatTime(article.created_at)} · ${type} · ${sender}${article.internal ? " · internal" : ""}`,
    "",
  ];
  const meta: [string, string | null | undefined][] = [
    ["From", article.from && article.from !== "-" ? article.from : null],
    ["To", article.to],
    ["Cc", article.cc],
    ["Subject", article.subject],
  ];
  for (const [k, v] of meta) if (v && v.trim()) lines.push(`- **${k}:** ${inline(v.trim())}`);
  lines.push(`- **Type:** ${type} · **Sender:** ${sender} · **Visibility:** ${visibility}`);
  lines.push(`- **Article:** [${article.id}](${ctx.baseUrl}/#ticket/zoom/${ticketId}/${article.id})`);
  lines.push("", articleBodyMarkdown(article, ctx.baseUrl), "");

  const files = (article.attachments ?? []).filter((a) => !isRawSourceAttachment(a));
  if (files.length) {
    lines.push("**Attachments:**", "");
    for (const a of files) {
      const size = fmtSize(a.size);
      const link = `${ctx.baseUrl}/api/v1/ticket_attachment/${ticketId}/${article.id}/${a.id}?disposition=attachment`;
      lines.push(`- [${a.filename.replace(/[[\]]/g, "")}](${link})${size ? ` (${size})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Articles in conversation order: created_at, then id. */
export function sortArticles<T extends { id: number; created_at: string }>(articles: T[]): T[] {
  return [...articles].sort((a, b) => {
    const ta = new Date(a.created_at).getTime();
    const tb = new Date(b.created_at).getTime();
    if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return a.id - b.id;
    return ta - tb;
  });
}

export interface TicketMarkdown {
  header: string;
  sections: string[];
  /** header + sections, the complete document. */
  full: string;
}

export function buildTicketMarkdown(
  ticket: ExportTicket,
  articles: ExportArticle[],
  ctx: ExportContext,
): TicketMarkdown {
  const sorted = sortArticles(articles);
  const header = ticketHeaderMarkdown(ticket, sorted.length, ctx);
  const sections = sorted.map((a, i) => articleMarkdown(a, i + 1, ticket.id, ctx));
  const full = [header, ...sections.map((s) => `---\n\n${s}`)].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  return { header, sections, full };
}

/**
 * Split a document into parts of at most `maxBytes` (UTF-8) for upload
 * limits, breaking between articles where possible and between lines
 * otherwise. Returns [full] when it already fits.
 */
export function splitMarkdown(doc: TicketMarkdown, maxBytes: number): string[] {
  if (Buffer.byteLength(doc.full) <= maxBytes) return [doc.full];
  const budget = Math.max(1024, maxBytes - 200); // room for the part banner
  const pieces: string[] = [];
  for (const block of [doc.header, ...doc.sections.map((s) => `---\n\n${s}`)]) {
    if (Buffer.byteLength(block) <= budget) {
      pieces.push(block);
      continue;
    }
    // One huge article: split by lines (and hard-split very long lines).
    let cur = "";
    for (const line of block.split("\n")) {
      let rest = line + "\n";
      while (Buffer.byteLength(cur) + Buffer.byteLength(rest) > budget) {
        if (cur) {
          pieces.push(cur);
          cur = "";
          continue;
        }
        let cut = Math.min(rest.length, budget);
        while (Buffer.byteLength(rest.slice(0, cut)) > budget) cut = Math.floor(cut * 0.9);
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      cur += rest;
    }
    if (cur) pieces.push(cur);
  }
  const parts: string[] = [];
  let cur = "";
  for (const p of pieces) {
    const joined = cur ? `${cur}\n${p}` : p;
    if (cur && Buffer.byteLength(joined) > budget) {
      parts.push(cur);
      cur = p;
    } else {
      cur = joined;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((p, i) => `<!-- part ${i + 1} of ${parts.length} -->\n\n${p.trimEnd()}\n`);
}
