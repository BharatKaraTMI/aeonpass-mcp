/** Production gateway — used when AEONPASS_BASE_URL is unset. */
const DEFAULT_BASE_URL = "https://apv2-gatewayapp-stage-westus3.azurewebsites.net";

/**
 * Gateway origin, overridable with `AEONPASS_BASE_URL` so a staging or local
 * gateway can be pointed at without editing code. The Node entrypoints read it
 * out of `.env` (see `env.ts`); hosted platforms inject it as a normal
 * environment variable.
 *
 * `process` is reached through `globalThis` because this module also runs on
 * Workers and Deno, where it may not exist at all.
 *
 * Only the origin is used: every request path below is absolute, so a path
 * component on this value would be discarded by `new URL(path, BASE_URL)`.
 */
function resolveBaseUrl(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  const configured = env?.AEONPASS_BASE_URL?.trim();
  if (!configured) return DEFAULT_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      `AEONPASS_BASE_URL is not a valid URL: ${configured}. ` +
        `Expected an origin such as ${DEFAULT_BASE_URL}`
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `AEONPASS_BASE_URL must be http or https, got ${parsed.protocol} in ${configured}`
    );
  }
  return parsed.origin;
}

const BASE_URL = resolveBaseUrl();

/** One API call, recorded without credentials or personal data. */
export interface CallLog {
  ts: string;
  /** First 8 hex of SHA-256(apiKey). A stable pseudonym — never the key. */
  caller: string;
  method: string;
  ok: boolean;
  ms: number;
  /** HTTP status, on failure only. */
  status?: number;
  /** Argument *shape* for sensitive calls. Never message bodies or PII. */
  meta?: Record<string, unknown>;
}

/**
 * Default sink: one JSON object per line on **stderr**.
 *
 * stderr matters. The stdio transport owns stdout for JSON-RPC frames, so
 * anything written there corrupts the protocol. Vercel captures stderr as
 * runtime logs either way.
 */
export function logToStderr(entry: CallLog): void {
  console.error(JSON.stringify({ src: "aeonpass-mcp", ...entry }));
}

export interface ClientOptions {
  /** Receives one record per call. Pass `() => {}` to disable. */
  onCall?: (entry: CallLog) => void;
}

/**
 * Records the *shape* of arguments for calls where that matters after the fact
 * — bulk sends, deletes, and the bulk reads. Deliberately omits message
 * bodies, recipient lists, and contact records: those are the PII, and logs are
 * not the place for them.
 *
 * There is no organizationId to record any more: the portal surface now derives
 * the organization from the key on every route, so a key cannot name another
 * org's data and a log line has nothing to catch it doing so.
 */
function callMeta(method: string, args: unknown[]): Record<string, unknown> | undefined {
  const a = args[0] as any;
  const b = args[1] as any;
  switch (method) {
    case "sendInvite":
      return { eventId: a?.eventId, sendToAll: !!a?.sendToAll, guests: a?.guestIds?.length ?? 0 };
    case "sendMessageToGuests":
      return {
        eventId: a?.eventId,
        sendToAll: !!a?.sendToAll,
        guests: a?.guestIds?.length ?? 0,
        channels: a?.typeIds,
        bodyChars: a?.messageBody?.length ?? 0,
      };
    case "sendMessageToContacts":
      return {
        contacts: a?.contactIds?.length ?? 0,
        channels: a?.typeIds,
        bodyChars: a?.messageBody?.length ?? 0,
      };
    case "uploadContacts":
      return { rows: a?.contacts?.length ?? 0 };
    case "createGroup":
      return { generated: a?.noOfTechaeons };
    case "deleteTechaeon":
    case "deleteContact":
      return { id: a };
    case "deleteGuest":
      return { id: a, invitationId: b };
    // Field *names* only — the values are guest PII.
    case "patchGuest":
    case "updateGuest":
      return { id: a, fields: Object.keys((b as object) ?? {}) };
    case "listContacts":
      return { includeAll: a?.includeAll ?? true, pageSize: a?.pageSize };
    // Messaging: channels and sizes, never the message text or the file bytes.
    // sendFrom is worth keeping: it is the only field that decides which side a
    // stored message is attributed to, and contactId is the sender on a
    // "Contact" send. Ids, not content.
    case "sendConversationMessage":
      return {
        conversationId: a?.conversationId,
        eventId: a?.eventId,
        sendFrom: a?.sendFrom ?? "Organization",
        contactId: a?.contactId,
        attachments: a?.attachments?.length ?? 0,
        channels: { inApp: !!a?.inApp, inSMS: !!a?.inSMS, inEmail: !!a?.inEmail },
        bodyChars: a?.messageBody?.length ?? 0,
      };
    // Count and size only — file *names* describe their contents too.
    case "uploadConversationDocs":
      return {
        files: a?.files?.length ?? 0,
        base64Chars:
          a?.files?.reduce((n: number, f: any) => n + (f?.contentBase64?.length ?? 0), 0) ?? 0,
      };
    default:
      return undefined;
  }
}

