// Which Zammad articles reach the Discord thread. Shapes follow a real SMS
// ticket: KC "Call activity" notes are internal, System-sender notes with
// from "-", which the sync used to drop.
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { classifyArticle, articleSenderLabel } = await import("../src/services/sync.js");

const callActivity = { type: "note", sender: "System", internal: true, from: "-", subject: "Call activity" };
const context = { type: "note", sender: "System", internal: true, from: "-", subject: "Conversation context" };
const smsIn = { type: "ringcentral_sms_message", sender: "Customer", internal: false, from: "+15550100", subject: null };
const agentNote = { type: "note", sender: "Agent", internal: true, from: "Pat Agent", subject: null };
const monitorNote = { type: "note", sender: "System", internal: true, from: "-", subject: "API health check failure detected" };
const autoReply = { type: "email", sender: "System", internal: false, from: "Support <support@example.com>", subject: "Thanks for your email" };

test("every note is posted: System and Agent, internal or not", () => {
  assert.equal(classifyArticle(callActivity), "post");
  assert.equal(classifyArticle(monitorNote), "post");
  assert.equal(classifyArticle(agentNote), "post");
  assert.equal(classifyArticle({ ...agentNote, internal: false }), "post");
  assert.equal(classifyArticle(smsIn), "post");
});

test("the integrations' conversation-context note keeps its own rendering", () => {
  assert.equal(classifyArticle(context), "context");
});

test("System-sender non-note articles (trigger auto-replies) are skipped", () => {
  assert.equal(classifyArticle(autoReply), "skip");
});

test("sender labels: System notes show their subject, '-' is not a name", () => {
  assert.equal(articleSenderLabel(callActivity), "System (Call activity)");
  assert.equal(articleSenderLabel(agentNote), "Pat Agent (Agent)");
  assert.equal(articleSenderLabel({ sender: "Customer", from: "Jo Doe <jo@example.com>" }), "Jo Doe (Customer)");
  assert.equal(articleSenderLabel({ sender: "Customer", from: "jo@example.com" }), "Customer");
  assert.equal(articleSenderLabel({ sender: "System", from: "-", subject: null }), "System");
});
