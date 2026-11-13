import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalButtons, parseButton } from "../src/kcops/discord.js";

// 2026-11-13: staff approvals reached Dean as text without buttons; now Approve/Deny on his DM.
test("approval buttons round-trip", () => {
  const id = "0f8b2d9e-1c2a-4b3c-9d8e-7f6a5b4c3d2e";
  const row = approvalButtons(id, "abcdef0123456789ffff").toJSON();
  const ids = row.components.map((c: any) => c.custom_id);
  assert.deepEqual(ids, [`kcops:appr:${id}:abcdef0123456789:a`, `kcops:appr:${id}:abcdef0123456789:d`]);
  assert.deepEqual(parseButton(ids[0]), { type: "appr", approvalId: id, argsHash: "abcdef0123456789", decision: "approve" });
  assert.equal(parseButton(`kcops:appr:not-a-uuid:abcdef012345:a`), null);
});
