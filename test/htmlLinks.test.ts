// Links in HTML emails reach the thread inline, and message splitting keeps them whole.
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { renderEmailArticle } = await import("../src/services/sync.js");
const { splitMessage } = await import("../src/util/truncate.js");
const { linkToMarkdown, linkSpans, safeCutIndex } = await import("../src/util/htmlLinks.js");

// Shaped like the Claude sign-in email: HTML only, the link only in the button's href.
const MAGIC = "https://claude.ai/magic-link#FAKE-TOKEN-abc123";
const TRACK = "https://url0000.mail.anthropic.com/ls/click?upn=FAKE&amp;x=1";
const signInHtml =
  `<div><h1>Sign in to Claude</h1><p>Click the button below to finish signing in. This link expires in 10 minutes.</p>` +
  `<table><tr><td><a href="${MAGIC}" rel="nofollow noreferrer noopener" target="_blank">Sign in</a></td></tr></table>` +
  `<p>Need a hand? Contact <a href="${TRACK}">Anthropic Support</a>.</p>` +
  `<p><a href="${TRACK}"><img src="https://example.com/logo.png" width="24" height="24"></a></p></div>`;

test("an HTML-only button link appears in the posted text", () => {
  const { content } = renderEmailArticle(signInHtml, "Anthropic (Customer)", "", false, "Your secure link to Claude is here");
  assert.ok(content.includes(`[Sign in](<${MAGIC}>)`), content);
  assert.match(content, /expires in 10 minutes/);
  // Entities in the href are decoded so the link works when clicked.
  assert.ok(content.includes("[Anthropic Support](<https://url0000.mail.anthropic.com/ls/click?upn=FAKE&x=1>)"));
  // Image-only footer icons without alt text add nothing.
  assert.doesNotMatch(content, /logo\.png/);
});

test("link formats: masked, bare address, address-like text, mailto, image alt", () => {
  assert.equal(linkToMarkdown("Sign in", "https://a.example/x"), "[Sign in](<https://a.example/x>)");
  assert.equal(linkToMarkdown("https://a.example/x", "https://a.example/x"), "<https://a.example/x>");
  assert.equal(linkToMarkdown("a.example/x", "https://a.example/x/"), "<https://a.example/x/>");
  // Discord won't show a masked link whose text is a different address: show both.
  assert.equal(linkToMarkdown("claude.ai", "https://track.example/c?u=1"), "claude.ai: <https://track.example/c?u=1>");
  assert.equal(linkToMarkdown("dean@kawaconnect.com", "mailto:dean@kawaconnect.com"), "dean@kawaconnect.com");
  assert.equal(linkToMarkdown("", "mailto:x@y.example?subject=hi"), "x@y.example");
  assert.equal(linkToMarkdown("", "https://a.example/pixel"), "");
  assert.equal(linkToMarkdown("Open [beta]", "https://a.example"), "[Open (beta)](<https://a.example>)");
  const { content } = renderEmailArticle(
    `<p><a href="https://a.example/go"><img src="x.png" alt="Get started"></a></p>`,
    "X", "", false, "Hi",
  );
  assert.ok(content.includes("[Get started](<https://a.example/go>)"));
});

test("anchor text with markup and the old tag stripping don't break the link", () => {
  const { content } = renderEmailArticle(
    `<p>Go: <a href="https://a.example/p?x=1&amp;y=2"><b>Open</b> <span>the&nbsp;portal</span></a> now</p>`,
    "X", "", false, "Hi",
  );
  assert.ok(content.includes("Go: [Open the portal](<https://a.example/p?x=1&y=2>) now"), content);
});

test("long-message split keeps links whole", () => {
  const url = (i: number) => `https://url0000.mail.anthropic.com/ls/click?upn=${"A".repeat(380)}${i}`;
  const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} text text [Link ${i}](<${url(i)}>) more text`).join(" ");
  const chunks = splitMessage(text, 2000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 2000);
    // Every "[" that starts a link in a chunk is completed in that chunk.
    const opens = (c.match(/\[Link \d+\]/g) ?? []).length;
    const whole = (c.match(/\[Link \d+\]\(<https:\/\/[^>]+>\)/g) ?? []).length;
    assert.equal(whole, opens, `link cut in chunk: ${c.slice(-80)}`);
    assert.doesNotMatch(c, /^[A-Z]{5,}/, "chunk starts inside a URL");
  }
  assert.equal(chunks.join(" ").match(/\[Link \d+\]\(<[^>]+>\)/g)?.length, 12);
});

test("split never cuts a bare URL either", () => {
  const long = `https://example.com/${"x".repeat(600)}`;
  const text = `${"word ".repeat(300)}${long} tail`;
  const chunks = splitMessage(text, 2000);
  assert.ok(chunks.some((c) => c.includes(long)));
});

test("a single link longer than a message is still hard-split (no infinite loop)", () => {
  const huge = `<https://example.com/${"y".repeat(2500)}>`;
  const chunks = splitMessage(huge, 2000);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(""), huge);
});

test("safeCutIndex moves a cut out of a link", () => {
  const t = "abc [Sign in](<https://a.example/x>) def";
  const [[s, e]] = linkSpans(t);
  assert.equal(safeCutIndex(t, s + 5), s);
  assert.equal(safeCutIndex(t, e), e);
  assert.equal(safeCutIndex(t, 2), 2);
});

test("quoted context behind the spoiler is truncated before a link, not inside it", () => {
  const filler = "Earlier message text. ".repeat(34); // ~750 chars
  const html =
    `<p>Thanks!</p><blockquote>On Mon, Pat wrote:<br>${filler}` +
    `<a href="https://a.example/${"z".repeat(200)}">Old link</a> end</blockquote>`;
  const { content } = renderEmailArticle(html, "Pat (Customer)", "", false, "Re: hi");
  assert.ok(content.includes("||"), "context goes behind a spoiler");
  const spoiler = content.slice(content.indexOf("||") + 2);
  const opens = (spoiler.match(/\[Old link\]/g) ?? []).length;
  const whole = (spoiler.match(/\[Old link\]\(<[^>]+>\)/g) ?? []).length;
  assert.equal(whole, opens);
  // No half URL left behind.
  assert.ok(!/https:\/\/a\.example\/z+…/.test(spoiler));
});
