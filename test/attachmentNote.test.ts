import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentNote } from "../src/events/messageCreate.js";

// 2026-11-12: Zammad refuses an empty body, so picture-only Discord messages never reached the ticket.
test("picture-only message gets a body naming the files", () => {
  assert.equal(attachmentNote(["image.png"], [], true, false), "Attached from Discord: image.png");
});

test("text message with pictures adds nothing", () => {
  assert.equal(attachmentNote(["a.png"], [], false, false), "");
});

test("files not copied are always named", () => {
  const n = attachmentNote([], ["plan.pdf (15.8 MB, over the per-file limit)"], false, false);
  assert.match(n, /Not copied from Discord .*plan\.pdf \(15\.8 MB/);
  assert.match(attachmentNote(["x.png"], ["big.zip (download failed)"], true, true), /<p><em>Attached from Discord: x\.png<\/em><\/p><p><em>Not copied/);
});
