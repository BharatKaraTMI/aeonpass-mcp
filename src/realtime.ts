// SignalR chat hub subscriptions.
//
// The Message API's realtime side is a receive-only SignalR hub: it pushes
// `ReceiveMessage` and `MarkMessagesRead`, and exposes no client-callable
// methods. Sending stays on HTTP. MCP has no way to hand an unsolicited push to
// the model, so a subscription buffers what arrives into a ring and a poll tool
// drains it — the connection outlives the tool call that opened it.
//
// **That only works on a host that keeps a process alive.** stdio (Claude Code,
// the desktop app) and a long-running `npm run serve` do; Vercel does not, and
// the tools are not registered there. See `createServer(client, { realtime })`.
//
// Buffered events carry message bodies and contact details. They live in memory
// for the life of the process, are returned only to the key that opened the
// subscription, and are never written to the call log.

import { BASE_URL, type CallLog, logToStderr } from "./api.js";

/** Gateway-prefixed hub path. In-cluster callers would use `/portal/chat`. */
const HUB_PATH = "/api/portal/chat";

const DEFAULT_BUFFER = 200;
const MAX_BUFFER = 2000;

export type HubEventName = "ReceiveMessage" | "MarkMessagesRead";

export interface BufferedEvent {
  /** Monotonic per subscription. The poll cursor. */
  seq: number;
  /** When this process received it, not when the server sent it. */
  ts: string;
  event: HubEventName;
  payload: unknown;
}

export interface SubscriptionStatus {
  scope: "organization" | "contact";
  /** Present on the contact scope only. */
  contactId?: string;
  /** The SignalR group this connection was joined to on connect. */
  group: string;
  /** Connected / Connecting / Reconnecting / Disconnected. */
  state: string;
  connectedAt: string;
  lastEventAt?: string;
  /** Events seen since connect, across reconnects. */
  received: number;
  /** Events evicted by the ring before anything polled them. */
  dropped: number;
  /** Events currently held. */
  buffered: number;
  /** Highest seq handed out by a poll. */
  deliveredThrough: number;
  /**
   * Automatic reconnects so far. Non-zero means a gap is possible: SignalR
   * replays nothing, so events sent while the socket was down were missed.
   * Reconcile with `list_messages` rather than trusting the buffer alone.
   */
  reconnects: number;
  bufferSize: number;
}

interface Subscription {
  hub: any;
  status: SubscriptionStatus;
  events: BufferedEvent[];
  nextSeq: number;
}

/**
 * Live subscriptions, keyed by `sha256(apiKey)` plus scope.
 *
 * Hashed rather than keyed by the raw key so no credential sits in a
 * module-level map, and scoped so the two shapes can coexist — the hub replaces
 * the organization group with the contact group rather than adding to it, so
 * seeing both at once genuinely needs two connections.
 */
const subscriptions = new Map<string, Subscription>();

async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const registryKey = async (apiKey: string, contactId?: string) =>
  `${await sha256Hex(apiKey)}:${contactId ?? "org"}`;

/** Same 8-hex pseudonym the HTTP call log uses, so the two correlate. */
const callerId = async (apiKey: string) => (await sha256Hex(apiKey)).slice(0, 8);

/**
 * Connection lifecycle only: open, reconnect, close. Individual events are
 * deliberately not logged — they arrive in bulk and carry message bodies, and
 * the counters in `status` already show whether a subscription is live.
 */
async function log(
  apiKey: string,
  method: string,
  ok: boolean,
  ms: number,
  meta: Record<string, unknown>,
  onCall: (entry: CallLog) => void
) {
  onCall({ ts: new Date().toISOString(), caller: await callerId(apiKey), method, ok, ms, meta });
}

export interface ConnectOptions {
  /** Narrows the connection to one contact's thread. Query-string only. */
  contactId?: string;
  /** Ring capacity. Oldest events are evicted first and counted in `dropped`. */
  bufferSize?: number;
  onCall?: (entry: CallLog) => void;
}

/**
 * Open a hub subscription, or return the existing one for this key and scope.
 *
 * The key goes in the `X-API-KEY` handshake header rather than the `?apikey=`
 * query parameter. Both are accepted, but on the query form the negotiate
 * redirect carries the key onward into the Azure SignalR Service URL; the
 * header form leaves that URL clean. Node can set handshake headers, so there
 * is no reason to take the query form here.
 */
