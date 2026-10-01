/**
 * Inline images embedded in Zammad article HTML bodies.
 *
 * Zammad article bodies reference inline images in several forms:
 *   - `/api/v1/ticket_attachment/{ticket}/{article}/{attachment}?view=inline`
 *     (relative or absolute). The REST API rewrites stored `cid:` references
 *     to this form and leaves the image OUT of `article.attachments`.
 *   - `cid:<content-id>`: the stored form, seen in webhook payloads. Resolved
 *     through the Content-ID preference of the article's attachments.
 *   - `data:image/...;base64,...`: images pasted straight into the HTML.
 * Replies usually re-embed the earlier messages' images in their quoted part
 * (under new attachment ids), so callers de-duplicate by content hash.
 */

export interface InlineAttachmentLike {
  id: number;
  filename?: string;
  preferences?: unknown;
}

export type InlineImageRef =
  | {
      kind: "attachment";
      ticketId: number;
      articleId: number;
      attachmentId: number;
      filename?: string;
    }
  | {
      kind: "data";
      mimeType: string;
      data: Buffer;
    };

/** Parse a CSS/attribute pixel value (e.g. `width: 262px` or `width="262"`).
 *  Deliberately does NOT match `max-width` (the char before "width" there is
 *  "-", which the leading class excludes), so a bare `width` wins over a
 *  responsive `max-width`. Returns null when the property is absent. */
export function parseImgPx(tag: string, prop: string): number | null {
  const style = new RegExp(`(?:^|[;\\s"'])${prop}\\s*:\\s*([0-9.]+)\\s*px`, "i").exec(tag);
  if (style) return parseFloat(style[1]);
  const attr = new RegExp(`\\s${prop}\\s*=\\s*["']?([0-9.]+)`, "i").exec(tag);
  if (attr) return parseFloat(attr[1]);
  return null;
}

/** Heuristic: an <img> with a small explicit width (or a very short height) is
 *  decorative (a signature logo, email-client chrome, or a tracking pixel),
 *  not a screenshot the sender meant to share. Screenshots are wide and
 *  typically declare only a large `max-width`, so they pass through. */
export function isDecorativeImage(tag: string): boolean {
  const width = parseImgPx(tag, "width");
  const height = parseImgPx(tag, "height");
  if (width !== null && width <= 300) return true; // logos/icons are narrow
  if (height !== null && height > 0 && height <= 60) return true; // thin banners/pixels
  if (/display\s*:\s*none/i.test(tag)) return true;
  return false;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}

/** The `src` of an <img> tag (quoted or unquoted), entity-decoded. */
export function imgSrc(tag: string): string | null {
  const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3] ?? "";
  return decodeEntities(raw.trim());
}

