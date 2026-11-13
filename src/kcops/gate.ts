/**
 * Client for the kc-ops gate's internal API. The gate decides everything; this only relays what happened
 * in Discord. Responses can contain a one-time sign-in link: never log them.
 */
import { env } from "../util/env.js";

export type AccessResult =
  | { kind: "link"; url: string; minutes: number }
  | { kind: "pending_owner"; request_id: number; minutes: number; asked: number | null }
  | { kind: "refused"; code: string; reason: string };

export type DecisionResult =
  | { kind: "link"; discord_id: string; url: string; minutes: number; request_id?: number }
  | { kind: "denied"; discord_id: string; notified?: boolean }
  | { kind: "refused"; code: string; reason: string };

export type LinkResult = { kind: "link"; url: string; minutes: number } | { kind: "refused"; code: string; reason: string };

/** A message queued for one person, fetched when that person presses "Show details". */
export type NoticeResult =
  | { kind: "notice"; item_kind: string; text: string; payload: Record<string, unknown> }
  | { kind: "refused"; code: string; reason: string };

export type OwnerResult = { ok: true; text: string } | { kind: "refused"; code: string; reason: string };

export interface OutboxItem {
  id: number;
  target: "owner" | "user" | "audit" | "channel";
  discord_id: string | null;
  kind: string;
  text: string;
  payload: Record<string, unknown>;
  /** Seconds since the gate queued it: a failed delivery is retried until it is too old to matter. */
  age?: number;
  /** How the gate wants it delivered; "dm" only ever for the owner. */
  deliver?: "dm" | "private" | "channel";
}

export function kcopsEnabled(): boolean {
  const e = env();
  return Boolean(e.KCOPS_GATE_URL && e.KCOPS_GATE_TOKEN && e.KCOPS_OWNER_USER_ID);
}

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
export function setFetchForTests(f: Fetch): void {
  fetchImpl = f;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const e = env();
  const res = await fetchImpl(new URL(path, e.KCOPS_GATE_URL).toString(), {
    method,
    headers: { authorization: `Bearer ${e.KCOPS_GATE_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`kc-ops gate ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

export const gate = {
  access: (b: { discord_id: string; channel_id: string; is_member: boolean; minutes: number | null; owner_dm?: boolean }) =>
    call<AccessResult>("POST", "/internal/access", b),
  decision: (b: { request_id: number; actor_id: string; channel_id: string; minutes: number | null }) =>
    call<DecisionResult>("POST", "/internal/decision", b),
  /** "Show my link": a fresh one-time link for the requester of an approved request (the gate checks it is theirs). */
  link: (b: { request_id: number; discord_id: string }) => call<LinkResult>("POST", "/internal/link", b),
  /** "Show details": the text of a message queued for this person (the gate checks it is theirs). */
  notice: (b: { id: number; discord_id: string }) => call<NoticeResult>("POST", "/internal/notice", b),
  owner: (b: { command: string; actor_id: string; channel_id: string; target_id?: string; days?: number | null; minutes?: number | null; route?: string | null; chat?: string;
    approval_id?: string; args_hash?: string; decision?: "approve" | "deny" }) =>
    call<OwnerResult>("POST", "/internal/owner", b),
  loginConfirm: (b: { login_id: number; actor_id: string; answer: "yes" | "no" }) =>
    call<OwnerResult>("POST", "/internal/login-confirm", b),
  sessionExtension: (b: { extension_id: number; actor_id: string; minutes: number | null }) =>
    call<OwnerResult>("POST", "/internal/session-extension", b),
  /** Elevation button press: the gate checks that the presser is the owner and the request is still pending. */
  elevation: (b: { elevation_id: number; actor_id: string; minutes: number | null }) =>
    call<OwnerResult>("POST", "/internal/elevation", b),
  memberLeft: (discord_id: string) => call<{ ok: boolean }>("POST", "/internal/member-left", { discord_id }),
  outbox: () => call<{ items: OutboxItem[]; approval_route?: ApprovalRoute }>("GET", "/internal/outbox"),
  ack: (ids: number[]) => call<{ ok: boolean }>("POST", "/internal/outbox/ack", { ids }),
};

/** Where owner approval prompts go (set by the owner with /kc notify; stored in the gate). */
export type ApprovalRoute = "both" | "channel" | "dm";
