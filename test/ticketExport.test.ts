// /md: ticket → Markdown document.
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { htmlToMarkdown, buildTicketMarkdown, splitMarkdown, sortArticles } = await import("../src/services/ticketExport.js");
const { discordUploadLimit, formatExportTime } = await import("../src/commands/md.js");

const BASE = "https://helpdesk.example.com";
const ctx = {
  baseUrl: BASE,
  formatTime: (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC",
  exportedAt: "2026-10-01T12:00:00Z",
  exportedBy: "Pat (Discord)",
};

test("htmlToMarkdown: formatting, links, lists, quotes", () => {
  const md = htmlToMarkdown(
    `<div>Hello <b>team</b>,</div><p>See <a href="https://example.com/x">the doc</a>.</p>` +
      `<ul><li>one</li><li>two</li></ul><blockquote><p>quoted line</p></blockquote>` +
      `<style>.x{color:red}</style><!-- comment --><o:p></o:p>`,
    BASE,
  );
  assert.match(md, /Hello \*\*team\*\*,/);
  assert.match(md, /\[the doc\]\(https:\/\/example\.com\/x\)/);
  assert.match(md, /^- {1,3}one$/m);
  assert.match(md, /^> quoted line$/m);
  assert.doesNotMatch(md, /color:red|comment|o:p/);
});

test("htmlToMarkdown: inline image forms", () => {
  const md = htmlToMarkdown(
    `<img src="/api/v1/ticket_attachment/1/2/3?view=inline" alt="shot">` +
      `<img src="cid:abc">` +
      `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==">` +
      `<img src="https://t.example.com/pixel.gif" width="1" height="1">`,
    BASE,
  );
  assert.match(md, /!\[shot\]\(https:\/\/helpdesk\.example\.com\/api\/v1\/ticket_attachment\/1\/2\/3\?view=inline\)/);
  assert.match(md, /_\[inline image\]_/);
  assert.match(md, /_\[embedded image 1 KB\]_/);
  assert.doesNotMatch(md, /pixel\.gif|base64/);
});

test("htmlToMarkdown: layout tables become readable rows", () => {
  const md = htmlToMarkdown(`<table><tr><td>Name</td><td>Value</td></tr><tr><td>A</td><td>1</td></tr></table>`, BASE);
  assert.match(md, /Name \| Value/);
  assert.match(md, /A \| 1/);
});

const ticket = {
  id: 42,
  number: "187206",
  title: "SMS from +15550100 | urgent",
  state: "open",
  priority: "2 normal",
  group: "Users",
  owner: "Pat Agent <pat@example.com>",
  customer: "Jo Doe <jo@example.com>",
  organization: "Example Org",
  created_at: "2026-09-30T19:37:42Z",
  updated_at: "2026-09-30T23:30:24Z",
  tags: ["sms", "vip"],
};
const articles = [
  { id: 12, created_at: "2026-09-30T20:21:33Z", type: "note", sender: "Agent", from: "Pat Agent", internal: true, content_type: "text/plain", body: "Let me know when you're out.", attachments: [] },
  { id: 10, created_at: "2026-09-30T19:37:42Z", type: "ringcentral_sms_message", sender: "Customer", from: "+15550100", to: "+15550199", internal: false, content_type: "text/plain", body: "Later, still in the meeting" },
  { id: 11, created_at: "2026-09-30T19:28:22Z", type: "note", sender: "System", from: "-", subject: "Call activity", internal: true, content_type: "text/plain", body: "Outbound call\nDuration: 0:39" },
  {
    id: 13, created_at: "2026-09-30T22:00:00Z", type: "email", sender: "Customer", from: "Jo Doe <jo@example.com>", to: "support@example.com", cc: "boss@example.com",
    subject: "Re: help", internal: false, content_type: "text/html", body: "<p>Hi <i>there</i></p>",
    attachments: [
      { id: 900, filename: "message.html", size: 100, preferences: { "content-alternative": true } },
      { id: 901, filename: "report.pdf", size: 2_500_000, preferences: {} },
    ],
  },
];

test("buildTicketMarkdown: header, every article in order, metadata and attachments", () => {
  const doc = buildTicketMarkdown(ticket, articles, ctx);
  const md = doc.full;
  assert.ok(md.startsWith("# Ticket #187206: SMS from +15550100 \\| urgent\n"));
  for (const row of [
    "| Number | #187206 |", "| State | open |", "| Priority | 2 normal |", "| Group | Users |",
    "| Owner | Pat Agent <pat@example.com> |", "| Customer | Jo Doe <jo@example.com> |",
    "| Organization | Example Org |", "| Created | 2026-09-30 19:37 UTC |", "| Updated | 2026-09-30 23:30 UTC |",
    "| Tags | sms, vip |", "| Articles | 4 |", `| Zammad | ${BASE}/#ticket/zoom/42 |`,
  ]) assert.ok(md.includes(row), row);
  assert.match(md, /_Exported 2026-10-01 12:00 UTC by Pat \(Discord\)\._/);

  const order = [...md.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => m[2]);
  assert.deepEqual(order, [
    "2026-09-30 19:28 UTC · note · System · internal",
    "2026-09-30 19:37 UTC · ringcentral_sms_message · Customer",
    "2026-09-30 20:21 UTC · note · Agent · internal",
    "2026-09-30 22:00 UTC · email · Customer",
  ]);
  assert.match(md, /- \*\*Subject:\*\* Call activity/);
  assert.match(md, /Outbound call {2}\nDuration: 0:39/); // hard line break
  assert.doesNotMatch(md, /\*\*From:\*\* -/);
  assert.match(md, /- \*\*From:\*\* Jo Doe \\<jo@example.com\\>/);
  assert.match(md, /- \*\*Cc:\*\* boss@example.com/);
  assert.match(md, /- \*\*Type:\*\* email · \*\*Sender:\*\* Customer · \*\*Visibility:\*\* public/);
  assert.match(md, /Hi _there_/);
  assert.ok(md.includes(`- [report.pdf](${BASE}/api/v1/ticket_attachment/42/13/901?disposition=attachment) (2.4 MB)`));
  assert.doesNotMatch(md, /message\.html/);
  assert.ok(md.includes(`[13](${BASE}/#ticket/zoom/42/13)`));
});

test("sortArticles orders by created_at, then id", () => {
  const sorted = sortArticles([
    { id: 3, created_at: "2026-01-01T00:00:00Z" },
    { id: 1, created_at: "2026-01-02T00:00:00Z" },
    { id: 2, created_at: "2026-01-01T00:00:00Z" },
  ]);
  assert.deepEqual(sorted.map((a) => a.id), [2, 3, 1]);
});

test("splitMarkdown keeps small documents whole and splits large ones under the limit", () => {
  const small = buildTicketMarkdown(ticket, articles, ctx);
  assert.deepEqual(splitMarkdown(small, 10 * 1024 * 1024), [small.full]);

  const big = Array.from({ length: 60 }, (_, i) => ({
    id: 1000 + i, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), type: "note", sender: "Agent",
    internal: true, content_type: "text/plain", body: `line ${i}\n`.repeat(400),
  }));
  // One article larger than a whole part on its own.
  big.push({ id: 5000, created_at: "2026-02-01T00:00:00Z", type: "note", sender: "Agent", internal: true, content_type: "text/plain", body: "x".repeat(150_000) });
  const doc = buildTicketMarkdown(ticket, big, ctx);
  const limit = 64 * 1024;
  const parts = splitMarkdown(doc, limit);
  assert.ok(parts.length > 3);
  for (const p of parts) assert.ok(Buffer.byteLength(p) <= limit, `part of ${Buffer.byteLength(p)} bytes`);
  assert.ok(parts[0].startsWith(`<!-- part 1 of ${parts.length} -->`));
  const joined = parts.join("");
  for (const a of big) assert.ok(joined.includes(`/#ticket/zoom/42/${a.id})`), `article ${a.id}`);
});

test("upload limit by boost tier and export time format", () => {
  assert.equal(discordUploadLimit(null), 10 * 1024 * 1024);
  assert.equal(discordUploadLimit({ premiumTier: 2 } as any), 50 * 1024 * 1024);
  assert.equal(discordUploadLimit({ premiumTier: 3 } as any), 100 * 1024 * 1024);
  assert.equal(formatExportTime("2026-09-30T18:12:34Z", "America/New_York"), "2026-09-30 14:12 EDT");
  assert.equal(formatExportTime("not a date", "UTC"), "not a date");
});
