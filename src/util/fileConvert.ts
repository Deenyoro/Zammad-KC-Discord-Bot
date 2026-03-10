/**
 * File conversion utilities for attachment processing.
 *
 * Image conversions (sharp): webp, jpg, jpeg, gif, bmp, tiff, avif → png
 * Document conversions (LibreOffice headless): docx, doc, odt, xlsx, xls, ods, pptx, ppt, odp → pdf
 *
 * Both tools are optional — if unavailable the file is passed through unchanged.
 */

import { execFile } from "node:child_process";
import { writeFile, readFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "./logger.js";

// Extensions that can be converted to PNG (via sharp)
const IMAGE_TO_PNG = new Set(["webp", "jpg", "jpeg", "gif", "bmp", "tiff", "tif", "avif"]);

// Extensions that can be converted to PDF (via LibreOffice)
const DOC_TO_PDF = new Set(["docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "ppt", "odp"]);

export type ConvertTarget = "png" | "pdf";

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function replaceExtension(filename: string, newExt: string): string {
  const dot = filename.lastIndexOf(".");
  const base = dot >= 0 ? filename.slice(0, dot) : filename;
  return `${base}.${newExt}`;
}

/**
 * Check if a file can be converted to the given target format.
 */
export function canConvert(filename: string, target: ConvertTarget): boolean {
  const ext = getExtension(filename);
  if (target === "png") return IMAGE_TO_PNG.has(ext);
  if (target === "pdf") return DOC_TO_PDF.has(ext);
  return false;
}

/**
 * Convert a file buffer to the target format.
 * Returns the converted buffer, new filename, and new mime type.
 * If the file is not convertible, returns null (caller should use original).
 */
export async function convertFile(
  buf: Buffer,
  filename: string,
  target: ConvertTarget,
): Promise<{ data: Buffer; filename: string; mimeType: string } | null> {
  const ext = getExtension(filename);

  if (target === "png" && IMAGE_TO_PNG.has(ext)) {
    return convertImageToPng(buf, filename);
  }

  if (target === "pdf" && DOC_TO_PDF.has(ext)) {
    return convertDocToPdf(buf, filename);
  }

  return null; // Not applicable — caller uses original
}

async function convertImageToPng(
  buf: Buffer,
  filename: string,
): Promise<{ data: Buffer; filename: string; mimeType: string } | null> {
  try {
    // Dynamic import — sharp is optional
    const sharp = (await import("sharp")).default;
    const pngBuf = await sharp(buf).png().toBuffer();
    return {
      data: Buffer.from(pngBuf),
      filename: replaceExtension(filename, "png"),
      mimeType: "image/png",
    };
  } catch (err: any) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" || err?.code === "MODULE_NOT_FOUND") {
      logger.debug("sharp not installed — skipping image conversion");
    } else {
      logger.warn({ err, filename }, "Image conversion to PNG failed");
    }
    return null;
  }
}

async function convertDocToPdf(
  buf: Buffer,
  filename: string,
): Promise<{ data: Buffer; filename: string; mimeType: string } | null> {
  let tmpDir: string | null = null;
  try {
    tmpDir = await mkdtemp(join(tmpdir(), "convert-"));
    const inputPath = join(tmpDir, filename);
    await writeFile(inputPath, buf);

    await new Promise<void>((resolve, reject) => {
      execFile(
        "libreoffice",
        ["--headless", "--convert-to", "pdf", "--outdir", tmpDir!, inputPath],
        { timeout: 30_000 },
        (err, _stdout, stderr) => {
          if (err) return reject(new Error(`LibreOffice failed: ${stderr || err.message}`));
          resolve();
        },
      );
    });

    const pdfFilename = replaceExtension(filename, "pdf");
    const pdfPath = join(tmpDir, pdfFilename);
    const pdfBuf = await readFile(pdfPath);

    return {
      data: Buffer.from(pdfBuf),
      filename: pdfFilename,
      mimeType: "application/pdf",
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      logger.debug("LibreOffice not installed — skipping document conversion");
    } else {
      logger.warn({ err, filename }, "Document conversion to PDF failed");
    }
    return null;
  } finally {
    // Best-effort cleanup
    if (tmpDir) {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }
}