/**
 * Builds an Aeon Pass API client bound to a single API key.
 *
 * The key is a parameter rather than a module-level env read so that a hosted
 * deployment can pass the caller's own key per request — the server itself
 * never holds a credential. The stdio entrypoint passes the env var.
 */
export function createClient(apiKey: string, options: ClientOptions = {}) {
  if (!apiKey) {
    throw new Error("No Aeon Pass API key provided");
  }

  const onCall = options.onCall ?? logToStderr;

  // Derived lazily and memoised. Uses Web Crypto rather than node:crypto so the
  // client still runs on Workers, Deno, and Bun.
  let callerId: Promise<string> | undefined;
  const caller = () =>
    (callerId ??= crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(apiKey))
      .then((buf) =>
        Array.from(new Uint8Array(buf).slice(0, 4))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("")
      ));

  async function request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | undefined>
  ): Promise<unknown> {
    const url = new URL(path, BASE_URL);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, v);
        }
      }
    }

    const headers: Record<string, string> = {
      "X-API-KEY": apiKey,
    };

    const hasBody = method !== "GET" && method !== "DELETE";
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${text}`);
    }

    if (!text) return { success: true };
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // Contact create/update are multipart/form-data per the API spec.
  async function formRequest(
    method: string,
    path: string,
    fields: Record<string, string | number | boolean | undefined | null>
  ): Promise<unknown> {
    const url = new URL(path, BASE_URL);
    const formData = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) {
        formData.append(k, String(v));
      }
    }
    const res = await fetch(url.toString(), {
      method,
      headers: { "X-API-KEY": apiKey },
      body: formData,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
    if (!text) return { success: true };
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * Multipart upload for message attachments. Separate from `formRequest`,
   * which carries scalar fields only: this one appends repeated parts under the
   * field name `File`, which is what the upload endpoint reads.
   *
   * MCP is a text protocol, so bytes arrive base64-encoded and are decoded
   * here. `atob` rather than `node:buffer` keeps the client running on Workers
   * and Deno. Base64 inflates content by a third and every byte of it passes
   * through the model's context — this is for small attachments, not bulk
   * transfer.
   */
  async function uploadRequest(
    path: string,
    files: Array<{ fileName: string; contentBase64: string; contentType?: string }>
  ): Promise<unknown> {
    if (!files?.length) {
      throw new Error("upload-docs requires at least one file");
    }

    // Inferring the byte array rather than annotating it keeps `Blob` happy:
    // a bare `Uint8Array` widens to `ArrayBufferLike`, which is not a BlobPart.
    const decode = (file: { fileName: string; contentBase64: string }) => {
      // A data: URI is what a caller most often has to hand; take the payload
      // rather than failing on the prefix. `atob` already tolerates whitespace.
      const b64 = file.contentBase64.replace(/^data:[^,]*;base64,/, "");
      try {
        return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      } catch {
        // Named here rather than surfacing as an opaque fetch or 400 later.
        throw new Error(`Attachment "${file.fileName}" is not valid base64`);
      }
    };

    const url = new URL(path, BASE_URL);
    const formData = new FormData();
    for (const file of files) {
      const blob = new Blob([decode(file)], {
        type: file.contentType ?? "application/octet-stream",
      });
      formData.append("File", blob, file.fileName);
    }

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "X-API-KEY": apiKey },
      body: formData,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
    if (!text) return { success: true };
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  const methods = {
    // ── Techaeons ──

    getTechaeon(id: string) {
      return request("GET", `/api/portal/techaeon/${id}`);
    },

    createTechaeon(params: {
      redirectUrl?: string;
      eventId?: string;
      groupId?: string;
      techaeonHolder?: {
        firstName: string;
        lastName?: string;
        email?: string;
        phone?: string;
      };
    }) {
      return request("POST", "/api/portal/techaeon", params);
    },

    deleteTechaeon(id: string) {
      return request("DELETE", `/api/portal/techaeon/${id}`);
    },

    updateTechaeonStatus(id: string, statusCode: string) {
      return request("PUT", `/api/portal/techaeon/${id}/status`, { statusCode });
    },

    updateTechaeonRedirect(id: string, redirectUrl: string | null) {
      return request("PUT", `/api/portal/techaeon/${id}/redirectUrl`, { redirectUrl });
    },

    listTechaeons(params: {
      groupId?: string;
      pageNo?: number;
      pageSize?: number;
      sortBy?: string;
      sortDirection?: string;
      searchTerm?: string;
      unUsedOnly?: boolean;
      resourceType?: string;
      resourceValue?: string;
      statusId?: string;
      privilegeId?: string;
      privilegeCode?: string;
    }) {
      const query: Record<string, string | undefined> = {};
      if (params.groupId) query.groupId = params.groupId;
      if (params.pageNo) query.pageNo = String(params.pageNo);
      if (params.pageSize) query.pageSize = String(params.pageSize);
      if (params.sortBy) query.sortBy = params.sortBy;
      if (params.sortDirection) query.sortDirection = params.sortDirection;
      if (params.searchTerm) query.searchTerm = params.searchTerm;
      if (params.unUsedOnly !== undefined) query.unUsedOnly = String(params.unUsedOnly);
      if (params.resourceType) query.resourceType = params.resourceType;
      if (params.resourceValue) query.resourceValue = params.resourceValue;
      if (params.statusId) query.statusId = params.statusId;
      if (params.privilegeId) query.privilegeId = params.privilegeId;
      if (params.privilegeCode) query.privilegeCode = params.privilegeCode;
      return request("GET", "/api/portal/techaeon/list", undefined, query);
    },

    // ── Groups ──

    createGroup(params: {
      groupName: string;
      noOfTechaeons: number;
      eventId?: string;
      redirectUrl?: string;
      isTechaeonCodeEnabled?: boolean;
    }) {
      return request("POST", "/api/portal/techaeon/group", params);
    },

    updateGroup(
      id: string,
      params: {
        groupName: string;
        eventId?: string;
        redirectUrl?: string;
        isTechaeonCodeEnabled?: boolean;
      }
    ) {
      return request("PUT", `/api/portal/techaeon/group/${id}`, params);
    },

    listGroups(params: {
      pageNo?: number;
      pageSize?: number;
      sortBy?: string;
      sortDirection?: string;
      searchTerm?: string;
    }) {
      const query: Record<string, string | undefined> = {};
      if (params.pageNo) query.pageNo = String(params.pageNo);
      if (params.pageSize) query.pageSize = String(params.pageSize);
      if (params.sortBy) query.sortBy = params.sortBy;
      if (params.sortDirection) query.sortDirection = params.sortDirection;
      if (params.searchTerm) query.searchTerm = params.searchTerm;
      return request("GET", "/api/portal/techaeon/group/list", undefined, query);
    },

    // ── Events ──

    getEvent(id: string) {
      return request("GET", `/api/portal/event/${id}`);
    },

    // ── Guests ──

    createGuest(params: {
      eventId: string;
      firstName: string;
      lastName?: string;
      displayName?: string;
      phone?: string;
      email?: string;
      groupId: string;
      isUpdateAllEvent?: boolean;
      techaeonCode?: string;
      guestCode?: string;
      invitation?: {
        designMappingId: string;
        guestPasses?: number;
        isUnlimited?: boolean;
      };
    }) {
      return request("POST", "/api/portal/guest", params);
    },

    listGuests(
      eventId: string,
      params: {
        pageNo?: number;
        pageSize?: number;
        searchTerm?: string;
        groupId?: string;
        designMappingId?: string;
        sortBy?: string;
        sortDirection?: string;
      }
    ) {
      return request("POST", `/api/portal/guest/${eventId}/list`, params);
    },

    updateGuest(
      id: string,
      params: {
        eventId: string;
        firstName: string;
        lastName?: string;
        displayName?: string;
        phone?: string;
        email?: string;
        groupId: string;
        isUpdateAllEvent?: boolean;
        techaeonCode?: string;
        guestCode?: string;
        invitation?: {
          id: string;
          designMappingId: string;
          guestPasses?: number;
          isUnlimited?: boolean;
          statusId?: string;
        };
      }
    ) {
      return request("PUT", `/api/portal/guest/${id}`, params);
    },

    /**
     * JSON Merge Patch: only the fields present in `params` are touched, and
     * omitted ones are left alone. `request` runs the body through
     * JSON.stringify, which drops `undefined` keys, so partial objects work as
     * intended — while an explicit `null` survives and clears the field.
     *
     * The spec types these fields as `PatchFieldOfNullableOfX`, but that is the
     * C# wrapper leaking into the generated schema; the endpoint description is
     * explicit that plain values go on the wire, not `{ isSet, value }`.
     */
    patchGuest(
      id: string,
      params: {
        eventId?: string;
        isUpdateAllEvent?: boolean;
        firstName?: string;
        lastName?: string;
        displayName?: string;
        phone?: string | null;
        email?: string | null;
        groupId?: string;
        techaeonCode?: string | null;
        guestCode?: string | null;
        invitation?: {
          designMappingId?: string;
          guestPasses?: number | null;
          isUnlimited?: boolean | null;
          statusId?: string;
        };
      }
    ) {
      return request("PATCH", `/api/portal/guest/${id}`, params);
    },

    deleteGuest(id: string, invitationId?: string) {
      const query: Record<string, string | undefined> = {};
      if (invitationId) query.invitationId = invitationId;
      return request("DELETE", `/api/portal/guest/${id}`, undefined, query);
    },

    sendInvite(params: {
      eventId: string;
      sendToAll?: boolean;
      guestIds?: string[];
      inviteMessageTemplate?: string;
    }) {
      return request("POST", "/api/portal/guest/send-invite", params);
    },

    sendMessageToGuests(params: {
      eventId: string;
      messageBody: string;
      guestIds?: string[];
      typeIds?: number[];
      sendToAll?: boolean;
      designMappingId?: string;
    }) {
      return request("POST", "/api/portal/guest/send-message", params);
    },

    // ── Contacts ──

    createContact(params: {
      organizationId: string;
      firstName: string;
      lastName?: string;
      displayName?: string;
      email?: string;
      phone?: string;
      address?: string;
      state?: string;
      city?: string;
      country?: string;
      zip?: string;
      socialHandle?: string;
    }) {
      return formRequest("POST", "/api/portal/contact", params);
    },

    getContact(id: string) {
      return request("GET", `/api/portal/contact/${id}`);
    },

    updateContact(
      id: string,
      params: {
        organizationId: string;
        firstName: string;
        lastName?: string;
        displayName?: string;
        email?: string;
        phone?: string;
        userId?: string;
        address?: string;
        state?: string;
        city?: string;
        country?: string;
        zip?: string;
        socialHandle?: string;
      }
    ) {
      return formRequest("PUT", `/api/portal/contact/${id}`, params);
    },

    deleteContact(id: string) {
      return request("DELETE", `/api/portal/contact/${id}`);
    },

    listContacts(
      params: {
        pageNo?: number;
        pageSize?: number;
        searchTerm?: string;
        sortBy?: string;
        sortDirection?: string;
        includeAll?: boolean;
      }
    ) {
      const query: Record<string, string | undefined> = {
        includeAll: String(params.includeAll ?? true),
      };
      if (params.pageNo) query.pageNo = String(params.pageNo);
      if (params.pageSize) query.pageSize = String(params.pageSize);
      if (params.searchTerm) query.searchTerm = params.searchTerm;
      if (params.sortBy) query.sortBy = params.sortBy;
      if (params.sortDirection) query.sortDirection = params.sortDirection;
      return request("GET", "/api/portal/contact/list", undefined, query);
    },

    sendMessageToContacts(params: {
      messageBody: string;
      contactIds: string[];
      typeIds?: number[];
    }) {
      return request("POST", "/api/portal/contact/send-message", params);
    },

    uploadContacts(params: {
      contacts: Array<{
        firstName: string;
        lastName?: string;
        phone?: string;
        email?: string;
        state?: string;
        country?: string;
      }>;
    }) {
      return request("POST", "/api/portal/contact/upload-list", params);
    },

    listGuestGroups() {
      return request("GET", "/api/portal/guest-group/list");
    },

    // ── Messaging (Chat) ──
    //
    // The chat service's portal surface. Every route below is `/api/portal/…`
    // and authenticates with X-API-KEY like the rest of this client. The
    // sibling `/api/conversations/*` surface is the same functionality behind
    // an end user's JWT and is deliberately not implemented — this server only
    // ever holds an API key.
    //
    // A conversation is identified by (organization, contact) and the
    // organization is always the key's own, so nothing here takes an
    // organizationId except the parity read at the end. The usual entry point
    // is guest id → contactId → get-or-create → send.

    listConversations(params: {
      pageNo?: number;
      pageSize?: number;
      searchTerm?: string;
      isUnreadOnly?: boolean;
    }) {
      const query: Record<string, string | undefined> = {};
      if (params.pageNo) query.pageNo = String(params.pageNo);
      if (params.pageSize) query.pageSize = String(params.pageSize);
      if (params.searchTerm) query.searchTerm = params.searchTerm;
      if (params.isUnreadOnly !== undefined) query.isUnreadOnly = String(params.isUnreadOnly);
      return request("GET", "/api/portal/conversations/list", undefined, query);
    },

    getConversation(id: string) {
      return request("GET", `/api/portal/conversations/${id}`);
    },

    /** Get-or-create by contactId: calling it twice returns the same thread. */
    createConversation(contactId: string) {
      return request("POST", "/api/portal/conversations", { contactId });
    },

    /**
     * The same get-or-create, addressed by contactId instead of having to hold
     * a conversation id. `isCreateNew` is required by the API; `request` drops
     * empty query values, and `String(false)` is "false", so an explicit no
     * still reaches the server.
     */
    getConversationWithContact(contactId: string, isCreateNew: boolean) {
      return request(
        "GET",
        `/api/portal/conversations/with-contact/${contactId}`,
        undefined,
        { isCreateNew: String(isCreateNew) }
      );
    },

    /**
     * Event guest id → the contactId the conversation endpoints take. Matched
     * on exact phone, then case-insensitive email; guest ids and contact ids
     * are unrelated.
     */
    getContactByGuest(guestId: string) {
      return request("GET", `/api/portal/conversations/contact/${guestId}`);
    },

    listMessages(
      conversationId: string,
      params: {
        eventId?: string;
        pageNo?: number;
        pageSize?: number;
        searchTerm?: string;
      }
    ) {
      const query: Record<string, string | undefined> = {};
      if (params.eventId) query.eventId = params.eventId;
      if (params.pageNo) query.pageNo = String(params.pageNo);
      if (params.pageSize) query.pageSize = String(params.pageSize);
      if (params.searchTerm) query.searchTerm = params.searchTerm;
      return request(
        "GET",
        `/api/portal/conversations/${conversationId}/messages`,
        undefined,
        query
      );
    },

    /**
     * Delivery channels all default to false server-side. With none set the
     * message is still stored and pushed to live subscribers, but nothing is
     * dispatched to the person — inSMS is the only channel that reaches a
     * contact with no registered account, and the one their replies come back
     * on.
     *
     * `sendFrom` picks which side the message is *attributed* to, not who is
     * authorized: the key still has to be allowed to write to the conversation
     * either way. "Contact" requires `contactId`, it must be this
     * conversation's own contact, and the delivery channels then dispatch
     * nothing — they describe how to reach the contact, so they only mean
     * anything on an organization send. Omitting `sendFrom` behaves exactly as
     * this call did before the field existed.
     *
     * Sent by name ("Organization"/"Contact"). The numeric form binds too, but
     * a magic number in a request body is the kind of thing a caller gets
     * silently wrong.
     */
    sendConversationMessage(params: {
      conversationId: string;
      messageBody?: string;
      eventId?: string;
      attachments?: Array<{
        url: string;
        id?: string;
        fileName?: string;
        fileType?: string;
        storageFileName?: string;
      }>;
      inApp?: boolean;
      inSMS?: boolean;
      inEmail?: boolean;
      sendFrom?: "Organization" | "Contact";
      contactId?: string;
    }) {
      return request("POST", "/api/portal/conversations/send-message", params);
    },

    /**
     * Marks the thread read for the organization *owner* — the acting user
     * behind an API key — so it also clears the badge that person sees in the
     * web app. Reading through the API and reading in the app are one state.
     */
    markConversationRead(id: string) {
      return request("PUT", `/api/portal/conversations/${id}/mark-read`);
    },

    /**
     * Returns one entry per successfully stored file, in upload order; a file
     * that fails to store is left out, so compare the length against what was
     * sent. Pass the entries through as `attachments` on the next send.
     */
    uploadConversationDocs(params: {
      files: Array<{ fileName: string; contentBase64: string; contentType?: string }>;
    }) {
      return uploadRequest("/api/portal/conversations/upload-docs", params.files);
    },

    /**
     * `GET /api/portal/chat` is a SignalR handshake, not a REST call — a plain
     * GET is rejected by design. There is nothing to proxy either: a long-lived
     * socket cannot live inside a stateless per-request MCP server, and the
     * serverless entrypoint could not hold one open.
     *
     * So this describes the hub instead, deriving the URL from the configured
     * gateway origin so it follows AEONPASS_BASE_URL to staging or local. The
     * API key is deliberately not interpolated into the returned URL: the
     * caller already holds it, and a tool result is written into the model's
     * context and every transcript of it.
     *
     * One key, two subscription shapes, and a connection is one or the other.
     * Omit `contactId` for the organization-wide group; pass one to narrow to
     * that contact's single thread. The contact scope *replaces* the
     * organization group rather than adding to it — that is the point of it, so
     * a contact-facing client cannot receive the organization's other
     * conversations. Both views at once means two connections.
     *
     * `contactId` goes in the returned URL because it is not a secret and the
     * API accepts it in the query string only; the key is the part kept out.
     *
     * The URL is http(s), not ws(s), even though the result is a WebSocket. A
     * SignalR client is handed the HTTP address and negotiates the upgrade
     * itself; `@microsoft/signalr` rejects a `wss://` URL outright with
     * "Cannot resolve", so returning the scheme the socket ends up on would
     * hand the caller something that cannot be pasted into `withUrl`.
     */
    async getChatHubInfo(contactId?: string) {
      const { protocol, host } = new URL(BASE_URL);
      const base = `${protocol}//${host}/api/portal/chat`;
      const scoped = contactId !== undefined;
      return {
        url: scoped ? `${base}?contactId=${encodeURIComponent(contactId)}` : base,
        protocol:
          "SignalR — connect with a SignalR client (@microsoft/signalr, Microsoft.AspNetCore.SignalR.Client), not fetch. Pass this URL to withUrl() as-is: the client POSTs to …/negotiate over HTTP and upgrades to a WebSocket itself, so the address is http(s) even though the connection ends up wss. A SignalR client rejects a wss:// URL.",
        authentication: {
          header: "X-API-KEY. Prefer it wherever your SignalR client can set handshake headers — a browser cannot, Node can",
          queryFallback:
            "?apikey=<your key> — the one Aeon Pass route where the key may travel in a URL, because a browser's SignalR handshake cannot set headers. The negotiate redirect then carries the key onward into the Azure SignalR Service URL; the header form leaves that URL clean.",
          note: "The key is not returned here. Supply your own when connecting. A missing, unknown or revoked key is a 401 at negotiate, so no socket opens.",
        },
        subscription: scoped
          ? {
              shape: "contact-scoped",
              group: `contact-${contactId}`,
              receives:
                "that contact's conversation with your organization and nothing else — both sides of that one thread",
              useFor:
                "a contact-facing widget, kiosk or app screen, for a person who may have no Aeon Pass account",
              validation:
                "the contactId is checked during authentication, before any socket exists: it must be a contact of this key's own organization. Anything else fails negotiate with 401 rather than falling back to the organization-wide group — silently widening the scope is the leak this parameter exists to prevent. So a 401 with a key you know is good means this contactId is unknown, malformed, or another organization's.",
            }
          : {
              shape: "organization-wide",
              group: "org-{organizationId}, taken from the key's organization",
              receives:
                "every conversation of your organization, both sides of every thread",
              useFor: "an operator console, an inbox view, a CRM sync",
              validation:
                "pass contactId to this tool instead to narrow the connection to a single contact's thread",
            },
        urlNote:
          "This is the gateway URL, which prefixes every chat route with /api. Calling the chat service directly (in-cluster or a local run) the hub is at /portal/chat instead. The wrong one fails as a 404 on the negotiate request, not a 401 — worth knowing when a 404 looks like an auth problem.",
        serverEvents: [
          {
            event: "ReceiveMessage",
            payload:
              "ConversationPushDto — the conversation, with the new message in lastMessage. lastMessage.isFromOrganization is the field to branch on; false covers every contact-side message, whether an SMS reply, the contact's own in-app send, or one recorded through sendFrom: \"Contact\". Deliberately carries no unreadCount or isReadByUser: one group push reaches every subscriber and those differ per reader, so track them locally or re-read get_conversation.",
            raisedWhen: scoped
              ? "a message is sent in this contact's conversation, from either side and any surface. Not gated on delivery channels, so a send with inApp/inSMS/inEmail all false still arrives"
              : "a message is sent in any conversation of your organization, from either side and any surface. Not gated on delivery channels, so a send with inApp/inSMS/inEmail all false still arrives",
            note: "Sender-neutral, so your own sends come back to you on the connection that made them. Reconcile on lastMessage.id rather than assuming an inbound event is someone else's.",
          },
          {
            event: "MarkMessagesRead",
            payload:
              "MarkAsReadConversationDto. Branch on readByContact rather than assuming a direction: true means the contact read your message, false means your organization read the contact's.",
            raisedWhen: scoped
              ? "this conversation is read on either side. From the contact seat readByContact is false — the mirror of the org-wide view — and this is the only channel that delivers a read receipt to a contact with no user account"
              : "a contact reads a conversation of your organization (readByContact: true). Your own mark-read never echoes back to you; that endpoint returns the receipt in its HTTP response instead",
          },
        ],
        sending:
          "stays on HTTP — the hub is receive-only and exposes no client-callable methods on either shape. Use send_conversation_message and mark_conversation_read." +
          (scoped
            ? " Replying from the contact seat is send_conversation_message with sendFrom: \"Contact\" and this contactId — note those sends dispatch nothing to the contact, and there is no contact-side mark-read: mark_conversation_read always records the organization as the reader, whichever way the connection is scoped."
            : ""),
      };
    },
  };

  // Wrap every method once rather than at each call site. Failures are recorded
  // and rethrown — logging must never change behaviour.
  const instrumented = Object.fromEntries(
    Object.entries(methods).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        const started = Date.now();
        try {
          const result = await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
          onCall({
            ts: new Date().toISOString(),
            caller: await caller(),
            method: name,
            ok: true,
            ms: Date.now() - started,
            meta: callMeta(name, args),
          });
          return result;
        } catch (err) {
          // Status only — the API's error body can echo back request content.
          const status = Number(/^API (\d+)/.exec(String((err as Error)?.message))?.[1]) || undefined;
          onCall({
            ts: new Date().toISOString(),
            caller: await caller(),
            method: name,
            ok: false,
            ms: Date.now() - started,
            status,
            meta: callMeta(name, args),
          });
          throw err;
        }
      },
    ])
  ) as typeof methods;

  return instrumented;
}

export type AeonPassClient = ReturnType<typeof createClient>;
