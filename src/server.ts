import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AeonPassClient } from "./api.js";
import {
  connectRealtime,
  disconnectRealtime,
  pollRealtime,
  realtimeStatus,
} from "./realtime.js";

export interface ServerOptions {
  /**
   * Enables the realtime chat tools, bound to this key.
   *
   * The key is passed separately rather than read back off the client because
   * a SignalR subscription is the one thing here that outlives the tool call
   * that opened it, and it needs the raw key for the handshake. Set it only on
   * a host that keeps a process alive between calls — stdio, or a long-running
   * `npm run serve`. On serverless the instance can be frozen or discarded
   * between requests, so a subscription opened in one invocation is not there
   * for the next, and the tools would only ever report a dead connection.
   */
  realtimeApiKey?: string;
}

/**
 * Registers all Aeon Pass tools against a client. The client carries the API
 * key, so each transport decides where that key comes from — env for stdio,
 * request header for HTTP.
 */
export function createServer(client: AeonPassClient, options: ServerOptions = {}): McpServer {
  const { realtimeApiKey } = options;

  const server = new McpServer({
    name: "aeonpass",
    version: "1.0.0",
  });

  // ── Techaeon Tools ──

  server.tool(
    "get_techaeon",
    "Get full details of a single techaeon by ID, including status, holder info, group, and redirect URL",
    { id: z.string().describe("Techaeon GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getTechaeon(id), null, 2) }],
    })
  );

  server.tool(
    "list_techaeons",
    "List techaeons with pagination, filtering by group/status/search, and sorting. Returns { data: [...], pagination: { totalCount, page, pageSize, totalPages } }.",
    {
      groupId: z.string().optional().describe("Filter to a specific group"),
      pageNo: z.number().optional().describe("Page number (1-based)"),
      pageSize: z.number().optional().describe("Results per page"),
      sortBy: z.string().optional().describe("Field to sort by (e.g. CreatedOn, StatusCode)"),
      sortDirection: z.enum(["asc", "desc"]).optional(),
      searchTerm: z.string().optional().describe("Search holder name, email, phone, or techaeon code"),
      unUsedOnly: z.boolean().optional().describe("Only return unconsumed techaeons"),
      resourceType: z.string().optional().describe("Filter by resource type (e.g. EVENT)"),
      resourceValue: z.string().optional().describe("Filter by resource value (e.g. event ID)"),
      statusId: z.string().optional().describe("Filter by status GUID"),
      privilegeId: z.string().optional().describe("Filter by privilege GUID"),
      privilegeCode: z.string().optional().describe("Filter by privilege code (e.g. ENTRY)"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.listTechaeons(params), null, 2) }],
    })
  );

  server.tool(
    "create_techaeon",
    "Create a new techaeon and assign it to a holder. Status starts as CREATED.",
    {
      firstName: z.string().describe("Holder's first name (required)"),
      lastName: z.string().optional().describe("Holder's last name"),
      email: z.string().optional().describe("Holder's email (required if no phone)"),
      phone: z.string().optional().describe("Holder's phone with country code (required if no email)"),
      redirectUrl: z.string().optional().describe("URL to redirect to on scan"),
      eventId: z.string().optional().describe("Event GUID to auto-assign Entry privilege"),
      groupId: z.string().optional().describe("Group GUID to assign this techaeon to"),
    },
    async ({ firstName, lastName, email, phone, redirectUrl, eventId, groupId }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await client.createTechaeon({
              redirectUrl,
              eventId,
              groupId,
              techaeonHolder: { firstName, lastName, email, phone },
            }),
            null,
            2
          ),
        },
      ],
    })
  );

  server.tool(
    "update_techaeon_status",
    "Change the lifecycle status of a techaeon. Valid codes: CREATED, ISSUED, TRANSFERRED, CANCELLED, CONSUMED",
    {
      id: z.string().describe("Techaeon GUID"),
      statusCode: z
        .enum(["CREATED", "ISSUED", "TRANSFERRED", "CANCELLED", "CONSUMED"])
        .describe("New status code"),
    },
    async ({ id, statusCode }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.updateTechaeonStatus(id, statusCode), null, 2) },
      ],
    })
  );

  server.tool(
    "update_techaeon_redirect",
    "Set or clear the redirect URL for a techaeon",
    {
      id: z.string().describe("Techaeon GUID"),
      redirectUrl: z.string().nullable().describe("New redirect URL, or null to remove"),
    },
    async ({ id, redirectUrl }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await client.updateTechaeonRedirect(id, redirectUrl), null, 2),
        },
      ],
    })
  );

  server.tool(
    "delete_techaeon",
    "Soft-delete a techaeon (marks it inactive). Returns 204 No Content on success.",
    { id: z.string().describe("Techaeon GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.deleteTechaeon(id), null, 2) }],
    })
  );

  // ── Group Tools ──

  server.tool(
    "list_groups",
    "List techaeon groups with pagination, sorting, and search. Returns { data: [...], pagination: { totalCount, page, pageSize, totalPages } }.",
    {
      pageNo: z.number().optional().describe("Page number (1-based)"),
      pageSize: z.number().optional().describe("Results per page"),
      sortBy: z.string().optional().describe("Field to sort by (e.g. GroupName, CreatedOn)"),
      sortDirection: z.enum(["asc", "desc"]).optional(),
      searchTerm: z.string().optional().describe("Search group names"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.listGroups(params), null, 2) }],
    })
  );

  server.tool(
    "create_group",
    "Create a techaeon group and bulk-generate techaeons within it",
    {
      groupName: z.string().describe("Display name for the group"),
      noOfTechaeons: z.number().describe("Number of techaeons to generate"),
      eventId: z.string().optional().describe("Event GUID to link and auto-assign Entry privileges"),
      redirectUrl: z.string().optional().describe("Redirect URL for all techaeons in the group"),
      isTechaeonCodeEnabled: z
        .boolean()
        .optional()
        .describe("Generate unique short codes for QR/manual entry"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.createGroup(params), null, 2) }],
    })
  );

  server.tool(
    "update_group",
    "Update an existing techaeon group's name, event link, redirect URL, or code settings",
    {
      id: z.string().describe("Group GUID"),
      groupName: z.string().describe("Updated group name"),
      eventId: z.string().optional().describe("Event GUID to link"),
      redirectUrl: z.string().optional().describe("Redirect URL (null/empty to remove)"),
      isTechaeonCodeEnabled: z.boolean().optional().describe("Toggle short code generation"),
    },
    async ({ id, ...params }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.updateGroup(id, params), null, 2) }],
    })
  );

  // ── Event Tools ──

  server.tool(
    "get_event",
    "Get public details of an event by ID: title, dates, status, type, venue/design reference IDs, ticketing status",
    { id: z.string().describe("Event GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getEvent(id), null, 2) }],
    })
  );

  // ── Guest Tools ──

  server.tool(
    "list_guests",
    "List guests for an event with pagination, search, and filtering. Returns { data: [...], pagination: { totalCount, page, pageSize, totalPages } }. Each guest includes invitation status.",
    {
      eventId: z.string().describe("Event GUID"),
      pageNo: z.number().optional().describe("Page number (1-based)"),
      pageSize: z.number().optional().describe("Results per page"),
      searchTerm: z.string().optional().describe("Search by name, email, or phone"),
      groupId: z.string().optional().describe("Filter by guest group GUID"),
      designMappingId: z.string().optional().describe("Filter by invitation design GUID"),
      sortBy: z.string().optional().describe("Field to sort by"),
      sortDirection: z.enum(["asc", "desc"]).optional(),
    },
    async ({ eventId, ...params }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.listGuests(eventId, params), null, 2) }],
    })
  );

  server.tool(
    "get_guest",
    "Get one guest's full details by ID, including their invitation and their custom field values. This is the only guest read that returns custom fields: each comes back resolved as { id, fieldKey, label, dataType, value }, where id is the field definition id (the key you write it under). customFields is empty or absent when none are set.",
    {
      id: z.string().describe("Guest GUID"),
      invitationId: z
        .string()
        .optional()
        .describe("Return this invitation instead of the guest's current one, for a guest with more than one"),
    },
    async ({ id, invitationId }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getGuest(id, invitationId), null, 2) }],
    })
  );

  server.tool(
    "create_guest",
    "Create a new guest for an event and optionally issue an invitation. groupId is required — use list_guest_groups to find valid IDs. customFields is keyed by custom field DEFINITION ID (from list_custom_fields with entityType GUEST), not by fieldKey; every ACTIVE mandatory guest field must be included, or omit customFields entirely to set none.",
    {
      eventId: z.string().describe("Event GUID"),
      firstName: z.string().describe("Guest first name (required)"),
      lastName: z.string().optional(),
      displayName: z.string().optional(),
      phone: z.string().optional().describe("Phone with country code (required if no email)"),
      email: z.string().optional().describe("Email (required if no phone)"),
      groupId: z.string().describe("Guest group GUID (required) — use list_guest_groups to get valid values"),
      isUpdateAllEvent: z.boolean().optional().describe("Apply contact changes to all events for this guest"),
      techaeonCode: z.string().optional().describe("Link a techaeon by its short code"),
      guestCode: z.string().optional().describe("Custom unique code for this guest"),
      invitationDesignMappingId: z.string().optional().describe("Create an invitation using this design GUID"),
      invitationGuestPasses: z.number().optional().describe("Number of passes on the invitation"),
      invitationIsUnlimited: z.boolean().optional().describe("Unlimited passes on the invitation"),
      customFields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Custom field values keyed by definition id, e.g. { "<definitionId>": "Vegan" }'),
    },
    async ({ eventId, invitationDesignMappingId, invitationGuestPasses, invitationIsUnlimited, ...params }) => {
      const invitation = invitationDesignMappingId
        ? { designMappingId: invitationDesignMappingId, guestPasses: invitationGuestPasses, isUnlimited: invitationIsUnlimited }
        : undefined;
      return {
        content: [{ type: "text", text: JSON.stringify(await client.createGuest({ eventId, ...params, invitation }), null, 2) }],
      };
    }
  );

  server.tool(
    "update_guest",
    "Update an existing guest's details or invitation. groupId is required. This replaces the guest record, EXCEPT customFields: those are merged by definition id — only the keys you send are validated and written, and omitting customFields leaves every existing value untouched.",
    {
      id: z.string().describe("Guest GUID"),
      eventId: z.string().describe("Event GUID"),
      firstName: z.string().describe("Guest first name (required)"),
      lastName: z.string().optional(),
      displayName: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      groupId: z.string().describe("Guest group GUID (required)"),
      isUpdateAllEvent: z.boolean().optional(),
      techaeonCode: z.string().optional(),
      guestCode: z.string().optional(),
      invitationId: z.string().optional().describe("Invitation GUID to update"),
      invitationDesignMappingId: z.string().optional(),
      invitationGuestPasses: z.number().optional(),
      invitationIsUnlimited: z.boolean().optional(),
      invitationStatusId: z.string().optional().describe("New invitation status GUID"),
      customFields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Custom field values keyed by definition id. Merged: keys not sent are left as they are."),
    },
    async ({ id, invitationId, invitationDesignMappingId, invitationGuestPasses, invitationIsUnlimited, invitationStatusId, ...params }) => {
      const invitation =
        invitationId && invitationDesignMappingId
          ? { id: invitationId, designMappingId: invitationDesignMappingId, guestPasses: invitationGuestPasses, isUnlimited: invitationIsUnlimited, statusId: invitationStatusId }
          : undefined;
      return {
        content: [{ type: "text", text: JSON.stringify(await client.updateGuest(id, { ...params, invitation }), null, 2) }],
      };
    }
  );

  server.tool(
    "patch_guest",
    "Partially update a guest — only the fields you pass are changed, everything else is left alone. Prefer this over update_guest for small edits, since update_guest requires firstName and groupId even when you aren't changing them.",
    {
      id: z.string().describe("Guest GUID"),
      eventId: z.string().optional().describe("Event GUID — include it; the API scopes the guest by event"),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      displayName: z.string().optional(),
      phone: z.string().nullable().optional().describe("null clears it"),
      email: z.string().nullable().optional().describe("null clears it"),
      groupId: z.string().optional().describe("Guest group GUID"),
      isUpdateAllEvent: z.boolean().optional().describe("Apply contact changes across all of this guest's events"),
      techaeonCode: z.string().nullable().optional(),
      guestCode: z.string().nullable().optional(),
      invitationDesignMappingId: z.string().optional(),
      invitationGuestPasses: z.number().nullable().optional(),
      invitationIsUnlimited: z.boolean().nullable().optional(),
      invitationStatusId: z.string().optional().describe("New invitation status GUID"),
      customFields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          "Custom field values keyed by definition id. Only the keys present are touched: a value sets that field, null clears it. Omit to change no custom fields."
        ),
    },
    async ({
      id,
      invitationDesignMappingId,
      invitationGuestPasses,
      invitationIsUnlimited,
      invitationStatusId,
      ...params
    }) => {
      // Only send `invitation` when something in it was actually provided —
      // an empty object would be a change under merge-patch semantics.
      const invitation = {
        designMappingId: invitationDesignMappingId,
        guestPasses: invitationGuestPasses,
        isUnlimited: invitationIsUnlimited,
        statusId: invitationStatusId,
      };
      const hasInvitation = Object.values(invitation).some((v) => v !== undefined);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await client.patchGuest(id, hasInvitation ? { ...params, invitation } : params),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "delete_guest",
    "Soft-delete a guest. If invitationId is provided, only that invitation is removed; the guest record stays if other invitations remain.",
    {
      id: z.string().describe("Guest GUID"),
      invitationId: z.string().optional().describe("Remove only this invitation instead of the full guest"),
    },
    async ({ id, invitationId }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.deleteGuest(id, invitationId), null, 2) }],
    })
  );

  server.tool(
    "send_invite",
    "Send or resend invitations to guests in an event. Use sendToAll=true or provide specific guestIds. Updates invitation status to SENT.",
    {
      eventId: z.string().describe("Event GUID"),
      sendToAll: z.boolean().optional().describe("Send to all active guests in the event"),
      guestIds: z.array(z.string()).optional().describe("Specific guest GUIDs to invite"),
      inviteMessageTemplate: z.string().optional().describe("Message template to use for the invite"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.sendInvite(params), null, 2) }],
    })
  );

  server.tool(
    "send_message_to_guests",
    "Send a message to guests in an event via InApp (1), SMS (2), and/or Email (3). Use sendToAll=true or specific guestIds.",
    {
      eventId: z.string().describe("Event GUID"),
      messageBody: z.string().describe("Message text to send"),
      sendToAll: z.boolean().optional().describe("Send to all active guests (excludes DECLINED)"),
      guestIds: z.array(z.string()).optional().describe("Specific guest GUIDs"),
      typeIds: z.array(z.number()).optional().describe("Channel IDs: 1=InApp, 2=SMS, 3=Email"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.sendMessageToGuests(params), null, 2) }],
    })
  );

  // ── Contact Tools ──

  server.tool(
    "list_contacts",
    "List contacts for your organization (resolved from the API key) with pagination and search. Returns { data: [...], pagination }.",
    {
      pageNo: z.number().optional(),
      pageSize: z.number().optional(),
      searchTerm: z.string().optional(),
      sortBy: z.string().optional(),
      sortDirection: z.enum(["asc", "desc"]).optional(),
      includeAll: z.boolean().optional().describe("Include all contacts (default true)"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.listContacts(params), null, 2) }],
    })
  );

  server.tool(
    "get_contact",
    "Get full details of a single contact by ID",
    { id: z.string().describe("Contact GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getContact(id), null, 2) }],
    })
  );

  server.tool(
    "create_contact",
    "Create a new contact for your organization (resolved from the API key). firstName is required. At least one of phone or email should be provided.",
    {
      firstName: z.string().describe("Required"),
      lastName: z.string().optional(),
      displayName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional().describe("Include country code, e.g. +12025550191"),
      address: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      zip: z.string().optional(),
      socialHandle: z.string().optional(),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.createContact(params), null, 2) }],
    })
  );

  server.tool(
    "update_contact",
    "Update an existing contact's details. firstName is required.",
    {
      id: z.string().describe("Contact GUID"),
      firstName: z.string().describe("Required"),
      lastName: z.string().optional(),
      displayName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      userId: z.string().optional().describe("Link to a platform user account GUID"),
      address: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
      zip: z.string().optional(),
      socialHandle: z.string().optional(),
    },
    async ({ id, ...params }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.updateContact(id, params), null, 2) }],
    })
  );

  server.tool(
    "delete_contact",
    "Soft-delete a contact (marks inactive)",
    { id: z.string().describe("Contact GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.deleteContact(id), null, 2) }],
    })
  );

  server.tool(
    "send_message_to_contacts",
    "Send a message to specific contacts via InApp (1), SMS (2), and/or Email (3).",
    {
      messageBody: z.string().describe("Message text"),
      contactIds: z.array(z.string()).describe("Contact GUIDs to message"),
      typeIds: z.array(z.number()).optional().describe("Channel IDs: 1=InApp, 2=SMS, 3=Email"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.sendMessageToContacts(params), null, 2) }],
    })
  );

  server.tool(
    "upload_contacts",
    "Bulk create or update contacts from a list. Matches existing contacts by phone/email and upserts; on a match, blank optional fields keep the contact's current value. ALL-OR-NOTHING: if any row fails validation, no contacts are saved, and the failing rows come back in errorItems with per-field errors — fix those and resend the whole list. Each row needs firstName and a phone or email. Returns counts of new/updated/error records.",
    {
      contacts: z.array(
        z.object({
          firstName: z.string(),
          lastName: z.string().optional(),
          displayName: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().optional(),
          address: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          country: z.string().optional(),
          zip: z.string().optional(),
          socialHandle: z.string().optional(),
        })
      ).describe("List of contacts to import"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.uploadContacts(params), null, 2) }],
    })
  );


  // ── Chat: conversations ──
  //
  // The Message API. A conversation is one Org↔Contact thread; messages carry
  // optional attachments and an optional event tag.

  server.tool(
    "list_conversations",
    "List the organization's chat conversations, newest activity first. Returns { data: [...], pagination: { totalCount, page, pageSize, totalPages } }. Each conversation carries its contact, lastMessage, unreadCount, and isReadByUser. unreadCount is the organization's as THIS KEY sees it — every key has its own read state, separate from every person's — and spans the whole thread, since the app's 'since you joined' cutoff needs a membership row a key does not have. lastMessage is null on a thread with no messages yet. Its attachments ARE populated here — unlike get_conversation and get_conversation_with_contact, which always null the field out — so on this endpoint attachments: null genuinely means the message has no files. To reach one known contact's thread prefer get_conversation_with_contact, which returns it directly and can create it; contactId here only filters an existing list.",
    {
      pageNo: z.number().optional().describe("Page number (1-based, default 1)"),
      pageSize: z.number().optional().describe("Results per page (default 100)"),
      searchTerm: z
        .string()
        .optional()
        .describe("Matches either side: contact name/email/phone, or the organization's"),
      isUnreadOnly: z.boolean().optional().describe("Only conversations with a non-zero unread count"),
      contactId: z
        .string()
        .optional()
        .describe(
          "Keep only the conversation with this contact. A contact of another organization matches nothing and returns an empty page rather than an error. Required when view='Contact'."
        ),
      view: z
        .enum(["Auto", "Organization", "Contact"])
        .optional()
        .describe(
          "Which seat each row is reported from — it sets callerRole and nothing else. Omit it (the API default, Auto) or pass Organization for callerRole 'ORG_MEMBER'. 'Contact' REQUIRES contactId and returns that one contact's conversation with callerRole 'CONTACT'; without contactId it fails with CONTACT_ID_REQUIRED. The unread count and read receipts are the organization's on every value, since that is the side the key acts as."
        ),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.listConversations(params), null, 2) }],
    })
  );

  server.tool(
    "get_conversation",
    "Get one conversation by ID, including its participants, last message, and current unread count. Must belong to your organization. unreadCount is the organization's as this key sees it (each key has its own read state, moved by mark_conversation_read) and counts either side, so a message recorded with sendFrom='Contact' raises it rather than clearing it. isReadByUser says whether the CONTACT has read your last message; it stays false on a thread whose contact has no registered account, since they have no way to record a read. lastMessage is a preview: its attachments is ALWAYS null here, which means this projection does not carry files, NOT that the message had none. The same is true of get_conversation_with_contact, but NOT of list_conversations, which does populate them. Read a message's real attachments with list_messages.",
    {
      id: z.string().describe("Conversation GUID"),
      view: z
        .enum(["Auto", "Organization", "Contact"])
        .optional()
        .describe(
          "Which seat the conversation is reported from — it sets callerRole and nothing else. Omit it (the API default, Auto) or pass Organization for 'ORG_MEMBER'; 'Contact' reports 'CONTACT' for the thread's own contact and needs no id. Every other field, unreadCount and isReadByUser included, is the organization's on every value, since that is the side the key reads as. Reading from the contact's seat is not the same as recording a message AS the contact — that is send_chat_message with sendFrom='Contact'."
        ),
    },
    async ({ id, view }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getConversation(id, view), null, 2) }],
    })
  );

  server.tool(
    "get_conversation_with_contact",
    "Get the conversation with a specific contact, optionally creating it if none exists yet (get-or-create). This is the usual entry point: guest id → get_contact_by_guest → this call with isCreateNew=true → send. With isCreateNew=false and no thread yet the API answers 404 — that is the documented contract, not a failure, so treat it as 'no conversation' rather than an error. Takes no view: callerRole is always ORG_MEMBER, since a key reads as its own organization. Like get_conversation, its lastMessage.attachments is always null whether or not the message has files — use list_messages for those.",
    {
      contactId: z.string().describe("Contact GUID — must be a contact of your organization"),
      isCreateNew: z
        .boolean()
        .describe("Create the conversation if it does not exist yet. Required — there is no default."),
    },
    async ({ contactId, isCreateNew }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await client.getConversationWithContact(contactId, isCreateNew), null, 2),
        },
      ],
    })
  );

  server.tool(
    "create_conversation",
    "Open the conversation with a contact. Get-or-create, not create-only: a conversation is identified by (organization, contact), so calling this for a contact that already has a thread returns the existing one rather than creating a duplicate. get_conversation_with_contact does the same job and can also be used get-only, so prefer it when you may just want to look the thread up.",
    { contactId: z.string().describe("Contact GUID — must be a contact of your organization") },
    async ({ contactId }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.createConversation(contactId), null, 2) }],
    })
  );

  server.tool(
    "list_messages",
    "List a conversation's messages, paginated. Branch on isFromOrganization to tell the two sides apart — it is recorded when the message is sent. Do NOT infer the side by comparing senderId against a contactId: senderId holds the contact's id on an SMS reply or a sendFrom='Contact' send, but their user id when they sent from their own app. Render from the sender block. On the organization side, senderType is 'ApiKey' for a message an API key sent (senderId is then the key's id and senderApiKeyName its name, also copied to sender.firstName) and 'User' for one a person sent; messages sent through the API before keys had their own identity still show the organization owner as a 'User'. isRead is the organization's receipt: messages from the contact are always true, and one you sent turns true once they read past it — it stays false indefinitely for a contact with no registered account, which is not a delivery failure. This is the ONLY read that reports a message's attachments — they come back inline on each message, and the field is null rather than [] when a message has no files, so test its length rather than its presence. Returns { data: [...], pagination: {...} }.",
    {
      conversationId: z.string().describe("Conversation GUID"),
      eventId: z
        .string()
        .optional()
        .describe("Only messages tagged to this event. Untagged messages, inbound SMS included, are excluded."),
      pageNo: z.number().optional().describe("Page number (1-based, default 1)"),
      pageSize: z.number().optional().describe("Messages per page (default 100)"),
      searchTerm: z.string().optional().describe("Case-insensitive substring match on the message body"),
      view: z
        .enum(["Auto", "Organization", "Contact"])
        .optional()
        .describe(
          "Accepted only so you can pass the same value you sent to get_conversation. A message carries no callerRole of its own, so every value returns the identical page and isRead is the organization's receipt throughout. Omitting it is fine; it filters nothing."
        ),
    },
    async ({ conversationId, ...params }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.listMessages(conversationId, params), null, 2) },
      ],
    })
  );

  server.tool(
    "send_chat_message",
    "Send a message into a conversation. sendFrom is required and says which side the message is from — there is no default, and omitting it is rejected. sendFrom='Organization' is the normal case: it delivers on whichever of inApp/inSMS/inEmail you enable, is attributed to this API key itself (senderType 'ApiKey', senderId = the key's id, the key's name as the sender), and marks the thread read for this key. sendFrom='Contact' (with contactId) records a message as coming from the contact, the way an inbound SMS reply is stored — that dispatches nothing to them, since the channel flags describe how to reach the contact, and it raises the organization's unread count instead of clearing it. Set at least one channel on any message meant to reach the person: a send with every channel off is stored and pushed live but dispatches nothing, and it returns the same 200 as one that delivered — the inApp/inSMS/inEmail echoed on lastMessage are the only way to tell the two apart. Unlike the conversation reads, the lastMessage returned HERE does carry the attachments that were stored, each under a newly assigned id — the upload's id is not reused.",
    {
      conversationId: z.string().describe("Conversation GUID — must belong to your organization"),
      sendFrom: z
        .enum(["Organization", "Contact"])
        .describe(
          "Required — which side the message is from. 'Organization' sends as your organization; 'Contact' records it as the contact's own message. There is no default: a request without it fails."
        ),
      messageBody: z.string().optional().describe("Message text. Omit to send attachments only."),
      contactId: z
        .string()
        .optional()
        .describe("Required when sendFrom='Contact'. Must be this conversation's own contact."),
      eventId: z
        .string()
        .optional()
        .describe(
          "Tag the message to one of your organization's events. Validated before anything is stored: an unknown id, a deleted one, or an event of another organization is rejected with EVENT_NOT_LINKED, so a tag that is accepted always resolves to a real eventName when the message is read back."
        ),
      attachments: z
        .array(
          z.object({
            id: z.string().describe("Attachment id from upload_message_attachments"),
            url: z.string().describe("Public URL from upload_message_attachments"),
            fileName: z.string().optional(),
            fileType: z.string().optional(),
            storageFileName: z.string().optional(),
          })
        )
        .optional()
        .describe("Files to attach, using the records returned by upload_message_attachments"),
      inApp: z.boolean().optional().describe("Deliver as an in-app push. Only reaches contacts with a user account."),
      inSMS: z.boolean().optional().describe("Deliver by SMS. This is the channel the contact replies on."),
      inEmail: z.boolean().optional().describe("Deliver by email"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.sendChatMessage(params), null, 2) }],
    })
  );

  server.tool(
    "mark_conversation_read",
    "Mark a conversation read up to now, clearing its unread count. Always records the ORGANIZATION as the reader — there is no contact-side mark-read on this surface, so do not call it to represent the contact reading. The read state is this API key's own — every key has one, separate from every person's — so this does NOT clear any badge in the web app, and a person reading the thread there does not change this key's unreadCount. The contact still gets a 'seen' receipt. Idempotent, and the read mark only moves forward. Returns the recorded readDate.",
    { id: z.string().describe("Conversation GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.markConversationRead(id), null, 2) }],
    })
  );

  server.tool(
    "get_contact_by_guest",
    "Resolve an event guest ID to the contact record behind it. Use this to get the contactId needed to open a conversation with an event's guest.",
    { guestId: z.string().describe("Guest GUID — must be a guest of one of your organization's events") },
    async ({ guestId }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getContactByGuest(guestId), null, 2) }],
    })
  );

  server.tool(
    "upload_message_attachments",
    "Upload files for use as chat attachments, then pass the returned records to send_chat_message verbatim. Files are base64-encoded in the request, so this is practical for small files only — the encoded bytes have to pass through the conversation. The id returned here identifies the upload, not the sent attachment: storing the message assigns a fresh id, while url and storageFileName carry through unchanged.",
    {
      files: z
        .array(
          z.object({
            fileName: z.string().describe("Original file name, e.g. ticket.png"),
            fileType: z.string().optional().describe("MIME type, e.g. image/png"),
            contentBase64: z.string().describe("Base64-encoded file content"),
          })
        )
        .describe("Files to upload — at least one"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.uploadMessageDocs(params), null, 2) }],
    })
  );

  server.tool(
    "list_guest_groups",
    "Get all guest groups available for your organization (resolved from the API key), plus system defaults. Not paginated — always returns the full list. Use the returned IDs when creating or updating guests.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await client.listGuestGroups(), null, 2) }],
    })
  );

  // ── Custom fields ──
  //
  // Organization-defined fields per record type. Definitions live here; values
  // are written on the record — today the guest tools' customFields, keyed by
  // definition id. DRAFT is the status that matters: shape changes are free
  // while a field holds it and guarded once it leaves.

  const entityType = z
    .enum(["GUEST", "CONTACT", "EVENT", "ORGANIZATION", "TECHAEON"])
    .describe("Record type the field belongs to");
  const customFieldStatus = z.enum(["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"]);
  const fieldOptions = z
    .array(
      z.object({
        id: z.string().optional().describe("Existing option id — include it to keep that option through a replace"),
        optionLabel: z.string(),
        optionValue: z.string().optional().describe("Generated from optionLabel when omitted"),
        orderIndex: z.number().optional(),
      })
    )
    .describe("Choices for a SELECT field. Sending this replaces the whole set; [] removes every option.");
  const rules = z
    .record(z.string(), z.unknown())
    .describe("Legal keys depend on dataType — see get_custom_field_schema, e.g. { maxLength: 200 } for TEXT");
  const hints = z
    .record(z.string(), z.unknown())
    .describe("Keys: placeholder, helpLink, showInGrid, gridWidth, rows, currencyCode");

  server.tool(
    "list_custom_fields",
    "List your organization's custom field definitions for one record type, ordered by orderIndex. Returns every status unless you pass status. Use the returned ids as the keys of a guest's customFields. validationRules and uiHints come back as JSON strings, not objects.",
    {
      entityType,
      status: customFieldStatus.optional().describe("Return only fields in exactly this status, e.g. ACTIVE"),
    },
    async ({ entityType, status }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.listCustomFields(entityType, status), null, 2) },
      ],
    })
  );

  server.tool(
    "get_custom_field",
    "Get one custom field definition by ID, in any status, with its options.",
    { id: z.string().describe("Custom field definition GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getCustomField(id), null, 2) }],
    })
  );

  server.tool(
    "get_custom_field_schema",
    "Get the legal values for defining a custom field: dataTypes (and the subset usable today, phase1SupportedDataTypes), widgetTypes, cardinalities, statuses, uiHint keys, and the legal widgets and validation-rule keys per dataType. Call this before create/update/patch rather than guessing.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await client.getCustomFieldSchema(), null, 2) }],
    })
  );

  server.tool(
    "create_custom_field",
    "Define a new custom field for a record type. It starts as DRAFT — invisible on every form until set ACTIVE with update_custom_field_status — unless you pass another status, which also switches on breaking-change protection immediately. fieldKey must be unique per organization + entityType + namespace. options is required for SELECT. widgetType and cardinality are derived from dataType when omitted.",
    {
      entityType,
      fieldKey: z.string().describe("Machine key, e.g. dietary_notes. Lowercase, starts with a letter, max 60 chars"),
      label: z.string().describe("Display name on forms, max 120 chars"),
      dataType: z
        .string()
        .describe("TEXT, LONGTEXT, NUMBER, BOOLEAN, DATE or SELECT are usable today; DECIMAL, DATETIME, EMAIL, PHONE, URL are planned"),
      scopeEntityType: z
        .enum(["ORGANIZATION", "EVENT"])
        .optional()
        .describe("ORGANIZATION (default) applies across every event; EVENT applies to one, given by scopeId"),
      scopeId: z.string().optional().describe("Event GUID — required when scopeEntityType is EVENT"),
      fieldNamespace: z
        .string()
        .optional()
        .describe("Default 'org'. Lowercase; 'system' and 'app:*' are reserved"),
      helperText: z.string().optional().describe("Help text shown beneath the field"),
      widgetType: z.string().optional().describe("e.g. TEXT_INPUT, DROPDOWN, CHECKBOX — derived when omitted"),
      cardinality: z.enum(["SINGLE", "LIST"]).optional(),
      isMandatory: z.boolean().optional().describe("A value is required to submit the form (default false)"),
      isPii: z.boolean().optional().describe("Flags the field as personal data (default false)"),
      status: customFieldStatus.optional().describe("Default DRAFT"),
      validationRules: rules.optional(),
      uiHints: hints.optional(),
      groupKey: z.string().optional().describe("Free-text section heading for grouping fields"),
      orderIndex: z.number().optional().describe("Sort position, lower first (default 0)"),
      options: fieldOptions.optional(),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.createCustomField(params), null, 2) }],
    })
  );

  server.tool(
    "update_custom_field",
    "Full update of a custom field's shape — send EVERY field, not only the ones changing: omitted validationRules and uiHints are cleared. Prefer patch_custom_field for small edits. Once the field has left DRAFT, changing dataType or cardinality, turning isMandatory on, or removing an option fails with CUSTOM_FIELD_BREAKING_CHANGE — deprecate it and create a replacement instead.",
    {
      id: z.string().describe("Custom field definition GUID"),
      fieldKey: z.string().describe("Renaming is a safe change"),
      label: z.string(),
      dataType: z.string(),
      helperText: z.string().optional(),
      widgetType: z.string().optional().describe("Derived from dataType when omitted"),
      cardinality: z.enum(["SINGLE", "LIST"]).optional(),
      isMandatory: z.boolean().optional(),
      isPii: z.boolean().optional(),
      validationRules: rules.optional(),
      uiHints: hints.optional(),
      groupKey: z.string().optional(),
      orderIndex: z.number().optional(),
      options: fieldOptions
        .optional()
        .describe("Omit to leave options as they are; [] removes all; otherwise a full replace — keep an existing option by including its id"),
    },
    async ({ id, ...params }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.updateCustomField(id, params), null, 2) }],
    })
  );

  server.tool(
    "patch_custom_field",
    "Partially update a custom field — only the fields you pass change. null clears helperText, groupKey, validationRules or uiHints; null on widgetType or cardinality re-derives it from dataType. validationRules and uiHints are each replaced whole when sent. The same post-DRAFT breaking-change rules as update_custom_field apply.",
    {
      id: z.string().describe("Custom field definition GUID"),
      fieldKey: z.string().optional(),
      label: z.string().optional(),
      helperText: z.string().nullable().optional(),
      dataType: z.string().optional(),
      widgetType: z.string().nullable().optional(),
      cardinality: z.enum(["SINGLE", "LIST"]).nullable().optional(),
      isMandatory: z.boolean().optional(),
      isPii: z.boolean().optional(),
      validationRules: rules.nullable().optional(),
      uiHints: hints.nullable().optional(),
      groupKey: z.string().nullable().optional(),
      orderIndex: z.number().optional(),
      options: fieldOptions
        .optional()
        .describe("Omit to leave options as they are; [] removes all; otherwise a full replace — keep an existing option by including its id"),
    },
    async ({ id, ...params }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.patchCustomField(id, params), null, 2) }],
    })
  );

  server.tool(
    "update_custom_field_status",
    "Set a custom field's status. Any status can move to any other. ACTIVE makes it appear on forms (and, if mandatory, required on guest create); DEPRECATED or ARCHIVED retires it while keeping existing answers visible. Leaving DRAFT switches on breaking-change protection for update/patch.",
    {
      id: z.string().describe("Custom field definition GUID"),
      status: customFieldStatus,
    },
    async ({ id, status }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.changeCustomFieldStatus(id, status), null, 2) },
      ],
    })
  );

  server.tool(
    "reorder_custom_fields",
    "Set the sort position of several custom fields of one record type in one call. Fields not listed keep their position; ids that are not your organization's fields of this entityType are skipped silently rather than rejected. Returns true.",
    {
      entityType,
      ordering: z
        .array(z.object({ id: z.string(), orderIndex: z.number() }))
        .describe("One entry per field being repositioned"),
    },
    async ({ entityType, ordering }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.reorderCustomFields(entityType, ordering), null, 2) },
      ],
    })
  );

  server.tool(
    "delete_custom_field",
    "Soft-delete a custom field definition. Only works while the field is DRAFT — past that it may already hold answers, so the API refuses with CUSTOM_FIELD_BREAKING_CHANGE. Retire a live field with update_custom_field_status (DEPRECATED or ARCHIVED) instead.",
    { id: z.string().describe("Custom field definition GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.deleteCustomField(id), null, 2) }],
    })
  );


  // ── Chat: realtime (SignalR) ──
  //
  // Registered only when the host keeps a process alive between tool calls —
  // see ServerOptions.realtimeApiKey. The hub is receive-only, so there is no
  // "send over the socket" tool: sending is send_chat_message, and marking read
  // is mark_conversation_read.

  if (realtimeApiKey) {
    const apiKey = realtimeApiKey;

    server.tool(
      "chat_realtime_connect",
      "Open a live SignalR subscription to the chat hub and start buffering pushed events, which you then read with chat_realtime_poll. Omit contactId to watch every conversation in your organization; pass one to watch that single thread instead — the contact scope REPLACES the organization scope rather than adding to it, so watching both at once means calling this twice. Calling it again for a scope already open just returns that subscription.",
      {
        contactId: z
          .string()
          .optional()
          .describe(
            "Narrow to one contact's thread. Must be a contact of your organization — an unknown one fails the handshake with 401, it does not fall back to the org-wide scope."
          ),
        bufferSize: z
          .number()
          .optional()
          .describe("Events to hold before evicting the oldest (default 200, max 2000)"),
      },
      async ({ contactId, bufferSize }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(await connectRealtime(apiKey, { contactId, bufferSize }), null, 2),
          },
        ],
      })
    );

    server.tool(
      "chat_realtime_poll",
      "Read chat events buffered since your last poll. Two event types arrive: ReceiveMessage (a message was sent — branch on lastMessage.isFromOrganization for which side, never on senderId, and note your OWN sends echo back here, so reconcile on lastMessage.id) and MarkMessagesRead (a read receipt — branch on readByContact for the direction). The cursor advances by itself, so repeated bare calls return only what is new. If status.reconnects is non-zero or status.dropped is above 0, events were missed: re-read with list_messages rather than trusting the buffer.",
      {
        contactId: z
          .string()
          .optional()
          .describe("Which subscription to read. Omit for the organization-wide one."),
        sinceSeq: z
          .number()
          .optional()
          .describe("Re-read from this seq instead of the auto-advancing cursor, as far back as the buffer still holds"),
        limit: z.number().optional().describe("Maximum events to return (default 50, max 500)"),
      },
      async ({ contactId, sinceSeq, limit }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(await pollRealtime(apiKey, { contactId, sinceSeq, limit }), null, 2),
          },
        ],
      })
    );

    server.tool(
      "chat_realtime_status",
      "List your open realtime subscriptions with their connection state, buffered/received/dropped counts, and reconnect count. Returns an empty list when nothing is subscribed.",
      {},
      async () => ({
        content: [{ type: "text", text: JSON.stringify(await realtimeStatus(apiKey), null, 2) }],
      })
    );

    server.tool(
      "chat_realtime_disconnect",
      "Close a realtime subscription and discard its buffered events. Closes the organization-wide one by default.",
      {
        contactId: z.string().optional().describe("Close this contact-scoped subscription instead"),
        all: z.boolean().optional().describe("Close every subscription this key holds"),
      },
      async ({ contactId, all }) => ({
        content: [
          { type: "text", text: JSON.stringify(await disconnectRealtime(apiKey, { contactId, all }), null, 2) },
        ],
      })
    );
  }

  return server;
}
