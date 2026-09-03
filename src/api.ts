/** Also the SignalR hub host — see realtime.ts. */
export const BASE_URL = "https://apv2-gatewayapp-stage-westus3.azurewebsites.net";

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

/**
 * Which side of an Org↔Contact conversation a read is *reported* from — the
 * `view` query parameter on the three conversation reads.
 *
 * It selects `callerRole` and nothing else. `Organization` and `Auto` report
 * `ORG_MEMBER`, `Contact` reports `CONTACT`; the rows themselves are identical
 * either way, because an API key reads the thread as the organization whichever
 * value it sends — `unreadCount`, `isReadByUser` and `isRead` stay the
 * organization's throughout. It is not an access switch and it does not change
 * what a key can reach.
 *
 * The spec's own schema text says the opposite at length — "a narrowing filter,
 * never a grant", "ask for a side you do not hold and the request is denied".
 * That is the rule on the *token* surface, where the value does reach the
 * authorization check. The `/portal` reads are the documented exception: a key
 * is org-side by construction, so `view` never reaches that check and `Contact`
 * is accepted rather than denied. Only the portal rule applies here.
 *
 * The one value that changes a *request* is `Contact` on the list, which needs
 * a `contactId` to say which contact's seat to report from, and answers with
 * that one conversation.
 *
 * `Auto` is the API's default *and* its zero value, and it means "infer the
 * side from the caller, as before" — so omitting the parameter reproduces the
 * pre-`view` request exactly. That is why every method below leaves it unset
 * unless a caller asks for one.
 */
export type ConversationSide = "Auto" | "Organization" | "Contact";

export interface ClientOptions {
  /** Receives one record per call. Pass `() => {}` to disable. */
  onCall?: (entry: CallLog) => void;
}

