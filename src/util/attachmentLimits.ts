import { getSettingOrEnv } from "../db/index.js";

/** Default attachment limits (used when no setting/env override exists). */
const DEFAULTS = {
  /** Max size per file in MB before linking instead of downloading (Zammad→Discord). */
  perFileMb: 5,
  /** Max total download bytes per article in MB (Zammad→Discord). */
  totalMb: 24,
  /** Max number of files uploaded to Discord per article. */
  maxCount: 10,
  /** Hard cap on single attachment download in MB (safety net in zammad.ts). */
  downloadCapMb: 8,
};

function readMb(key: string, fallback: number): number {
  const raw = getSettingOrEnv(key);
  if (raw === undefined) return fallback;
  const val = Number(raw);
  return Number.isFinite(val) && val > 0 ? val : fallback;
}

function readInt(key: string, fallback: number): number {
  const raw = getSettingOrEnv(key);
  if (raw === undefined) return fallback;
  const val = parseInt(raw, 10);
  return Number.isFinite(val) && val > 0 ? val : fallback;
}

export function getAttachmentLimits() {
  const perFileMb = readMb("ATTACHMENT_PER_FILE_MB", DEFAULTS.perFileMb);
  const totalMb = readMb("ATTACHMENT_TOTAL_MB", DEFAULTS.totalMb);
  const maxCount = readInt("ATTACHMENT_MAX_COUNT", DEFAULTS.maxCount);
  const downloadCapMb = readMb("ATTACHMENT_DOWNLOAD_CAP_MB", DEFAULTS.downloadCapMb);

  return {
    perFileBytes: perFileMb * 1024 * 1024,
    totalBytes: totalMb * 1024 * 1024,
    maxCount,
    downloadCapBytes: downloadCapMb * 1024 * 1024,
    // Raw MB values for display
    perFileMb,
    totalMb,
    downloadCapMb,
  };
}
