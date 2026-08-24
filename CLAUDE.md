# CLAUDE.md — aeonpass-mcp

## What this is
MCP server for the Aeon Pass platform API. Exposes Techaeon and Group CRUD operations as MCP tools so Claude Code can query and manage techaeons directly.

Deployed at **https://mcp.aeonpass.com/mcp** (Vercel, fronted by Cloudflare DNS
in DNS-only mode — the proxy would buffer this transport's SSE stream). Callers
supply their own key; the deployment holds none.

## Tech stack
- TypeScript, Node 22+
- `@modelcontextprotocol/sdk` for MCP server
- Hono for the HTTP app (Fetch-native, so it runs unchanged on Node, Vercel, Workers, or a container)

## Architecture

Tools are defined once and shared by every transport. The API key is a
parameter, not a module-level env read, so each transport decides where it
comes from.

```
src/api.ts     createClient(apiKey) → all 36 API calls bound to that key
src/env.ts     loads .env into process.env (Node entrypoints only)
src/server.ts  createServer(client) → registers the tools
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

## Logging

`createClient` wraps all 36 methods and emits one JSON line per call to
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
the fact — bulk sends, deletes, bulk reads. It logs counts and IDs, never
message bodies, recipients, or contact records.

It no longer records an `organizationId`, because there is none to record: the
portal surface now derives the organization from the key on every route,
including the contact and guest-group reads that used to take it in the path. A
key cannot name another org's data, so no log field is needed to catch it
trying. What `callMeta` does keep on a conversation send is `sendFrom` — the one
field that decides which side a stored message is attributed to — and the
`contactId` that is the sender on a `Contact` send.

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

**Messaging (Chat)** — threaded 1:1 conversations, `/api/portal/conversations/*`.
Distinct from the broadcast `send_message_to_*` tools: a conversation persists
and the contact can reply into it.

| Tool | Description |
|------|-------------|
| `list_conversations` | List the organization's conversations (paginated) |
| `get_conversation` | Get one conversation by ID |
| `create_conversation` | Open a conversation with a contact (get-or-create) |
| `get_conversation_with_contact` | Same, addressed by contactId |
| `get_contact_by_guest` | Resolve an event guest ID to a contactId |
| `list_messages` | Page a conversation's messages, both sides (paginated) |
| `send_conversation_message` | Send into a conversation, from either side, via InApp/SMS/Email |
| `mark_conversation_read` | Mark a conversation read on the organization side |
| `upload_conversation_docs` | Upload attachments, returns URLs for the next send |
| `get_chat_hub_info` | Connection details for the realtime SignalR hub |

### Sending from either side

`send_conversation_message` takes `sendFrom`: `Organization` (the default, and
what every caller did before the field existed) or `Contact`. `Contact` records
the message as the contact's own, exactly as an inbound SMS reply is stored —
`isFromOrganization: false`, `senderId` is the contactId, the organization's
unread count goes up, and the delivery channels dispatch *nothing*, since they
describe how to reach the contact. It requires `contactId`, and that contact
must be this conversation's own.

So one key can mirror both halves of a thread, which is what lets an integration
own a contact-facing surface for someone with no Aeon Pass account. It changes
*attribution*, never *authorization*: the key still has to be allowed to write
to the conversation, and naming a contact is not a way to reach a thread the key
could not already reach. Sent by name, not by ordinal.

### The realtime hub

`get_chat_hub_info` is the only tool that makes no HTTP call. `GET /api/portal/chat`
is a SignalR handshake and a persistent socket cannot live in a stateless
per-request server, so the tool returns the hub URL (derived from
`AEONPASS_BASE_URL`), the auth options, what the connection is subscribed to and
the two server→client events, and the caller connects their own client. The key
is deliberately never interpolated into that URL — a tool result lands in the
model's context and every transcript of it.

One key, two subscription shapes, and a connection is one or the other. Omit
`contactId` and it joins `org-{organizationId}` and sees every conversation of
the organization; pass one and it joins `contact-{contactId}` and sees that
single thread. The contact scope *replaces* the organization group rather than
adding to it — that is the point of it, so a contact-facing client cannot
receive the organization's other conversations. Both views at once means two
connections. A `contactId` that is not the key's own fails the negotiate with
401 rather than falling back, since silently widening the scope is the leak the
parameter exists to prevent.

The returned URL is `https://`, not `wss://`, even though the connection ends
up a WebSocket: a SignalR client is handed the HTTP address and negotiates the
upgrade itself, and `@microsoft/signalr` rejects a `wss://` URL outright with
"Cannot resolve". Returning the scheme the socket ends up on would hand the
caller something `withUrl()` cannot take.

`upload_conversation_docs` takes base64 bytes, because MCP is a text protocol.
That inflates content by a third and every byte crosses the model's context, so
it is for small attachments only.

## Environment

| Variable | Required | Purpose |
|----------|----------|---------|
| `AEONPASS_API_KEY` | stdio only | The key. Over HTTP it's the caller's `X-API-KEY`; the env var is only a local fallback, never set on a hosted deployment. |
| `AEONPASS_BASE_URL` | no | Gateway origin. Defaults to the prod gateway. Set it to aim at staging or a local gateway. |

The Node entrypoints (`index.ts`, `node.ts`) load `.env` through `src/env.ts`,
a side-effect import that must stay *first* in those files so it runs before
anything reads `process.env`. It looks for `.env` at the package root — `../.env`
from `src/` or `dist/`, so the stdio server finds it regardless of the cwd the
MCP client launched it from — then falls back to the cwd. Real environment
variables win over the file, matching Node's own `--env-file` precedence.

`env.ts` is deliberately not imported by `app.ts` or `api/index.ts`: Vercel and
Workers inject config themselves and have no filesystem to read a dotfile from.
`api.ts` reads `AEONPASS_BASE_URL` through `globalThis.process?.env`, guarded
because that module also runs where `process` doesn't exist. Only the origin of
the value is used — every request path is absolute, so a path component would be
discarded — and a malformed or non-http value throws with a named error rather
than surfacing later as a confusing fetch failure.

## Staying in sync with the API

The specs pin `info.version` at `1.0.0` and don't move it — not for the path
restructure, not for the list-response reshape, not for `PATCH /guest/{id}`.
Version is useless for change detection, so `specs/*.json` holds a committed
snapshot and `npm run check:api` diffs the live specs against it, also flagging
operations with no client method and client methods with no operation. A weekly
GitHub Action runs it.

Adding an endpoint: implement in `createClient` (`api.ts`) → register the tool
(`server.ts`) → add the operation to `COVERED` in `scripts/check-api.mjs`.
`GET /contact/export` sits in `SKIPPED` on purpose — a full-contact CSV
is a large PII dump into an LLM context.

The organization module dropped `organizationId` from its portal routes: the
contact and guest-group list reads moved from `/contact/{orgId}/list` and
`/guest-group/{orgId}/list` to `/contact/list` and `/guest-group/list`, and the
contact send-message and upload-list bodies no longer carry the field either.
The whole portal surface now resolves the organization from the key, the way
`/api/portal/conversations/*` always has.

`specs/message.json` is **held** (`holdUntil` in `SPECS`). The published chat
spec is still the pre-portal, JWT-only surface with no
`/api/portal/conversations/*` in it, so the snapshot is the dev spec that has
them (`doc/dev-messageAPI.json`); coverage is checked against the snapshot and
`--write` will not overwrite it. The check reports this every run and says when
the published spec catches up, at which point drop `holdUntil`. That spec's JWT
surface — `/api/conversations/*`, `/api/chat`, the Twilio webhook — is skipped
wholesale via `SKIPPED_SURFACES`: it authenticates an end user's session and
this server only ever holds an API key.

## Commands
```
npm run build       # compile TypeScript
npm run dev         # run with tsx (dev)
npm run start       # run compiled JS
npm run check:api   # detect Aeon Pass API drift
```
