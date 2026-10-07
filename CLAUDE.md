# CLAUDE.md — aeonpass-mcp

## What this is
MCP server for the Aeon Pass platform API. Exposes techaeons, events and guests, contacts, chat, and custom field definitions as MCP tools so Claude Code can query and manage them directly.

Deployed at **https://mcp.aeonpass.com/mcp** (Vercel, fronted by Cloudflare DNS
in DNS-only mode — the proxy would buffer this transport's SSE stream). Callers
supply their own key; the deployment holds none.

## Tech stack
- TypeScript, Node 22+
- `@modelcontextprotocol/sdk` for MCP server
- `@microsoft/signalr` for the realtime chat hub (imported on demand)
- Hono for the HTTP app (Fetch-native, so it runs unchanged on Node, Vercel, Workers, or a container)

## Architecture

Tools are defined once and shared by every transport. The API key is a
parameter, not a module-level env read, so each transport decides where it
comes from.

```
src/api.ts     createClient(apiKey) → all 44 API calls bound to that key
src/realtime.ts SignalR chat subscriptions, keyed by sha256(apiKey) + scope
src/server.ts  createServer(client, opts) → registers the tools
src/app.ts     Hono app; reads X-API-KEY per request
src/index.ts   stdio      → key from AEONPASS_API_KEY        (Claude Code / desktop)
src/node.ts    Node HTTP  → header, falls back to env locally (npm run serve)
api/index.ts   Vercel     → header only, no fallback
```

**Key handling.** `createApp({ fallbackApiKey })` is the only way to get an
env-var key over HTTP, and it exists for local single-user runs. Hosted
deployments must not set `AEONPASS_API_KEY` — callers supply their own key as
`X-API-KEY`, so the server holds no credential and each call is attributable to
one person's key. Never add request logging that captures headers.

**Realtime is host-dependent.** The chat hub subscription outlives the tool call
that opened it, which only works where a process stays alive. `createServer`
registers the four `chat_realtime_*` tools only when passed `realtimeApiKey`:
stdio and `npm run serve` pass it, Vercel does not. On serverless the instance
can be frozen or discarded between requests, so a subscription opened by one
call is gone by the next — better to not advertise the tools than to have them
report a dead connection.

## Logging

`createClient` wraps all 44 methods and emits one JSON line per call to
**stderr** — stdout belongs to the stdio transport's JSON-RPC frames, so writing
there corrupts the protocol.

```json
{"src":"aeonpass-mcp","ts":"…","caller":"c4bc6c74","method":"listTechaeons","ok":true,"ms":953}
```

`caller` is the first 8 hex of SHA-256 of the key — a stable pseudonym, never
the key. Different keys produce different values, which is what makes calls
attributable. Web Crypto, not `node:crypto`, so it still runs on Workers/Deno.

**What is deliberately not logged:** the key, arguments in general, response
bodies, and API error text (which can echo request content back). Only the
status code is kept on failure.

`callMeta` in `api.ts` records argument *shape* for calls where it matters after
the fact — bulk sends, deletes, chat sends, and custom field status and shape
changes. It logs counts, IDs and field names, never
message bodies, attachments, recipients, or contact records.

Every contact and guest-group endpoint resolves `organizationId` server-side
from the API key — it is never a request parameter, so a key can only ever
reach its own org's data. `create_contact`, `update_contact`, `list_contacts`,
`send_message_to_contacts`, `upload_contacts`, and `list_guest_groups` take no
`organizationId` argument. The chat and custom field tools are scoped the same
way.


`realtime.ts` logs the same way, but connection lifecycle only —
`realtimeConnect`, `realtimeReconnected`, `realtimeDisconnect`. Individual hub
events are deliberately never logged: they arrive in bulk and carry message
bodies. The counters in `chat_realtime_status` are what show a subscription is
live. Buffered events sit in memory only, are handed back solely to the key that
opened the subscription, and never reach the log.

Pass `createClient(key, { onCall })` to redirect or disable (`onCall: () => {}`).
Note Vercel runtime logs are short-retention — a log drain is required for
anything meant to serve as an audit trail.

## API
All tools call the Aeon Pass gateway at `https://apv2-gatewayapp-prod-westus3.azurewebsites.net/api/portal/techaeon/...` using the `X-API-KEY` header. List endpoints return `{ data: [...], pagination: { totalCount, page, pageSize, totalPages } }`.

