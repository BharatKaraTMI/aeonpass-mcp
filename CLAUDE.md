# CLAUDE.md — aeonpass-mcp

## What this is
MCP server for the Aeon Pass platform API. Exposes Techaeon and Group CRUD operations as MCP tools so Claude Code can query and manage techaeons directly.

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
src/api.ts     createClient(apiKey) → all 34 API calls bound to that key
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

`createClient` wraps all 34 methods and emits one JSON line per call to
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
the fact — bulk sends, deletes, and chat sends. It logs counts and IDs, never
message bodies, attachments, recipients, or contact records.

Every contact and guest-group endpoint resolves `organizationId` server-side
from the API key — it is never a request parameter, so a key can only ever
reach its own org's data. `create_contact`, `update_contact`, `list_contacts`,
`send_message_to_contacts`, `upload_contacts`, and `list_guest_groups` take no
`organizationId` argument. The chat tools are scoped the same way.


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
| `create_guest` | Add a guest to an event, optionally issue invitation |
| `update_guest` | Full update of guest details or invitation |
| `patch_guest` | Partial update — only the fields you pass are changed |
| `delete_guest` | Soft-delete a guest or remove a single invitation |
| `send_invite` | Send/resend invitations to guests (sets status to SENT) |
| `send_message_to_guests` | Message guests via InApp/SMS/Email |
| `list_guest_groups` | List valid guest group IDs for an organization |

**Contacts**
| Tool | Description |
|------|-------------|
| `list_contacts` | List/search organization contacts (paginated) |
| `get_contact` | Get a single contact by ID |
| `create_contact` | Create a new contact |
| `update_contact` | Update contact details |
| `delete_contact` | Soft-delete a contact |
| `send_message_to_contacts` | Message contacts via InApp/SMS/Email |
| `upload_contacts` | Bulk upsert contacts from a list |

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
snapshot of all four specs (techaeon, event, organization, message) and
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
config block lists all six). The gateway spec is what the deployed code
actually does, and it moves first — the `sendFrom` requirement above was live on
stage while the published spec still described the old optional field. So the
drift check passing does not mean there is nothing to pick up; check the
environment's own swagger when chasing a specific change.

> **`specs/message.json` is currently a gateway snapshot, not a published one.**
> It was regenerated from the stage swagger — filtered to `/api/portal` and the
> schemas those paths reach, which is the same shape the publisher serves — so
> that the committed contract matches the code, which implements `sendFrom`
> required, `view`, `contactId` and `EVENT_NOT_LINKED`. The published spec has
> none of those yet, so `check:api` reports
> `~ message: same operations, but the spec body changed` until it catches up. **Do not clear that line with `check:api -- --write`** —
> it fetches the published source and would revert the snapshot to the old
> contract. Once the publisher catches up, `--write` is safe again and the line
> goes away on its own. The other three snapshots do come from the published
> source; refresh those with `--write` as usual.

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