export async function connectRealtime(
  apiKey: string,
  options: ConnectOptions = {}
): Promise<SubscriptionStatus> {
  const onCall = options.onCall ?? logToStderr;
  const key = await registryKey(apiKey, options.contactId);

  const existing = subscriptions.get(key);
  if (existing) {
    existing.status.state = String(existing.hub.state);
    return existing.status;
  }

  // Imported on demand: hosts that never open a subscription should not pay for
  // loading a WebSocket stack, and the HTTP entrypoints never register these
  // tools at all.
  let signalR: any;
  try {
    signalR = await import("@microsoft/signalr");
  } catch (err) {
    throw new Error(
      "@microsoft/signalr is not installed. Run `npm install @microsoft/signalr` to use the realtime chat tools."
    );
  }

  const bufferSize = Math.min(Math.max(options.bufferSize ?? DEFAULT_BUFFER, 1), MAX_BUFFER);

  // contactId is query-string only — the key may be a header, this may not.
  const url =
    BASE_URL +
    HUB_PATH +
    (options.contactId ? `?contactId=${encodeURIComponent(options.contactId)}` : "");

  const hub = new signalR.HubConnectionBuilder()
    .withUrl(url, { headers: { "X-API-KEY": apiKey } })
    .withAutomaticReconnect()
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  const sub: Subscription = {
    hub,
    events: [],
    nextSeq: 1,
    status: {
      scope: options.contactId ? "contact" : "organization",
      contactId: options.contactId,
      group: options.contactId ? `contact-${options.contactId}` : "org-{organizationId}",
      state: "Connecting",
      connectedAt: new Date().toISOString(),
      received: 0,
      dropped: 0,
      buffered: 0,
      deliveredThrough: 0,
      reconnects: 0,
      bufferSize,
    },
  };

  const record = (event: HubEventName, payload: unknown) => {
    sub.events.push({ seq: sub.nextSeq++, ts: new Date().toISOString(), event, payload });
    // Evict from the front, but only past what a poll has already handed out —
    // silently dropping unread events is what `dropped` exists to make visible.
    while (sub.events.length > bufferSize) {
      const evicted = sub.events.shift()!;
      if (evicted.seq > sub.status.deliveredThrough) sub.status.dropped++;
    }
    sub.status.received++;
    sub.status.lastEventAt = new Date().toISOString();
    sub.status.buffered = sub.events.length;
  };

  hub.on("ReceiveMessage", (payload: unknown) => record("ReceiveMessage", payload));
  hub.on("MarkMessagesRead", (payload: unknown) => record("MarkMessagesRead", payload));

  hub.onreconnecting(() => {
    sub.status.state = "Reconnecting";
  });
  hub.onreconnected(() => {
    sub.status.state = "Connected";
    sub.status.reconnects++;
    void log(apiKey, "realtimeReconnected", true, 0, { scope: sub.status.scope }, onCall);
  });
  hub.onclose(() => {
    sub.status.state = "Disconnected";
  });

  const started = Date.now();
  try {
    await hub.start();
  } catch (err) {
    subscriptions.delete(key);
    await log(
      apiKey,
      "realtimeConnect",
      false,
      Date.now() - started,
      { scope: sub.status.scope, contactId: options.contactId },
      onCall
    );
    // A 401 at negotiate with a working key means the contactId is unknown,
    // malformed, or another organization's — the hub validates it during
    // authentication rather than falling back to the organization group.
    const detail = String((err as Error)?.message ?? err);
    throw new Error(
      options.contactId
        ? `SignalR handshake failed: ${detail}. A 401 here with a valid API key means contactId ${options.contactId} is not one of your organization's contacts. A 404 means the hub URL is wrong.`
        : `SignalR handshake failed: ${detail}`
    );
  }

  sub.status.state = "Connected";
  sub.status.connectedAt = new Date().toISOString();
  subscriptions.set(key, sub);
  await log(
    apiKey,
    "realtimeConnect",
    true,
    Date.now() - started,
    { scope: sub.status.scope, contactId: options.contactId, bufferSize },
    onCall
  );
  return sub.status;
}

const refresh = (sub: Subscription): SubscriptionStatus => {
  sub.status.state = String(sub.hub.state);
  sub.status.buffered = sub.events.length;
  return sub.status;
};

/** Every live subscription belonging to this key — never another caller's. */
export async function realtimeStatus(apiKey: string): Promise<SubscriptionStatus[]> {
  const prefix = `${await sha256Hex(apiKey)}:`;
  return [...subscriptions.entries()]
    .filter(([k]) => k.startsWith(prefix))
    .map(([, sub]) => refresh(sub));
}

export interface PollResult {
  status: SubscriptionStatus;
  events: BufferedEvent[];
  /** Seq of the last event returned. Pass as `sinceSeq` to resume from here. */
  cursor: number;
  /** More events are buffered past `limit`; poll again. */
  hasMore: boolean;
}

/**
 * Drain buffered events for one subscription.
 *
 * The cursor advances on its own, so repeated bare polls return only what is
 * new. `sinceSeq` re-reads from an earlier point, as far back as the ring still
 * holds.
 */
export async function pollRealtime(
  apiKey: string,
  options: { contactId?: string; sinceSeq?: number; limit?: number } = {}
): Promise<PollResult> {
  const sub = subscriptions.get(await registryKey(apiKey, options.contactId));
  if (!sub) {
    throw new Error(
      `No realtime subscription open for the ${options.contactId ? `contact ${options.contactId}` : "organization"} scope. Call chat_realtime_connect first.`
    );
  }

  const after = options.sinceSeq ?? sub.status.deliveredThrough;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const pending = sub.events.filter((e) => e.seq > after);
  const events = pending.slice(0, limit);

  if (events.length) {
    sub.status.deliveredThrough = Math.max(
      sub.status.deliveredThrough,
      events[events.length - 1].seq
    );
  }

  return {
    status: refresh(sub),
    events,
    cursor: events.length ? events[events.length - 1].seq : after,
    hasMore: pending.length > events.length,
  };
}

/** Close one scope, or every scope this key holds. */
export async function disconnectRealtime(
  apiKey: string,
  options: { contactId?: string; all?: boolean; onCall?: (entry: CallLog) => void } = {}
): Promise<{ closed: string[] }> {
  const onCall = options.onCall ?? logToStderr;
  const prefix = `${await sha256Hex(apiKey)}:`;
  const keys = options.all
    ? [...subscriptions.keys()].filter((k) => k.startsWith(prefix))
    : [await registryKey(apiKey, options.contactId)];

  const closed: string[] = [];
  for (const key of keys) {
    const sub = subscriptions.get(key);
    if (!sub) continue;
    // Best-effort: a socket already dropped by the server still has to leave the
    // registry, or the scope can never be reopened.
    try {
      await sub.hub.stop();
    } catch {
      /* already down */
    }
    subscriptions.delete(key);
    closed.push(sub.status.contactId ? `contact:${sub.status.contactId}` : "organization");
  }

  if (closed.length) {
    await log(apiKey, "realtimeDisconnect", true, 0, { scopes: closed.length }, onCall);
  }
  return { closed };
}
