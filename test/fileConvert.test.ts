// Exercises the sharp-backed image conversion used by /reply and /newticket
// attachments, so a sharp upgrade that breaks decoding/encoding is caught.
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "fatal";

import { test } from "node:test";
import assert from "node:assert/strict";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const { canConvert, convertFile } = await import("../src/util/fileConvert.js");
const sharp = (await import("sharp")).default;

test("canConvert matches extensions case-insensitively", () => {
  assert.equal(canConvert("photo.WEBP", "png"), true);
  assert.equal(canConvert("photo.jpg", "png"), true);
  assert.equal(canConvert("photo.png", "png"), false);
  assert.equal(canConvert("report.docx", "pdf"), true);
  assert.equal(canConvert("report.docx", "png"), false);
  assert.equal(canConvert("noextension", "png"), false);
});

for (const format of ["webp", "jpeg", "gif", "tiff", "avif"] as const) {
  test(`convertFile converts ${format} to png`, async () => {
    const input = await sharp({
      create: { width: 8, height: 6, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .toFormat(format)
      .toBuffer();

    const ext = format === "jpeg" ? "jpg" : format;
    const out = await convertFile(input, `image.${ext}`, "png");
    assert.ok(out, "expected a conversion result");
    assert.equal(out.filename, "image.png");
    assert.equal(out.mimeType, "image/png");
    assert.deepEqual(out.data.subarray(0, 8), PNG_MAGIC);
    const meta = await sharp(out.data).metadata();
    assert.equal(meta.width, 8);
    assert.equal(meta.height, 6);
  });
}

test("convertFile returns null for corrupt image data instead of throwing", async () => {
  const out = await convertFile(Buffer.from("not an image"), "broken.webp", "png");
  assert.equal(out, null);
});

test("convertFile returns null when the target does not apply", async () => {
  const out = await convertFile(Buffer.from("x"), "file.txt", "png");
  assert.equal(out, null);
});

test("convertFile returns null for BMP (listed in IMAGE_TO_PNG but not decodable by sharp)", async () => {
  // Minimal 1x1 24-bit BMP. sharp/libvips has no BMP loader, so the upload
  // must fall back to the original file rather than throwing.
  const bmp = Buffer.from(
    "424d3a0000000000000036000000280000000100000001000000010018000000000004000000130b0000130b00000000000000000000ff000000",
    "hex",
  );
  const out = await convertFile(bmp, "image.bmp", "png");
  assert.equal(out, null);
});

// Mirrors the SVG shape produced by renderStatusBoardPng in
// src/commands/ticket.ts: a dark background, a status dot and <text> set in
// DejaVu Sans, which goes through librsvg/pango text rendering.
test("sharp renders status-board style SVG with text to PNG", async () => {
  const width = 200;
  const height = 40;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#2f3136" rx="8"/>
  <circle cx="10" cy="20" r="5" fill="#2ecc71"/>
  <text x="24" y="26" fill="#ffffff" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold">Status HHHH</text>
</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  assert.deepEqual(png.subarray(0, 8), PNG_MAGIC);
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);

  // Count bright pixels inside the text region only (x >= 24, right of the dot).
  // The background is #2f3136, so any near-white pixel there is rendered glyph.
  const { data, info } = await sharp(png)
    .extract({ left: 24, top: 0, width: width - 24, height })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let bright = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) bright++;
  }
  assert.ok(bright > 20, `expected rendered text pixels, found ${bright}`);
});
