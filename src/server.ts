import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AeonPassClient } from "./api.js";

/**
 * Registers all Aeon Pass tools against a client. The client carries the API
 * key, so each transport decides where that key comes from — env for stdio,
 * request header for HTTP.
 */
export function createServer(client: AeonPassClient): McpServer {
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
      designMappingId: z.string().optional().describe("Scope to guests with this invitation design"),
    },
    async (params) => ({
      content: [{ type: "text", text: JSON.stringify(await client.sendMessageToGuests(params), null, 2) }],
    })
  );

  // ── Contact Tools ──

  server.tool(
    "list_contacts",
    "List the organization's contacts with pagination and search. Scoped to the API key's organization — there is no organization parameter. Returns { data: [...], pagination }.",
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
    "Create a new contact for an organization. firstName and organizationId are required. At least one of phone or email should be provided.",
    {
      organizationId: z.string().describe("Organization GUID"),
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
    "Update an existing contact's details. firstName and organizationId are required.",
    {
      id: z.string().describe("Contact GUID"),
      organizationId: z.string().describe("Organization GUID"),
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

  server.tool(
    "list_guest_groups",
    "Get all guest groups available to the API key's organization (org-specific + system defaults). Use the returned IDs when creating or updating guests.",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(await client.listGuestGroups(), null, 2) }],
    })
  );

  // ── Messaging Tools ──
  //
  // Threaded 1:1 chat between the key's organization and one of its contacts.
  // Distinct from send_message_to_contacts / send_message_to_guests, which are
  // one-way broadcasts: these read and write a persistent conversation the
  // contact can reply into.

  server.tool(
    "list_conversations",
    "List the organization's conversations, newest activity first, each with its contact, last message and unread count. Scoped to the API key's organization — there is no organization parameter. Returns { data: [...], pagination: { totalCount, page, pageSize, totalPages } }.",
    {
      pageNo: z.number().optional().describe("Page number (1-based). Defaults to 1."),
      pageSize: z.number().optional().describe("Conversations per page. Defaults to 100."),
      searchTerm: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring matched against either side: contact name/email/phone and organization name/email/phone. A term with 3+ digits also matches phone numbers ignoring formatting."
        ),
      isUnreadOnly: z
        .boolean()
        .optional()
        .describe("Keep only conversations with a non-zero unread count. Defaults to false."),
    },
    async (params) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.listConversations(params), null, 2) },
      ],
    })
  );

  server.tool(
    "get_conversation",
    "Get one conversation by ID with its contact, last message and unread count. lastMessage is a preview of the newest message only — use list_messages to page the thread.",
    { id: z.string().describe("Conversation GUID. Must belong to the API key's organization.") },
    async ({ id }) => ({
      content: [{ type: "text", text: JSON.stringify(await client.getConversation(id), null, 2) }],
    })
  );

  server.tool(
    "create_conversation",
    "Open the conversation with a contact. Get-or-create: a conversation is identified by (organization, contact), so calling this twice for the same contact returns the existing thread rather than a duplicate. Takes a contactId — turn a guest ID into one with get_contact_by_guest.",
    {
      contactId: z
        .string()
        .describe("Contact GUID to open a conversation with. Must be a contact of the API key's organization."),
    },
    async ({ contactId }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.createConversation(contactId), null, 2) },
      ],
    })
  );

  server.tool(
    "get_conversation_with_contact",
    "Look up the conversation with a contact by contactId, so an integration holding only contact IDs never has to store conversation IDs. This is the usual entry point: guest ID -> get_contact_by_guest -> this with isCreateNew=true -> send_conversation_message.",
    {
      contactId: z.string().describe("Contact GUID. Must be a contact of the API key's organization."),
      isCreateNew: z
        .boolean()
        .describe(
          "true opens the conversation if it does not exist yet (same as create_conversation). false is get-only and returns 404 when there is no thread."
        ),
    },
    async ({ contactId, isCreateNew }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await client.getConversationWithContact(contactId, isCreateNew),
            null,
            2
          ),
        },
      ],
    })
  );

  server.tool(
    "get_contact_by_guest",
    "Resolve an event guest ID to the contact the conversation tools take. Matched on exact phone, then case-insensitive email — guest IDs and contact IDs are unrelated. Returns 404 when no contact exists for the guest, which may be permanent or replication lag, so retry briefly then give up.",
    {
      guestId: z
        .string()
        .describe("Guest GUID. Must be a guest of an event of the API key's organization."),
    },
    async ({ guestId }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.getContactByGuest(guestId), null, 2) },
      ],
    })
  );

  server.tool(
    "list_messages",
    "Page a conversation's messages, both sides, newest first. isFromOrganization tells the sides apart; the contact's SMS replies appear here like any other message. Returns { data: [...], pagination: { totalCount, page, pageSize, totalPages } }.",
    {
      conversationId: z
        .string()
        .describe("Conversation GUID. Must belong to the API key's organization."),
      eventId: z
        .string()
        .optional()
        .describe(
          "Return only messages tagged to this event, on both sides. Untagged messages (inbound SMS above all) drop out; an event that matches nothing returns an empty page."
        ),
      pageNo: z.number().optional().describe("Page number (1-based). Defaults to 1."),
      pageSize: z.number().optional().describe("Messages per page. Defaults to 100."),
      searchTerm: z
        .string()
        .optional()
        .describe("Case-insensitive substring matched against the message body."),
    },
    async ({ conversationId, ...params }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await client.listMessages(conversationId, params), null, 2),
        },
      ],
    })
  );

  server.tool(
    "send_conversation_message",
    "Send a message into one of the organization's conversations, from either side. messageBody and attachments are both optional, so either alone is a valid message. Delivery is asynchronous — success means stored and queued, not delivered. By default the message is attributed to the organization owner and appears in the web app as though they sent it; set sendFrom to 'Contact' to record the contact's own reply instead.",
    {
      conversationId: z
        .string()
        .describe("Conversation GUID to send into. Must belong to the API key's organization."),
      messageBody: z.string().optional().describe("Message text. Omit to send attachments only."),
      eventId: z
        .string()
        .optional()
        .describe(
          "Tag the message to one of this organization's events. Optional; an event owned by another organization is rejected."
        ),
      attachments: z
        .array(
          z.object({
            url: z.string().describe("Public URL from upload_conversation_docs (required)"),
            id: z.string().optional().describe("The upload's id"),
            fileName: z.string().optional().describe("Original file name"),
            fileType: z.string().optional().describe("MIME type, e.g. image/png"),
            storageFileName: z.string().optional().describe("The blob's unique storage name"),
          })
        )
        .optional()
        .describe("Files to attach — pass upload_conversation_docs entries through verbatim."),
      inApp: z
        .boolean()
        .optional()
        .describe(
          "Deliver as in-app push. Reaches only contacts with a registered account. Defaults to false."
        ),
      inSMS: z
        .boolean()
        .optional()
        .describe(
          "Deliver by SMS. The only channel that reaches a contact with no account, and the one their replies come back on. Defaults to false."
        ),
      inEmail: z.boolean().optional().describe("Deliver by email. Defaults to false."),
      sendFrom: z
        .enum(["Organization", "Contact"])
        .optional()
        .describe(
          "Which side the message is attributed to. 'Organization' (the default) stores it as sent by the organization owner and dispatches on the channels above. 'Contact' stores it as the contact's own message, exactly as an inbound SMS reply — isFromOrganization is false, the organization's unread count goes up, and the delivery channels dispatch nothing, since they describe how to reach the contact. It changes attribution only: the key still has to be allowed to write to the conversation."
        ),
      contactId: z
        .string()
        .optional()
        .describe(
          "The contact the message is from. Required when sendFrom is 'Contact', and must be this conversation's own contact — a conversation is the pair (organization, contact) and has no other participant. Ignored when sending as the organization."
        ),
    },
    async (params) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await client.sendConversationMessage(params), null, 2),
        },
      ],
    })
  );

  server.tool(
    "mark_conversation_read",
    "Mark every message in a conversation read as of now, on the organization side. Idempotent, and the mark only moves forward. Note this is the same read state the organization owner sees in the web app, so it clears their badge too.",
    { id: z.string().describe("Conversation GUID. Must belong to the API key's organization.") },
    async ({ id }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.markConversationRead(id), null, 2) },
      ],
    })
  );

  server.tool(
    "upload_conversation_docs",
    "Upload message attachments and get back their URLs, ready to pass as attachments on send_conversation_message. Not conversation-scoped — an upload binds to a thread only when a message references it. Returns one entry per successfully stored file, in order, so compare the length against what you sent. Keep files small: the bytes travel base64-encoded through this tool call.",
    {
      files: z
        .array(
          z.object({
            fileName: z.string().describe("Original file name, e.g. menu.pdf"),
            contentBase64: z.string().describe("The file's bytes, base64-encoded"),
            contentType: z
              .string()
              .optional()
              .describe("MIME type, e.g. image/png. Defaults to application/octet-stream."),
          })
        )
        .describe("Files to upload. At least one is required."),
    },
    async (params) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await client.uploadConversationDocs(params), null, 2),
        },
      ],
    })
  );

  server.tool(
    "get_chat_hub_info",
    "How to connect to the realtime chat hub (GET /api/portal/chat). That path is a SignalR WebSocket handshake, not a REST call, and a persistent socket cannot live inside this stateless server — so this returns the hub URL, how to authenticate, what the connection is subscribed to, and the server-to-client events, for the caller to connect with their own SignalR client. Pass contactId for a connection scoped to a single thread instead of the whole organization. Sending stays on send_conversation_message and mark_conversation_read. Your API key is not included in the response.",
    {
      contactId: z
        .string()
        .optional()
        .describe(
          "Narrow the connection to one contact's thread instead of the whole organization: it joins contact-{contactId} rather than org-{organizationId} and receives that conversation only. The contact scope replaces the organization group rather than adding to it, which is what makes it safe for a contact-facing client — for both views open two connections. Omit for the organization-wide subscription."
        ),
    },
    async ({ contactId }) => ({
      content: [
        { type: "text", text: JSON.stringify(await client.getChatHubInfo(contactId), null, 2) },
      ],
    })
  );

  return server;
}