### Tools

**Techaeons**
| Tool | Description |
|------|-------------|
| `get_techaeon` | Get a single techaeon by ID |
| `list_techaeons` | List/search/filter techaeons (paginated) |
| `create_techaeon` | Create a techaeon and assign to a holder |
| `update_techaeon_status` | Change status (CREATED/ISSUED/TRANSFERRED/CANCELLED/CONSUMED) |
| `update_techaeon_redirect` | Set or clear redirect URL |
| `delete_techaeon` | Soft-delete a techaeon |
| `list_groups` | List/search techaeon groups |
| `create_group` | Create group + bulk-generate techaeons |
| `update_group` | Update group config |

**Events & Guests**
| Tool | Description |
|------|-------------|
| `get_event` | Get event details by ID |
| `list_guests` | List/search guests for an event (paginated) |
| `get_guest` | Get one guest, including custom field values |
| `create_guest` | Add a guest to an event, optionally issue invitation |
| `update_guest` | Full update of guest details or invitation |
| `patch_guest` | Partial update — only the fields you pass are changed |
| `delete_guest` | Soft-delete a guest or remove a single invitation |
| `send_invite` | Send/resend invitations to guests (sets status to SENT) |
| `send_message_to_guests` | Message guests via InApp/SMS/Email |
| `list_guest_groups` | List valid guest group IDs for an organization |

**Custom fields**
| Tool | Description |
|------|-------------|
| `list_custom_fields` | List definitions for a record type (optional status filter) |
| `get_custom_field` | Get one definition with its options |
| `get_custom_field_schema` | Legal dataType / widgetType / rule-key matrix |
| `create_custom_field` | Define a field (starts `DRAFT`) |
| `update_custom_field` | Full replace of a field's shape |
| `patch_custom_field` | Partial update — only the fields you pass |
| `update_custom_field_status` | `DRAFT` / `ACTIVE` / `DEPRECATED` / `ARCHIVED` |
| `reorder_custom_fields` | Bulk-set `orderIndex` for one record type |
| `delete_custom_field` | Soft-delete — `DRAFT` fields only |

Custom fields come from the **Global** API (`specs/global.json`), live on every
environment. Definitions live there; *values* are written on the record itself —
today only guests, as `customFields` on `create_guest` / `update_guest` /
`patch_guest`, read back by `get_guest` (`list_guests` does not carry them).
Three things that are easy to get wrong:

- `customFields` is keyed by the definition's **`id`**, not its `fieldKey`.
- It is **merged by key on both PUT and PATCH**, even though PUT replaces the rest
  of the guest. Omitting it leaves every value alone; on PATCH an explicit
  `null` value clears that one field. On create, every `ACTIVE` mandatory field
  must be present.
- `DRAFT` is the status that matters. While a field holds it any shape change
  goes; once it leaves, changing `dataType`/`cardinality`, turning
  `isMandatory` on, or dropping an option is `CUSTOM_FIELD_BREAKING_CHANGE`, and
  delete is refused outright. Retire a live field by status instead.

`validationRules` and `uiHints` are objects on the way in but come back as JSON
**strings** on `CustomFieldDefinitionDto`. `patch_custom_field` sends plain
values like `patch_guest` does — the spec's `PatchFieldOf…` / `{ isSet, value }`
types are the C# wrapper leaking into the schema.

**Contacts**
| Tool | Description |
|------|-------------|
| `list_contacts` | List/search organization contacts (paginated) |
| `get_contact` | Get a single contact by ID |
| `create_contact` | Create a new contact |
| `update_contact` | Update contact details |
| `delete_contact` | Soft-delete a contact |
| `send_message_to_contacts` | Message contacts via InApp/SMS/Email |
| `upload_contacts` | Bulk upsert contacts from a list — all-or-nothing |

`upload_contacts` became **atomic** in Oct 2026 (dev and stage; not prod yet): if any row fails
validation, no contacts are saved, and the failures come back in `errorItems`
with per-field `errors`. Rows also gained `displayName`, `address`, `city`, `zip`
and `socialHandle`; on a match, blank optional fields keep the current value.

