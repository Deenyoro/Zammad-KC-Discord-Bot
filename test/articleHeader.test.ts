// The "how it was sent and to whom" line above each article in Discord, and
// forwarded emails keeping their forwarded content.
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { articleHeader } = await import("../src/util/articleHeader.js");
const { renderEmailArticle } = await import("../src/services/sync.js");
const { isForwardedEmail } = await import("../src/util/emailSplit.js");

test("email shows sender address, To and Cc", () => {
  const h = articleHeader({
    type: "email", sender: "Customer", from: "Jane Doe <jane@example.com>",
    to: "support@example.com", cc: "bob@example.com, ann@example.com",
  });
  assert.equal(h, "-# 📧 Email from jane@example.com → To: support@example.com · Cc: bob@example.com, ann@example.com");
});

test("email with Bcc lists it; with no To says so", () => {
  assert.match(articleHeader({ type: "email", to: "a@example.com", bcc: "c@example.com" }), /· Bcc: c@example\.com$/);
  assert.match(articleHeader({ type: "email", to: "" }), /To: \(no recipient\)/);
});

test("SMS shows the contact name and number Zammad recorded", () => {
  const h = articleHeader({ type: "ringcentral_sms_message", sender: "Agent", to: "Jane Smith (+14125550100)" });
  assert.equal(h, "-# 💬 SMS (RingCentral) → Jane Smith (+14125550100)");
});

test("older SMS articles fall back to the stored numbers", () => {
  const h = articleHeader({
    type: "freepbx_sms_message", sender: "Agent", to: "",
    preferences: { freepbx_sms: { to_phones: ["+14125550100", "+14125550111"] } },
  });
  assert.equal(h, "-# 💬 SMS (FreePBX) → +14125550100, +14125550111");
});

test("Teams group chats name the chat and members", () => {
  const h = articleHeader({ type: "teams_chat_message", sender: "Agent", to: 'Group chat "Office move" (Ann Lee, Bob Ray)' });
  assert.equal(h, '-# 💼 Teams → Group chat "Office move" (Ann Lee, Bob Ray)');
});

test("messages sent outside Zammad and captured as notes show their channel", () => {
  const h = articleHeader({
    type: "note", sender: "Agent", internal: true, to: "Jane Smith (+14125550100)",
    preferences: { ringcentral_sms: { outbound_capture: true } },
  });
  assert.equal(h, "-# 💬 SMS (sent in RingCentral) → Jane Smith (+14125550100)");
});

test("notes and missed calls", () => {
  assert.equal(articleHeader({ type: "note", internal: true }), "-# 🔒 Internal note · not sent to anyone");
  assert.equal(
    articleHeader({ type: "note", sender: "Customer", preferences: { ringcentral_missed_call: { to_phone: "+14125559999" } } }),
    "-# 📞 Missed call to +14125559999",
  );
});

test("recipient text cannot inject markdown", () => {
  const h = articleHeader({ type: "email", to: "*bold* [x](http://e.example) a_b@example.com" });
  assert.ok(!/(^|[^\\])\*bold/.test(h));
  assert.ok(h.includes("\\[x\\]"));
});

// Outlook's "forward with no comment" shape: an empty &nbsp; line, <hr>, then
// a bold From/Sent header. The bot used to treat everything below as a quoted
// chain and hide it behind an 800-character spoiler.
const forwardBody =
  "<div>&nbsp;</div><hr><div><span class=\"js-signatureMarker\"></span><div><b>From:</b> Vendor &lt;v@example.com&gt;<br>" +
  "<b>Sent:</b> Monday<br><b>To:</b> Ops<br><b>Subject:</b> Network requirements</div><div>" +
  "Allow outbound TCP 443 to the cloud. ".repeat(40) + "Port 5671 for AMQP. END-OF-FORWARD</div></div>";

test("forwards are detected by subject or banner", () => {
  assert.ok(isForwardedEmail("Fw: Networking", ""));
  assert.ok(isForwardedEmail("RE: FWD: thing", ""));
  assert.ok(isForwardedEmail(null, "---------- Forwarded message ---------"));
  assert.ok(!isForwardedEmail("Re: hello", "<p>hi</p>"));
});

test("a forwarded email is posted whole, on both sync paths", () => {
  for (const stripQuotes of [false, true]) {
    const { content } = renderEmailArticle(forwardBody, "Jane (Customer)", "", stripQuotes, "Fw: Networking");
    assert.ok(content.includes("END-OF-FORWARD"), `stripQuotes=${stripQuotes}`);
    assert.ok(!content.includes("||"));
  }
});

test("an &nbsp;-only line above a quote no longer counts as a reply", () => {
  const { content } = renderEmailArticle(forwardBody, "Jane (Customer)", "", false, "Networking");
  assert.ok(content.includes("END-OF-FORWARD"));
});