/** Normalise a Content-ID (`<abc@host>` → `abc@host`), case-insensitively. */
function normCid(cid: string): string {
  return cid.trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

function attachmentContentId(att: InlineAttachmentLike): string | null {
  const p = (att.preferences ?? {}) as Record<string, unknown>;
  const raw = p["Content-ID"] ?? p["content-id"] ?? p["Content-Id"] ?? p["content_id"];
  return typeof raw === "string" && raw.trim() ? normCid(raw) : null;
}

const IMAGE_MIME = /^image\/[a-z0-9.+-]+$/i;

/**
 * Decode a `data:` URI leniently. Mail clients wrap long base64 lines, some
 * percent-encode the payload or use the URL-safe alphabet, and padding is
 * often dropped. Returns null for non-image types or undecodable payloads.
 */
export function decodeDataUri(src: string): { mimeType: string; data: Buffer } | null {
  const m = /^data:([^,]*?),([\s\S]*)$/i.exec(src.trim());
  if (!m) return null;
  const params = m[1].split(";").map((p) => p.trim()).filter(Boolean);
  const mimeType = (params[0] && params[0].includes("/") ? params[0] : "text/plain").toLowerCase();
  if (!IMAGE_MIME.test(mimeType)) return null;
  const isBase64 = params.some((p) => p.toLowerCase() === "base64");
  let payload = m[2];
  try {
    if (/%[0-9a-f]{2}/i.test(payload)) payload = decodeURIComponent(payload);
  } catch {
    return null;
  }
  let data: Buffer;
  if (isBase64) {
    let b64 = payload.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (!/^[A-Za-z0-9+/]+$/.test(b64)) return null;
    if (b64.length % 4 === 1) return null; // cannot be valid base64
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    data = Buffer.from(b64, "base64");
  } else {
    // Non-base64 data URIs are only plausible for SVG.
    data = Buffer.from(payload, "utf8");
  }
  if (data.length < 16) return null;
  return { mimeType, data };
}

/**
 * Find every inline image referenced in an article's HTML body, in document
 * order (so the reply's own images come before those in the quoted chain).
 *
 * `attachments` is the article's attachment list (used to resolve `cid:`
 * references and to name images). References to another ticket are ignored;
 * references to another article of the same ticket are kept (the download
 * path carries that article id). Decorative images are skipped, as are
 * remote http(s) images (tracking pixels and hot-linked logos).
 */
export function extractInlineImages(
  html: string | null | undefined,
  ticketId: number,
  articleId: number,
  attachments: InlineAttachmentLike[] = [],
): InlineImageRef[] {
  if (!html) return [];
  const out: InlineImageRef[] = [];
  const seenAtt = new Set<string>();
  const seenData = new Set<string>();
  const byCid = new Map<string, InlineAttachmentLike>();
  const byId = new Map<number, InlineAttachmentLike>();
  for (const att of attachments) {
    byId.set(att.id, att);
    const cid = attachmentContentId(att);
    if (cid) byCid.set(cid, att);
  }

  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const tag = m[0];
    const src = imgSrc(tag);
    if (!src) continue;
    if (isDecorativeImage(tag)) continue;

    const ref = /\/api\/v1\/ticket_attachment\/(\d+)\/(\d+)\/(\d+)/.exec(src);
    if (ref) {
      const t = Number(ref[1]);
      const a = Number(ref[2]);
      const id = Number(ref[3]);
      if (t !== ticketId) continue; // never pull another ticket's files
      const key = `${a}/${id}`;
      if (seenAtt.has(key)) continue;
      seenAtt.add(key);
      out.push({
        kind: "attachment",
        ticketId: t,
        articleId: a,
        attachmentId: id,
        filename: a === articleId ? byId.get(id)?.filename : undefined,
      });
      continue;
    }

    if (/^cid:/i.test(src)) {
      const att = byCid.get(normCid(src.slice(4)));
      if (!att) continue;
      const key = `${articleId}/${att.id}`;
      if (seenAtt.has(key)) continue;
      seenAtt.add(key);
      out.push({ kind: "attachment", ticketId, articleId, attachmentId: att.id, filename: att.filename });
      continue;
    }

    if (/^data:/i.test(src)) {
      const decoded = decodeDataUri(src);
      if (!decoded) continue;
      const key = decoded.data.toString("base64").slice(0, 256) + decoded.data.length;
      if (seenData.has(key)) continue;
      seenData.add(key);
      out.push({ kind: "data", mimeType: decoded.mimeType, data: decoded.data });
    }
  }
  return out;
}

/** Attachment ids referenced inline by the body (any form), for this article. */
export function inlineAttachmentIds(
  html: string | null | undefined,
  ticketId: number,
  articleId: number,
  attachments: InlineAttachmentLike[] = [],
): Set<number> {
  const ids = new Set<number>();
  if (!html) return ids;
  const byCid = new Map<string, number>();
  for (const att of attachments) {
    const cid = attachmentContentId(att);
    if (cid) byCid.set(cid, att.id);
  }
  const imgRe = /<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const src = imgSrc(m[0]);
    if (!src) continue;
    const ref = /\/api\/v1\/ticket_attachment\/(\d+)\/(\d+)\/(\d+)/.exec(src);
    if (ref && Number(ref[1]) === ticketId && Number(ref[2]) === articleId) ids.add(Number(ref[3]));
    if (/^cid:/i.test(src)) {
      const id = byCid.get(normCid(src.slice(4)));
      if (id !== undefined) ids.add(id);
    }
  }
  return ids;
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/avif": "avif",
  "image/tiff": "tiff",
};

export function extensionForMime(mime: string): string | null {
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_EXT[base] ?? null;
}

/** True for HEIC/HEIF images, which Discord cannot display inline. */
export function isHeic(filename: string, contentType?: string): boolean {
  return /\.(heic|heif)$/i.test(filename) || /^image\/hei[cf]/i.test(contentType ?? "");
}