**Chat (Message API)**
| Tool | Description |
|------|-------------|
| `list_conversations` | List the org's conversations (paginated, unread + contact filters) |
| `get_conversation` | Get one conversation by ID |
| `get_conversation_with_contact` | Get-or-create the thread with a contact |
| `create_conversation` | Start a conversation with a contact |
| `list_messages` | List a conversation's messages (paginated, event filter) |
| `send_chat_message` | Send into a conversation — `sendFrom` required, org or contact |
| `mark_conversation_read` | Mark read — always as the *organization* |
| `get_contact_by_guest` | Resolve an event guest ID to its contact |
| `upload_message_attachments` | Upload files for use as chat attachments |

`send_chat_message` **requires** `sendFrom`. It used to default to
`Organization`; the API-key surface now rejects a request without it at request
binding, before any of the endpoint's own validation. The reason is that a key
may record *either* side — it is org-side by construction, so `Contact` selects
attribution, not authorization — which leaves no side to infer. (The token
surface keeps it nullable, where null still means "infer from the caller", but
this server only speaks portal.) So `sendFrom` is a required parameter on the
tool and `createClient` does not default it, and `callMeta` logs the value the
caller actually sent rather than a phantom `Organization`.

Two more things about `send_chat_message`, both settled on stage in Sept 2026.
`eventId` is now **validated before anything is stored** — an unknown id, a
deleted one, or another organization's event all fail with `EVENT_NOT_LINKED`,
where previously any GUID was accepted and kept as a tag that never resolved to
an `eventName`. `ORGANIZATION_ID_MISMATCH` no longer covers `eventId` as a
result; it is about `contactId` only. Separately, a send with **every channel
flag off** is deliberately not an error: the message is stored and pushed to
live subscribers but dispatched to nobody, and the `200` is identical to a
delivered send apart from the `inApp`/`inSMS`/`inEmail` echoed on `lastMessage`.
That is documented rather than guarded, so the tool description carries the
warning — set a channel on anything meant to reach the person.

### API keys have their own identity

Dev only as of Oct 2026 (see the rollout table below). A key used to act as its organization's **owner
account**; it is now a principal of its own, which changes two things:

- **Attribution.** A `sendFrom: "Organization"` send is recorded as sent *by the
  key*: `senderType: "ApiKey"`, `senderId` = the key's id, `senderApiKeyId`, and
  the key's name in `senderApiKeyName` (copied to `sender.firstName` so older
  clients render it — `"Legacy API key"` for a pre-management key, `"API key"`
  when unresolvable). A person on either side is `senderType: "User"`. Messages
  sent through the API *before* this are still attributed to the owner as
  `User` — history is not rewritten, so `senderType` cannot tell old API sends
  from the owner's own.
- **Read state is per key.** `mark_conversation_read`, and the implicit mark on
  an org-side send, move only *this key's* read mark. They no longer clear the
  owner's badge in the web app, and a person reading there no longer moves the
  key's `unreadCount`. Two keys of one org see two different unread counts. The
  contact's "seen" receipt is still sent.

`isFromOrganization` remains the way to tell the sides apart; `senderType` only
says *who* on the organization side sent it.

The three conversation *reads* — `list_conversations`, `get_conversation`,
`list_messages` — take a `view` query parameter (`ConversationSide`: `Auto` |
`Organization` | `Contact`). **It sets `callerRole` and nothing else.**
`Organization` and `Auto` report `ORG_MEMBER`, `Contact` reports `CONTACT`, and
the rows are identical either way: a key reads the thread as the organization on
every value, so `unreadCount`, `isReadByUser` and `isRead` are always the
organization's. It is not an access switch, and it cannot reach anything the key
could not already reach.

Per endpoint:

| Read | `view` |
|---|---|
| `get_conversation` | `Contact` reports the thread's own contact's seat. Needs no id — a conversation has exactly one contact. |
| `list_conversations` | `Contact` **requires `contactId`** and returns that one conversation; without it, `400 CONTACT_ID_REQUIRED`. |
| `list_messages` | A no-op, accepted only so the same value can be passed as to `get_conversation`. A message has no `callerRole`. |

