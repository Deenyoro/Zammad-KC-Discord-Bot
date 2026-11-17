import { test } from "node:test";
import assert from "node:assert/strict";
import { buildThreadName, listNeedsVerification, ownerUnknown } from "../src/services/threads.js";

// 2026-11-17: ticket #188506 was assigned to Alana; the webhook named the thread "👤AlanaO.", the periodic sync read
// the lagging ticket list (still unassigned) and renamed it back, every few minutes.
const base = { listState: "open", storedState: "open", listTitle: "POSTIZ: Add socials", storedTitle: "POSTIZ: Add socials" };

test("a list that would drop the owner from the thread name is verified first", () => {
  const current = buildThreadName("188506", "POSTIZ: Add socials", "AlanaO.");
  const fromList = buildThreadName("188506", "POSTIZ: Add socials", undefined);
  assert.equal(listNeedsVerification({ ...base, currentThreadName: current, nameFromList: fromList }), true);
});

test("a list that would add or change the owner is verified first", () => {
  const fromList = buildThreadName("188506", "POSTIZ: Add socials", "RomeoM.");
  assert.equal(listNeedsVerification({ ...base, currentThreadName: buildThreadName("188506", "POSTIZ: Add socials"), nameFromList: fromList }), true);
  assert.equal(listNeedsVerification({ ...base, currentThreadName: buildThreadName("188506", "POSTIZ: Add socials", "AlanaO."), nameFromList: fromList }), true);
});

test("no extra read when the list agrees with the thread", () => {
  const name = buildThreadName("188506", "POSTIZ: Add socials", "AlanaO.");
  assert.equal(listNeedsVerification({ ...base, currentThreadName: name, nameFromList: name }), false);
  assert.equal(listNeedsVerification({ ...base, currentThreadName: undefined, nameFromList: name }), false); // archived/unreadable
});

test("state or title disagreement still verifies", () => {
  const name = buildThreadName("1", "t");
  assert.equal(listNeedsVerification({ ...base, listState: "new", currentThreadName: name, nameFromList: name }), true);
  assert.equal(listNeedsVerification({ ...base, listTitle: "other", currentThreadName: name, nameFromList: name }), true);
});

test("an owner whose name could not be read is unknown, not unassigned", () => {
  assert.equal(ownerUnknown({ owner_id: 1675, owner: undefined }), true);
  assert.equal(ownerUnknown({ owner_id: 1675, owner: "Alana Oliveira" }), false);
  assert.equal(ownerUnknown({ owner_id: 1, owner: undefined }), false);
  assert.equal(ownerUnknown({ owner_id: 0 }), false);
});