/**
 * Records the *shape* of arguments for calls where that matters after the fact
 * — bulk sends, deletes, and chat sends. Deliberately omits message bodies,
 * recipient lists, attachments and contact records: those are the PII, and
 * logs are not the place for them.
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
    // Chat. Conversation and contact ids are the routing facts worth keeping;
    // the message body, its attachments and the contact's details are not.
    case "sendChatMessage":
      return {
        conversationId: a?.conversationId,
        // No `?? "Organization"` fallback: the API requires sendFrom, so a call
        // without one is a 400, and defaulting it here would log a side the
        // request never claimed.
        sendFrom: a?.sendFrom,
        contactId: a?.contactId,
        eventId: a?.eventId,
        channels: { inApp: !!a?.inApp, inSMS: !!a?.inSMS, inEmail: !!a?.inEmail },
        bodyChars: a?.messageBody?.length ?? 0,
        attachments: a?.attachments?.length ?? 0,
      };
    case "uploadMessageDocs":
      // Count and types only — never a file name, which is often descriptive.
      return {
        files: a?.files?.length ?? 0,
        types: a?.files?.map((f: any) => f?.fileType ?? "unknown"),
      };
    case "createConversation":
      return { contactId: a };
    case "getConversationWithContact":
      return { contactId: a, isCreateNew: !!b };
    case "markConversationRead":
      return { conversationId: a };
    case "getContactByGuest":
      return { guestId: a };
    case "listMessages":
      return { conversationId: a, eventId: b?.eventId, view: b?.view };
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

  // Files, rather than the scalar fields formRequest builds — the caller has
  // already assembled the FormData because only it knows the part names.
  async function multipartRequest(method: string, path: string, form: FormData): Promise<unknown> {
    const res = await fetch(new URL(path, BASE_URL).toString(), {
      method,
      headers: { "X-API-KEY": apiKey },
      body: form,
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
    }) {
      return request("POST", "/api/portal/guest/send-message", params);
    },

    // ── Contacts ──
    // organizationId is resolved server-side from the API key on every
    // endpoint below — it is not a request parameter.

    createContact(params: {
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

    listContacts(params: {
      pageNo?: number;
      pageSize?: number;
      searchTerm?: string;
      sortBy?: string;
      sortDirection?: string;
      includeAll?: boolean;
    }) {
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

    sendMessageToContacts(params: { messageBody: string; contactIds: string[]; typeIds?: number[] }) {
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

    // ── Chat: conversations ──
    //
    // The Message API's `/api/portal/conversations/*` surface. Its list results
    // use the same `{ data, pagination }` shape as the rest of the portal.

    createConversation(contactId: string) {
      return request("POST", "/api/portal/conversations", { contactId });
    },

    /**
     * `view` is sent only when given: the API defaults it to `Auto`, which is
     * the behaviour this call had before the parameter existed, so a bare call
     * is unchanged. `view: "Contact"` reports `callerRole: "CONTACT"` for the
     * thread's own contact and needs no id of its own; every other field still
     * comes back as the organization sees it.
     */
    getConversation(id: string, view?: ConversationSide) {
      return request("GET", `/api/portal/conversations/${id}`, undefined, { view });
    },

    /**
     * Get-or-create the thread with one contact. `isCreateNew` is a required
     * query parameter, not an optional flag — the API has no default for it.
     */
    getConversationWithContact(contactId: string, isCreateNew: boolean) {
      return request("GET", `/api/portal/conversations/with-contact/${contactId}`, undefined, {
        isCreateNew: String(isCreateNew),
      });
    },

    /**
     * `contactId` narrows to the single conversation with that contact, and is
     * **required** when `view` is `"Contact"` — that pairing reports the row
     * from the contact's seat, and without an id there is no seat to name
     * (`400 CONTACT_ID_REQUIRED`). A contact of another organization is not an
     * error here, just an empty page.
     */
    listConversations(params: {
      pageNo?: number;
      pageSize?: number;
      searchTerm?: string;
      isUnreadOnly?: boolean;
      contactId?: string;
      view?: ConversationSide;
    }) {
      const query: Record<string, string | undefined> = {};
      if (params.pageNo) query.pageNo = String(params.pageNo);
      if (params.pageSize) query.pageSize = String(params.pageSize);
      if (params.searchTerm) query.searchTerm = params.searchTerm;
      if (params.isUnreadOnly !== undefined) query.isUnreadOnly = String(params.isUnreadOnly);
      if (params.contactId) query.contactId = params.contactId;
      if (params.view) query.view = params.view;
      return request("GET", "/api/portal/conversations/list", undefined, query);
    },

    /**
     * `view` is accepted here only so a caller can pass the same value it sent
     * to `getConversation`. A message has no `callerRole` of its own, so every
     * value returns the same page — `isRead` is the organization's receipt on
     * all of them. It is a no-op kept for symmetry, not a filter.
     */
    listMessages(
      conversationId: string,
      params: {
        eventId?: string;
        pageNo?: number;
        pageSize?: number;
        searchTerm?: string;
        view?: ConversationSide;
      }
    ) {
      const query: Record<string, string | undefined> = {};
      if (params.eventId) query.eventId = params.eventId;
      if (params.pageNo) query.pageNo = String(params.pageNo);
      if (params.pageSize) query.pageSize = String(params.pageSize);
      if (params.searchTerm) query.searchTerm = params.searchTerm;
      if (params.view) query.view = params.view;
      return request("GET", `/api/portal/conversations/${conversationId}/messages`, undefined, query);
    },

    /**
     * `sendFrom` is **required** on this surface. A key is org-side by
     * construction but may record either side, so there is no side to infer;
     * omitting it fails request binding before any of the endpoint's own
     * validation runs, which is why it is a required parameter here rather
     * than one we default. (The token surface leaves it nullable — null there
     * means "infer from the caller" — but this client only speaks portal.)
     *
     * `sendFrom: "Contact"` attributes the message to the contact, the way an
     * inbound SMS reply is stored, and dispatches nothing — inApp/inSMS/inEmail
     * describe how to *reach* the contact, so they only mean something when
     * sending as the organization.
     *
     * `eventId` is checked against the authorization store before anything is
     * stored: an unknown id, a deleted one, or another organization's event all
     * fail with `EVENT_NOT_LINKED`. It used to be accepted unvalidated and kept
     * as a tag that never resolved to an `eventName`, so a caller that was
     * quietly writing junk tags now gets a 400 instead.
     *
     * Leaving every channel off is legal and *not* an error: the message is
     * stored and pushed to live subscribers, but nothing is dispatched to the
     * contact, and the 200 is indistinguishable from a delivered send apart
     * from the flags echoed on `lastMessage`.
     */
    sendChatMessage(params: {
      conversationId: string;
      sendFrom: "Organization" | "Contact";
      contactId?: string;
      eventId?: string;
      messageBody?: string;
      attachments?: Array<{
        id: string;
        url: string;
        fileName?: string;
        fileType?: string;
        storageFileName?: string;
      }>;
      inApp?: boolean;
      inSMS?: boolean;
      inEmail?: boolean;
    }) {
      return request("POST", "/api/portal/conversations/send-message", params);
    },

    /**
     * Always records the *organization* as the reader, whichever way a realtime
     * connection is scoped — there is no contact-side mark-read on this surface.
     * Takes no fields but still needs a JSON body, or the API answers 415;
     * `request` sends `{}` for a PUT, which satisfies that.
     */
    markConversationRead(id: string) {
      return request("PUT", `/api/portal/conversations/${id}/mark-read`);
    },

    getContactByGuest(guestId: string) {
      return request("GET", `/api/portal/conversations/contact/${guestId}`);
    },

    /**
     * Upload attachments, then pass the returned records to `sendChatMessage`.
     *
     * Files arrive base64-encoded rather than as paths: the client has to run
     * unchanged on Workers and Deno, where there is no local filesystem to read
     * from, and over HTTP the caller is not on the same machine as the server
     * anyway. Practical for small files only — an LLM has to carry the encoded
     * bytes through its context to call this.
     */
    uploadMessageDocs(params: {
      files: Array<{ fileName: string; fileType?: string; contentBase64: string }>;
    }) {
      const form = new FormData();
      for (const f of params.files) {
        // atob/Uint8Array rather than node:crypto-style Buffer, for the same
        // portability reason the caller hash uses Web Crypto.
        const bytes = Uint8Array.from(atob(f.contentBase64), (ch) => ch.charCodeAt(0));
        form.append("File", new Blob([bytes], { type: f.fileType || "application/octet-stream" }), f.fileName);
      }
      return multipartRequest("POST", "/api/portal/conversations/upload-docs", form);
    },

    listGuestGroups() {
      return request("GET", "/api/portal/guest-group/list");
    },
  };

  // Wrap every method once rather than at 34 call sites. Failures are recorded
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