`contactId` on `list_conversations` is also a filter in its own right, with no
`view`: keep only the conversation with that contact. A contact of another
organization matches nothing and returns an empty page rather than an error —
consistent with every other org-scoped read here. `get_conversation_with_contact`
remains the better route to a known contact's thread; it returns the conversation
directly and can create it, where this only filters.

`createClient` sends `view` only when a caller passes one. `Auto` is the API's
default *and* its zero value, meaning "infer the side as before", so a bare call
stays byte-identical to the pre-`view` request.

`view` also accepts the short spelling `org`, and its query-string converter
never fails, so a bad value silently becomes `Auto`. We send the canonical name.

### Attachments, and which read reports them

`MessageDto.attachments` is **`null`, not `[]`**, on a message with no files —
it became nullable on stage in Sept 2026. Test its length, never its presence.

Worse, `null` does not mean the same thing on every endpoint, because the
single-conversation reads drop the field rather than filling it. Verified on
stage against one message whose send response returned an attachment:

| Read | `lastMessage.attachments` / `attachments` |
|---|---|
| `list_messages` | the real attachments — **the authoritative read** |
| `list_conversations` | populated, so `null` here really is "no files" |
| `get_conversation` | **always `null`**, files or not |
| `get_conversation_with_contact` | **always `null`** — same projection |
| `send_chat_message` (response) | populated: the attachments just stored |

So a `null` from `get_conversation` is "this projection does not carry them",
and reading it as "no attachment" is the trap. The spec documents this only on
`get_conversation`; that `list_conversations` differs from the other two reads
is ours, found by testing. The tool descriptions carry the distinction, since
that is where a model reads it.

On send, each attachment is **assigned a fresh id** at store time — the upload's
id is not reused, while `url` and `storageFileName` carry through unchanged. So
do not use an upload id to correlate a sent attachment; match on `url`.

`messageBody` and `attachments` are each optional on their own: an
attachment-only send is valid and stores `messageBody: null`.

**Chat realtime (SignalR)** — stdio and `npm run serve` only, see above
| Tool | Description |
|------|-------------|
| `chat_realtime_connect` | Open a hub subscription and start buffering events |
| `chat_realtime_poll` | Drain buffered events since the last poll |
| `chat_realtime_status` | Connection state and buffered/dropped/reconnect counts |
| `chat_realtime_disconnect` | Close a subscription |

## Realtime chat (SignalR)

Hub at `wss://{gateway}/api/portal/chat`. The gateway prefixes every route with
`/api`; the service maps it at `/portal/chat`. Using the unprefixed path fails
as a **404 at negotiate, not a 401** — worth knowing when debugging what looks
like an auth problem.

We authenticate with the `X-API-KEY` **handshake header**, not the `?apikey=`
query form. Both are accepted and this is the one route in the API that takes a
key in a URL, but on the query form the negotiate redirect carries the key
onward into the Azure SignalR Service URL. Node can set handshake headers, so
there is no reason to take that.

One connection is **one scope, never both** — `contactId` on the handshake
picks:

| Handshake | Group | Receives |
|---|---|---|
| no `contactId` | `org-{organizationId}` | every conversation of the org |
| `?contactId=…` | `contact-{contactId}` | that one thread |

The contact scope *replaces* the org group rather than adding to it, so watching
both means two connections — which is why the registry is keyed by
`sha256(apiKey) + scope`. It's hashed so no raw credential sits in a module-level
map, and a caller can only ever reach a subscription their own key opened.

`contactId` is validated during authentication, before a socket exists: an
unknown or other-org contact is a **401 at negotiate**. It deliberately does not
fall back to the org group — that would hand a contact-facing client every
conversation in the organization, the exact leak the parameter prevents.

The hub is **receive-only** and exposes no client-callable methods. Sending is
`send_chat_message`; marking read is `mark_conversation_read`, which always
records the *organization* as the reader whichever way the connection is scoped.

Two events arrive. `ReceiveMessage` carries the whole conversation with the new
message as `lastMessage` — branch on `lastMessage.isFromOrganization` for the
side, and note it is sender-neutral, so **your own sends echo back**; reconcile
on `lastMessage.id`. `MarkMessagesRead` is a read receipt — branch on
`readByContact` for the direction rather than assuming one.

