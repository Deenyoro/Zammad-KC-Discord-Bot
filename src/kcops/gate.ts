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
  | { kind: "link"; discord_id: string; url: string; minutes: number }
  | { kind: "denied"; discord_id: string }
  | { kind: "refused"; code: string; reason: string };

export type OwnerResult = { ok: true; text: string } | { kind: "refused"; code: string; reason: string };

export interface OutboxItem {
  id: number;
  target: "owner" | "user" | "audit" | "channel";
  discord_id: string | null;
  kind: string;
  text: string;
  payload: Record<string, unknown>;
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
  access: (b: { discord_id: string; channel_id: string; is_member: boolean; minutes: number | null }) =>
    call<AccessResult>("POST", "/internal/access", b),
  decision: (b: { request_id: number; actor_id: string; channel_id: string; minutes: number | null }) =>
    call<DecisionResult>("POST", "/internal/decision", b),
  owner: (b: { command: string; actor_id: string; channel_id: string; target_id?: string; days?: number | null; minutes?: number | null; route?: string | null; chat?: string }) =>
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
