// The first line of every Zammad article posted to Discord: how it was sent
// and who it went to.
//
//   -# 📧 Email from jane@example.com → To: support@example.com · Cc: bob@example.com
//   -# 💬 SMS (RingCentral) → Jane Smith (+14125550100)
//   -# 💼 Teams → Group chat "Office move" (Ann Lee, Bob Ray)
//   -# 🔒 Internal note · not sent to anyone
//
// Zammad (KC fork 0.0.8+) fills `to` for Teams, SMS and missed-call articles
// with names and numbers. Older articles fall back to the numbers stored in
// the article preferences.

export interface HeaderArticle {
  type?: string;
  sender?: string;
  internal?: boolean;
  from?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  preferences?: Record<string, unknown> | null;
}

const MAX_FIELD = 300;

const TYPE_LABELS: Record<string, string> = {
  email: "📧 Email",
  phone: "📞 Phone",
  web: "🌐 Web form",
  sms: "💬 SMS",
  chat: "💬 Chat",
  fax: "📠 Fax",
  ringcentral_sms_message: "💬 SMS (RingCentral)",
  freepbx_sms_message: "💬 SMS (FreePBX)",
  teams_chat_message: "💼 Teams",
  "telegram personal-message": "✈️ Telegram",
  "whatsapp message": "💬 WhatsApp",
  "facebook direct-message": "💬 Facebook message",
  "facebook feed post": "💬 Facebook post",
  "facebook feed comment": "💬 Facebook comment",
  "twitter status": "💬 X post",
  "twitter direct-message": "💬 X message",
};

function prefsAt(prefs: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> {
  const v = prefs?.[key];
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Discord-safe single line: markdown neutralised, newlines folded, capped. */
export function cleanField(value: string | null | undefined): string {
  if (!value) return "";
  let s = value.replace(/\s+/g, " ").trim();
  if (s.length > MAX_FIELD) s = s.slice(0, MAX_FIELD).trimEnd() + "…";
  return s.replace(/([\\*_`~|[\]<>])/g, "\\$1");
}

/** "jane@example.com" from "Jane Doe <jane@example.com>"; else the value. */
function emailAddress(from: string | null | undefined): string {
  if (!from) return "";
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim();
}

function phoneList(values: unknown): string {
  const list = (Array.isArray(values) ? values : [values])
    .filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return [...new Set(list)].join(", ");
}

/**
 * Who an SMS/Teams article went to when Zammad did not record a `to`
 * (articles from before the KC recipient fill).
 */
function fallbackRecipient(article: HeaderArticle): string {
  const p = article.preferences ?? {};
  for (const key of ["ringcentral_sms", "freepbx_sms"]) {
    const sms = prefsAt(p, key);
    const list = phoneList(sms.to_phones) || phoneList(sms.to_phone);
    if (list) return list;
  }
  for (const key of ["ringcentral_missed_call", "freepbx_missed_call"]) {
    const call = prefsAt(p, key);
    if (typeof call.to_phone === "string" && call.to_phone) return call.to_phone;
  }
  if (article.type === "teams_chat_message" || prefsAt(p, "teams_chat").chat_id) {
    return article.sender === "Agent" ? "the customer's Teams chat" : "our Teams account";
  }
  return "";
}

function isMissedCall(article: HeaderArticle): boolean {
  const p = article.preferences ?? {};
  return Boolean(p.ringcentral_missed_call || p.freepbx_missed_call);
}

/** Sent from the Teams/RingCentral/FreePBX app itself, captured as a note. */
function captureChannel(article: HeaderArticle): string | null {
  const p = article.preferences ?? {};
  if (prefsAt(p, "teams_chat").outbound_capture) return "💼 Teams (sent in Teams)";
  if (prefsAt(p, "ringcentral_sms").outbound_capture) return "💬 SMS (sent in RingCentral)";
  if (prefsAt(p, "freepbx_sms").outbound_capture) return "💬 SMS (sent from the phone system)";
  return null;
}

/** The `-# …` subtext line shown above an article in Discord. */
export function articleHeader(article: HeaderArticle): string {
  const type = article.type ?? "";
  const to = cleanField(article.to) || cleanField(fallbackRecipient(article));

  if (type === "email") {
    const parts: string[] = [];
    const from = cleanField(emailAddress(article.from));
    parts.push(`To: ${to || "(no recipient)"}`);
    const cc = cleanField(article.cc);
    if (cc) parts.push(`Cc: ${cc}`);
    const bcc = cleanField(article.bcc);
    if (bcc) parts.push(`Bcc: ${bcc}`);
    return `-# 📧 Email${from ? ` from ${from}` : ""} → ${parts.join(" · ")}`;
  }

  const capture = captureChannel(article);
  if (capture) return `-# ${capture} → ${to || "(recipient unknown)"}`;

  if (isMissedCall(article)) {
    return `-# 📞 Missed call${to ? ` to ${to}` : ""}`;
  }

  if (type === "note") {
    return article.internal
      ? "-# 🔒 Internal note · not sent to anyone"
      : "-# 📝 Note · visible to the customer in Zammad, not sent";
  }

  const label = TYPE_LABELS[type] ?? `✉️ ${cleanField(type) || "Message"}`;
  return `-# ${label} → ${to || "(recipient unknown)"}`;
}
