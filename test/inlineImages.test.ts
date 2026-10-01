// Inline images in Zammad article bodies → Discord files. The HTML below
// mirrors the shapes seen on real tickets (Outlook replies with an <hr> +
// bold From/Sent header block, screenshots in the quoted chain) with
// made-up content.
import { db } from "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const { extractInlineImages, decodeDataUri, inlineAttachmentIds, isHeic } = await import("../src/util/inlineImages.js");
const { collectArticleMedia, renderEmailArticle, extractInlineImageIds } = await import("../src/services/sync.js");
const { splitEmailHtml } = await import("../src/util/emailSplit.js");
const { filenameFromContentDisposition } = await import("../src/services/zammad.js");

const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const outlookHeader = (who: string) =>
  `<hr>\n<div dir="ltr"><b>From:</b> ${who} &lt;${who.toLowerCase()}@example.com&gt;<br>\n` +
  `<b>Sent:</b> Wednesday, September 30, 2026 1:30 PM<br>\n<b>To:</b> Support &lt;support@example.com&gt;<br>\n` +
  `<b>Subject:</b> Re: Viewer</div>`;

test("ticket_attachment URLs (relative and absolute), in document order", () => {
  const html =
    `<p>see</p><img style="width:800px" src="/api/v1/ticket_attachment/10/20/31?view=inline">` +
    `<img src="https://helpdesk.example.com/api/v1/ticket_attachment/10/20/32?view=inline">` +
    `<img src='/api/v1/ticket_attachment/10/20/31?view=inline'>`; // duplicate
  const refs = extractInlineImages(html, 10, 20);
  assert.deepEqual(
    refs.map((r) => (r.kind === "attachment" ? r.attachmentId : -1)),
    [31, 32],
  );
});

test("another ticket's attachment is never referenced; another article of this ticket is", () => {
  const html =
    `<img src="/api/v1/ticket_attachment/99/20/1">` +
    `<img src="/api/v1/ticket_attachment/10/19/2">`;
  const refs = extractInlineImages(html, 10, 20);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0], { kind: "attachment", ticketId: 10, articleId: 19, attachmentId: 2, filename: undefined });
});

test("cid: references resolve through the attachments' Content-ID", () => {
  const html = `<img src="cid:ii_abc123" width="859"><img src="cid:missing">`;
  const atts = [
    { id: 7, filename: "message.html", preferences: { "content-alternative": true } },
    { id: 8, filename: "Screenshot 1.png", preferences: { "Content-ID": "<ii_abc123>", "Mime-Type": "image/png" } },
  ];
  const refs = extractInlineImages(html, 10, 20, atts);
  assert.deepEqual(refs, [{ kind: "attachment", ticketId: 10, articleId: 20, attachmentId: 8, filename: "Screenshot 1.png" }]);
  assert.deepEqual([...inlineAttachmentIds(html, 10, 20, atts)], [8]);
});