Never tell the sides apart by matching `senderId` against a contactId.
`isFromOrganization` is recorded on the message itself, while `senderId` holds
the contact's id on an SMS reply and on a `sendFrom: "Contact"` send but their
*user* id when they sent from their own app — so the comparison is wrong for the
third case, and wrong again when the contact is linked to the same user account
the key acts as.

SignalR replays nothing across a reconnect, so `status.reconnects > 0` or
`status.dropped > 0` both mean events were missed. `list_messages` is the
reconciliation path; the buffer alone is not a source of truth.

## Environment
Requires `AEONPASS_API_KEY` env var.

## Staying in sync with the API

The specs pin `info.version` at `1.0.0` and don't move it — not for the path
restructure, not for the list-response reshape, not for `PATCH /guest/{id}`.
Version is useless for change detection, so `specs/*.json` holds a committed
snapshot of all five specs (techaeon, event, organization, message, global) and
`npm run check:api` diffs the live specs against it, also flagging operations
with no client method and client methods with no operation. A weekly
GitHub Action runs it.

The `message` spec's `GET /api/portal/chat` is the SignalR hub, documented as a
GET only so it appears in the reference. It maps to `realtime.ts` in `COVERED`,
not to a `createClient` method.

**Two spec sources, and they lag each other.** `check:api` reads the published
specs from `aeonpass-dev-portal.vercel.app/api/specs/{name}`; each gateway
environment also serves the spec its own build generated, e.g.
`…-stage-….azurewebsites.net/swagger/docs/v1/messageAPI` (the swagger UI's
config block lists all six: `techaeonAPI`, `eventAPI`, `organizationAPI`,
`messageAPI`, `globalAPI`, and `VenueAPI`, which has no `/api/portal` routes and
so no snapshot). The gateway spec is what the deployed code
actually does, and it moves first — the `sendFrom` requirement above was live on
stage while the published spec still described the old optional field. So the
drift check passing does not mean there is nothing to pick up; check the
environment's own swagger when chasing a specific change.

> **`specs/message.json` and `specs/organization.json` are gateway snapshots,
> not published ones.** Both were regenerated from the **dev** swagger in Oct
> 2026 — filtered to `/api/portal` and the schemas those paths reach, which is
> the same shape the publisher serves, with `servers[0].url` rewritten to prod
> and `example` blocks stripped the way `check:api` stores every other snapshot.
>
> The publisher has caught up on everything from Sept (`sendFrom` required,
> `view`, `contactId`, `EVENT_NOT_LINKED`, nullable `attachments`). What it
> still lags, as of Oct 2026:
>
> - **message** — `MessageDto.senderType` / `senderApiKeyId` /
>   `senderApiKeyName`, and the per-key read state in the `mark-read` and
>   `send-message` descriptions.
> - **organization** — the five new `upload-list` row fields and its
>   all-or-nothing behavior.
>
> Those are why `check:api` reports `~ message:` and `~ organization: same
> operations, but the spec body changed`. **Do not clear those lines with
> `check:api -- --write`** — `--write` rewrites *every* snapshot from the
> published source, so it would revert both to the older contract. To refresh
> techaeon, event or global, run `--write` and then `git checkout` the two
> gateway snapshots back. Once the publisher catches up, `--write` is safe again
> and the lines go away on their own.
>
> `src/api.ts` `BASE_URL` points at the **dev** gateway on this branch. Rollout
> as of 7 Oct 2026, from each gateway's own swagger:
>
> | Change | dev | stage | prod |
> |---|---|---|---|
> | Custom fields API, `GET /guest/{id}`, guest `customFields` | ✓ | ✓ | ✓ |
> | `upload-list` new row fields + all-or-nothing | ✓ | ✓ | — |
> | API-key identity (`senderType`, per-key read state) | ✓ | — | — |
>
> Pointed at prod, the new upload fields would be ignored and the chat tool
> descriptions would overstate what prod does. Re-check before switching.

Adding an endpoint: implement in `createClient` (`api.ts`) → register the tool
(`server.ts`) → add the operation to `COVERED` in `scripts/check-api.mjs`.
`GET /contact/export` sits in `SKIPPED` on purpose — a full-contact CSV is a
large PII dump into an LLM context.

## Commands
```
npm run build       # compile TypeScript
npm run dev         # run with tsx (dev)
npm run start       # run compiled JS
npm run check:api   # detect Aeon Pass API drift
```
