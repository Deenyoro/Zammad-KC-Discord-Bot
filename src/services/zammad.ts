import { env } from "../util/env.js";
import { logger } from "../util/logger.js";

// ---------------------------------------------------------------
// Types matching Zammad REST API responses
// ---------------------------------------------------------------

export interface ZammadTicket {
  id: number;
  number: string;
  title: string;
  state_id: number;
  state: string;
  priority_id: number;
  priority: string;
  group_id: number;
  group: string;
  owner_id: number;
  customer_id: number;
  customer: string;
  created_at: string;
  updated_at: string;
}

export interface ZammadArticle {
  id: number;
  ticket_id: number;
  sender_id: number;
  sender: string;
  type_id: number;
  type: string;
  subject: string | null;
  from?: string;
  to?: string;
  body: string;
  internal: boolean;
  created_at: string;
  updated_at: string;
  attachments?: ZammadAttachment[];
  preferences?: Record<string, unknown>;
}

export interface ZammadAttachment {
  id: number;
  filename: string;
  size: number;
  preferences: {
    "Content-Type"?: string;
    "Mime-Type"?: string;
  };
}

export interface ZammadUser {
  id: number;
  login: string;
  firstname: string;
  lastname: string;
  email: string;
  phone?: string;
  mobile?: string;
}

// ---------------------------------------------------------------
// API client
// ---------------------------------------------------------------

async function zammadFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${env().ZAMMAD_BASE_URL}/api/v1${path}`;
  const res = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${env().ZAMMAD_API_TOKEN}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, path, body }, "Zammad API error");
    throw new Error(`Zammad API ${res.status}: ${path} — ${body}`);
  }
  return res;
}

// ---------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------

export async function getTicket(ticketId: number): Promise<ZammadTicket> {
  const res = await zammadFetch(`/tickets/${ticketId}?expand=true`);
  return res.json() as Promise<ZammadTicket>;
}

/** Fetch all tickets, paginated. */
export async function getTickets(page = 1, perPage = 100): Promise<ZammadTicket[]> {
  const res = await zammadFetch(
    `/tickets?expand=true&page=${page}&per_page=${perPage}`
  );
  return res.json() as Promise<ZammadTicket[]>;
}

/** Fetch all non-closed tickets by paginating the tickets API. */
export async function getAllOpenTickets(): Promise<ZammadTicket[]> {
  const closedStates = new Set(["closed", "merged", "removed"]);
  const all: ZammadTicket[] = [];
  let page = 1;
  const perPage = 100;

  const MAX_PAGES = 50; // safety limit: 5 000 tickets max
  while (page <= MAX_PAGES) {
    const batch = await getTickets(page, perPage);
    if (batch.length === 0) break;

    for (const ticket of batch) {
      if (!closedStates.has(ticket.state.toLowerCase())) {
        all.push(ticket);
      }
    }

    if (batch.length < perPage) break;
    page++;
  }

  return all;
}

export async function updateTicket(
  ticketId: number,
  data: Partial<Pick<ZammadTicket, "title" | "state_id" | "priority_id" | "owner_id" | "group_id">> & { pending_time?: string }
): Promise<ZammadTicket> {
  const res = await zammadFetch(`/tickets/${ticketId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
  return res.json() as Promise<ZammadTicket>;
}

// ---------------------------------------------------------------
// Articles
// ---------------------------------------------------------------

export async function getArticles(ticketId: number): Promise<ZammadArticle[]> {
  const res = await zammadFetch(`/ticket_articles/by_ticket/${ticketId}?expand=true`);
  return res.json() as Promise<ZammadArticle[]>;
}

export interface ArticleAttachment {
  filename: string;
  data: string;         // base64-encoded
  "mime-type": string;
}

export async function createArticle(data: {
  ticket_id: number;
  body: string;
  subject?: string;
  type?: string;
  sender?: string;
  internal?: boolean;
  content_type?: string;
  to?: string;
  from?: string;
  origin_by_id?: number;
  attachments?: ArticleAttachment[];
  preferences?: Record<string, unknown>;
}): Promise<ZammadArticle> {
  const res = await zammadFetch("/ticket_articles", {
    method: "POST",
    body: JSON.stringify({
      type: "note",
      sender: "Agent",
      internal: false,
      content_type: "text/plain",
      ...data,
      preferences: {
        ...data.preferences,
        discord: { synced: true },
      },
    }),
  });
  return res.json() as Promise<ZammadArticle>;
}

/** Download an article attachment as a Buffer. */
export async function downloadAttachment(
  ticketId: number,
  articleId: number,
  attachmentId: number
): Promise<{ data: Buffer; contentType: string; filename: string }> {
  const res = await zammadFetch(
    `/ticket_attachment/${ticketId}/${articleId}/${attachmentId}`
  );
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf, contentType, filename: `attachment_${attachmentId}` };
}

// ---------------------------------------------------------------
// Users
// ---------------------------------------------------------------

export async function getUser(userId: number): Promise<ZammadUser> {
  const res = await zammadFetch(`/users/${userId}`);
  return res.json() as Promise<ZammadUser>;
}

export async function searchUsers(query: string): Promise<ZammadUser[]> {
  const res = await zammadFetch(`/users/search?query=${encodeURIComponent(query)}&limit=10`);
  return res.json() as Promise<ZammadUser[]>;
}

/**
 * Find a Zammad user by exact email match.
 * Tries Elasticsearch search first, falls back to paginated user list
 * (handles broken/missing Elasticsearch).
 */
export async function findUserByEmail(email: string): Promise<ZammadUser | undefined> {
  const lowerEmail = email.toLowerCase();

  // Try search endpoint first (fast when ES is working)
  try {
    const results = await searchUsers(email);
    const match = results.find((u) => u.email.toLowerCase() === lowerEmail);
    if (match) return match;
  } catch {
    // ES may be down — fall through to pagination
  }

  // Fallback: paginate through all users (capped at 50 pages / 5 000 users)
  let page = 1;
  const perPage = 100;
  const MAX_PAGES = 50;
  while (page <= MAX_PAGES) {
    const res = await zammadFetch(`/users?page=${page}&per_page=${perPage}&expand=true`);
    const users = (await res.json()) as ZammadUser[];
    if (users.length === 0) break;

    const match = users.find((u) => u.email.toLowerCase() === lowerEmail);
    if (match) return match;

    if (users.length < perPage) break;
    page++;
  }

  return undefined;
}

// ---------------------------------------------------------------
// Ticket States (for slash commands)
// ---------------------------------------------------------------

export interface ZammadState {
  id: number;
  name: string;
}

let _statesCache: ZammadState[] | null = null;

export async function getStates(): Promise<ZammadState[]> {
  if (_statesCache) return _statesCache;
  const res = await zammadFetch("/ticket_states");
  _statesCache = (await res.json()) as ZammadState[];
  return _statesCache;
}

export async function getStateByName(name: string): Promise<ZammadState | undefined> {
  const states = await getStates();
  return states.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

// ---------------------------------------------------------------
// Time Accounting
// ---------------------------------------------------------------

export async function addTimeAccounting(data: {
  ticket_id: number;
  time_unit: number;
  type_id?: number;
}): Promise<void> {
  await zammadFetch("/ticket_time_accountings", {
    method: "POST",
    body: JSON.stringify(data),
  });
}
