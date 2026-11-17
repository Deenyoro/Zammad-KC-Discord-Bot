// createScheduledArticle: what the bot asks zammad-kc to send later, per channel.
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { createScheduledArticle } = await import("../src/services/zammad.js");

async function capture(fn: () => Promise<unknown>) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers ?? {}, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 5 }), { status: 201, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return calls;
}

test("email: outbound (not internal), subject, to, cc and the scheduling agent", async () => {
  const [c] = await capture(() =>
    createScheduledArticle({ ticket_id: 9, body: "hi", scheduled_at: "2026-11-24T14:00:00Z", article_type: "email",
      to: "a@x.com", cc: "b@x.com", subject: "Opening hours", on_behalf_of: 3 }));
  assert.match(c.url, /\/api\/v1\/kc\/tickets\/9\/scheduled_articles$/);
  assert.equal(c.headers["X-On-Behalf-Of"], "3");
  assert.deepEqual(c.body.article_data, {
    body: "hi", type: "email", sender: "Agent", internal: false, to: "a@x.com", cc: "b@x.com",
    subject: "Opening hours", content_type: "text/html",
  });
  assert.equal(c.body.scheduled_at, "2026-11-24T14:00:00Z");
});

for (const type of ["ringcentral_sms_message", "freepbx_sms_message", "teams_chat_message"]) {
  test(`${type}: outbound with the ticket's routing (no email fields)`, async () => {
    const [c] = await capture(() =>
      createScheduledArticle({ ticket_id: 9, body: "hi", scheduled_at: "2026-11-24T14:00:00Z", article_type: type, to: "+14125550100" }));
    assert.equal(c.body.article_data.type, type);
    assert.equal(c.body.article_data.internal, false);
    assert.equal(c.body.article_data.subject, undefined);
    assert.equal(c.body.article_data.cc, undefined);
  });
}

test("note: stays internal", async () => {
  const [c] = await capture(() =>
    createScheduledArticle({ ticket_id: 9, body: "hi", scheduled_at: "2026-11-24T14:00:00Z", article_type: "note" }));
  assert.equal(c.body.article_data.internal, true);
  assert.equal(c.headers["X-On-Behalf-Of"], undefined);
});