test("data: URIs are decoded, including wrapped, url-encoded and unpadded base64", () => {
  const wrapped = PNG_1x1.replace(/(.{20})/g, "$1\r\n ");
  const encoded = encodeURIComponent(PNG_1x1);
  const unpadded = PNG_1x1.replace(/=+$/, "");
  for (const payload of [PNG_1x1, wrapped, encoded, unpadded]) {
    const d = decodeDataUri(`data:image/png;base64,${payload}`);
    assert.ok(d, payload.slice(0, 30));
    assert.equal(d.mimeType, "image/png");
    assert.deepEqual(d.data.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  const refs = extractInlineImages(`<img src="data:image/png;base64,${wrapped}">`, 1, 2);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, "data");
});

test("invalid or non-image data: URIs are skipped without throwing", () => {
  assert.equal(decodeDataUri("data:image/png;base64,@@@not-base64@@@"), null);
  assert.equal(decodeDataUri("data:image/png;base64,QUJD"), null); // too small to be an image
  assert.equal(decodeDataUri(`data:text/html;base64,${PNG_1x1}`), null);
  assert.equal(decodeDataUri("data:image/png;base64,A"), null); // impossible length
  assert.deepEqual(extractInlineImages(`<img src="data:image/png;base64,%E0%A4%A">`, 1, 2), []);
});

test("decorative, remote and src-less images are ignored", () => {
  const html =
    `<img src="/api/v1/ticket_attachment/1/2/3" style="width:150px">` + // logo
    `<img src="/api/v1/ticket_attachment/1/2/4" width="1" height="0" style="display:none">` +
    `<img src="https://tracker.example.com/p.gif">` +
    `<img style="max-width:100%; width:844px;">`;
  assert.deepEqual(extractInlineImages(html, 1, 2), []);
});

test("Outlook reply: a screenshot above the <hr> header block stays in the reply", () => {
  const html =
    `<div>My account is disabled, can you re-enable it?</div><div>&nbsp;</div><div>\n` +
    `<img style="width: 433px; height: 441px; max-width: 1043px;" src="/api/v1/ticket_attachment/5/50/501?view=inline"></div>` +
    outlookHeader("Alice") +
    `<div>quoted text</div>`;
  const { reply, context } = splitEmailHtml(html);
  assert.match(reply, /ticket_attachment\/5\/50\/501/);
  assert.ok(context.startsWith("<hr>"));
  const { replyHtml } = renderEmailArticle(html, "Agent", "", true);
  assert.deepEqual(extractInlineImageIds(replyHtml, 5, 50), [501]);
});

const store = new Map<string, Buffer>();
const imageBytes = (tag: string) => {
  // Distinct, valid-looking PNG bytes per logical image.
  if (!store.has(tag)) store.set(tag, Buffer.concat([Buffer.from(PNG_1x1, "base64"), Buffer.from(tag)]));
  return store.get(tag)!;
};

test("collectArticleMedia: quoted-chain screenshots are posted once per ticket", async () => {
  const T = 777;
  // Same pictures re-embedded under new attachment ids by later replies.
  const content: Record<number, string> = { 101: "screenshot", 201: "screenshot", 202: "agent-image", 301: "screenshot", 302: "agent-image" };
  const download = async (_t: number, _a: number, id: number) => ({
    data: imageBytes(content[id] ?? String(id)),
    contentType: "image/png",
    filename: `file-${id}.png`,
  });
  const isPosted = (t: number, h: string) => db.isMediaPosted(t, h);

  // 1) Customer reply whose only screenshot is in the quoted (forwarded) part.
  const a1 =
    `<div>Please help, see below.</div>` + outlookHeader("Vendor") +
    `<div>Here are the users:</div><div><img style="max-width:100%; height:auto; width:859.657px;" src="/api/v1/ticket_attachment/${T}/1/101?view=inline"></div>`;
  const m1 = await collectArticleMedia({ ticketId: T, articleId: 1, bodyHtml: a1, attachments: [] }, { download, isPosted });
  assert.deepEqual(m1.files.map((f) => f.filename), ["file-101.png"]);
  db.recordPostedMedia(T, 1, m1.mediaHashes);

  // 2) Agent reply with its own image above the header + the quoted screenshot.
  const a2 =
    `<div>Account disabled.</div><div><img style="width:433px; height:441px" src="/api/v1/ticket_attachment/${T}/2/202?view=inline"></div>` +
    outlookHeader("Customer") + a1.replace(`/${T}/1/101`, `/${T}/2/201`);
  const m2 = await collectArticleMedia({ ticketId: T, articleId: 2, bodyHtml: a2, attachments: [] }, { download, isPosted });
  assert.deepEqual(m2.files.map((f) => f.filename), ["file-202.png"]);
  db.recordPostedMedia(T, 2, m2.mediaHashes);

  // 3) Another reply quoting both: nothing new to post.
  const a3 = `<div>Still deactivated.</div>` + outlookHeader("Vendor") +
    a2.replace(`/${T}/2/202`, `/${T}/3/302`).replace(`/${T}/2/201`, `/${T}/3/301`);
  const m3 = await collectArticleMedia({ ticketId: T, articleId: 3, bodyHtml: a3, attachments: [] }, { download, isPosted });
  assert.deepEqual(m3.files, []);
});

test("collectArticleMedia: cid: and data: images, raw-source copies skipped, attachments kept", async () => {
  const T = 888;
  const atts = [
    { id: 1, filename: "message.html", size: 5000, preferences: { "content-alternative": true } },
    { id: 2, filename: "invoice.pdf", size: 3000, preferences: {} },
    { id: 3, filename: "photo.png", size: 2000, preferences: { "Content-ID": "<img-3@x>" } },
  ];
  const body =
    `<p>Pic:</p><img src="cid:img-3@x" width="600">` +
    `<img src="data:image/png;base64,${PNG_1x1}">`;
  const downloads: number[] = [];
  const m = await collectArticleMedia(
    { ticketId: T, articleId: 9, bodyHtml: body, attachments: atts },
    {
      download: async (_t, _a, id) => {
        downloads.push(id);
        return { data: imageBytes(`att-${id}`), contentType: id === 2 ? "application/pdf" : "image/png" };
      },
      isPosted: () => false,
    },
  );
  assert.deepEqual(downloads, [2, 3]); // message.html never downloaded; photo once
  assert.deepEqual(m.files.map((f) => f.filename), ["invoice.pdf", "photo.png", "inline-image-9-2.png"]);
  assert.equal(m.mediaHashes.length, 3);
  assert.equal(
    m.mediaHashes[2],
    createHash("sha256").update(Buffer.from(PNG_1x1, "base64")).digest("hex"),
  );
});

test("collectArticleMedia: inline images work on notes too and a failed download is skipped", async () => {
  const body = `<div>note</div><img src="/api/v1/ticket_attachment/5/6/7"><img src="/api/v1/ticket_attachment/5/6/8">`;
  const m = await collectArticleMedia(
    { ticketId: 5, articleId: 6, bodyHtml: body, attachments: [] },
    {
      download: async (_t, _a, id) => {
        if (id === 7) throw new Error("boom");
        return { data: imageBytes("n8"), contentType: "image/jpeg" };
      },
      isPosted: () => false,
    },
  );
  assert.deepEqual(m.files.map((f) => f.filename), ["inline-image-8.jpg"]);
});

test("HEIC detection and Content-Disposition filenames", () => {
  assert.equal(isHeic("IMG_0001.HEIC"), true);
  assert.equal(isHeic("x", "image/heif"), true);
  assert.equal(isHeic("x.jpg", "image/jpeg"), false);
  assert.equal(
    filenameFromContentDisposition(`inline; filename="a b.png"; filename*=UTF-8''Roam%20SparkPlug%201.55.31%20PM.png`),
    "Roam SparkPlug 1.55.31 PM.png",
  );
  assert.equal(filenameFromContentDisposition(`attachment; filename="report.pdf"`), "report.pdf");
  assert.equal(filenameFromContentDisposition(null), undefined);
});
