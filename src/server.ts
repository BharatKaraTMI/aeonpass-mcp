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
    "create_guest",
    "Create a new guest for an event and optionally issue an invitation. groupId is required — use list_guest_groups to find valid IDs.",
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
    "Update an existing guest's details or invitation. groupId is required.",
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
    "Bulk create or update contacts from a list. Matches existing contacts by phone/email and upserts. Returns counts of new/updated/error records.",
    {
      contacts: z.array(
        z.object({
          firstName: z.string(),
          lastName: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().optional(),
          state: z.string().optional(),
          country: z.string().optional(),
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
    "List the organization's chat conversations, newest activity first. Returns { data: [...], pagination: { totalCount, page, pageSize, totalPages } }. Each conversation carries its contact, lastMessage, unreadCount, and isReadByUser.",
    {
      pageNo: z.number().optional().describe("Page number (1-based, default 1)"),
      pageSize: z.number().optional().describe("Results per page (default 100)"),
      searchTerm: z
        .string()
        .optional()
        .describe("Matches either side: contact name/email/phone, or the organization's"),
      isUnreadOnly: z.boolean().optional().describe("Only conversations with a non-zero unread count"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.listConversations(params), null, 2) }],
    })
  );

  server.tool(
    "get_conversation",
    "Get one conversation by ID, including its participants, last message, and current unread count. Must belong to your organization.",
    { id: z.string().describe("Conversation GUID") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getConversation(id), null, 2) }],
    })
  );

  server.tool(
    "get_conversation_with_contact",
    "Get the conversation with a specific contact, optionally creating it if none exists yet (get-or-create). Prefer this over create_conversation when you just want the thread.",
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
    "Start a new conversation with a contact. If a thread with that contact may already exist, use get_conversation_with_contact instead.",
    { contactId: z.string().describe("Contact GUID — must be a contact of your organization") },
    async ({ contactId }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.createConversation(contactId), null, 2) }],
    })
  );

  server.tool(
    "list_messages",
    "List a conversation's messages, paginated. Branch on each message's isFromOrganization to tell which side sent it. Returns { data: [...], pagination: {...} }.",
    {
      conversationId: z.string().describe("Conversation GUID"),
      eventId: z
        .string()
        .optional()
        .describe("Only messages tagged to this event. Untagged messages, inbound SMS included, are excluded."),
      pageNo: z.number().optional().describe("Page number (1-based, default 1)"),
      pageSize: z.number().optional().describe("Messages per page (default 100)"),
      searchTerm: z.string().optional().describe("Case-insensitive substring match on the message body"),
    },
    async ({ conversationId, ...params }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.listMessages(conversationId, params), null, 2) },
      ],
    })
  );

  server.tool(
    "send_chat_message",
    "Send a message into a conversation. By default it is attributed to the organization and delivered on whichever of inApp/inSMS/inEmail you enable. Set sendFrom='Contact' (with contactId) to record a message as coming from the contact, the way an inbound SMS reply is stored — that dispatches nothing to them, since the channel flags describe how to reach the contact.",
    {
      conversationId: z.string().describe("Conversation GUID — must belong to your organization"),
      messageBody: z.string().optional().describe("Message text. Omit to send attachments only."),
      sendFrom: z
        .enum(["Organization", "Contact"])
        .optional()
        .describe("Which side the message is from. Defaults to Organization."),
      contactId: z
        .string()
        .optional()
        .describe("Required when sendFrom='Contact'. Must be this conversation's own contact."),
      eventId: z.string().optional().describe("Tag the message to one of your organization's events"),
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
    "Mark a conversation read up to now, clearing its unread count. Always records the ORGANIZATION as the reader — there is no contact-side mark-read on this surface. Returns the recorded readDate.",
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
    "Upload files for use as chat attachments, then pass the returned records to send_chat_message. Files are base64-encoded in the request, so this is practical for small files only — the encoded bytes have to pass through the conversation.",
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
      "Read chat events buffered since your last poll. Two event types arrive: ReceiveMessage (a message was sent — branch on lastMessage.isFromOrganization for which side, and note your OWN sends echo back here, so reconcile on lastMessage.id) and MarkMessagesRead (a read receipt — branch on readByContact for the direction). The cursor advances by itself, so repeated bare calls return only what is new. If status.reconnects is non-zero or status.dropped is above 0, events were missed: re-read with list_messages rather than trusting the buffer.",
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
