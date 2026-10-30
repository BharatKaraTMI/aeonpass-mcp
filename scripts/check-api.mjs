#!/usr/bin/env node
// Detects drift between the published Aeon Pass OpenAPI specs and this server.
//
// Why this exists: `info.version` is "1.0.0" on every spec and has stayed
// there across a full path restructure (/api/techaeon/public → /api/portal/
// techaeon), a change to every list response shape, and the addition of PATCH
// /guest/{id}. The version field cannot be used to detect change, so we diff
// the surface ourselves.
//
//   npm run check:api          report drift and coverage gaps
//   npm run check:api -- --write   also refresh specs/*.json
//
// Exits non-zero when the live specs differ from the committed snapshots or an
// operation has no client method, so CI can fail on it.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_DIR = join(ROOT, "specs");
const BASE = "https://aeonpass-dev-portal.vercel.app/api/specs";
const SPECS = ["techaeon", "event", "organization", "message", "global"];

/** operation -> the createClient method that implements it. */
const COVERED = {
  "POST /api/portal/techaeon": "createTechaeon",
  "GET /api/portal/techaeon/{id}": "getTechaeon",
  "DELETE /api/portal/techaeon/{id}": "deleteTechaeon",
  "PUT /api/portal/techaeon/{id}/redirectUrl": "updateTechaeonRedirect",
  "PUT /api/portal/techaeon/{id}/status": "updateTechaeonStatus",
  "POST /api/portal/techaeon/group": "createGroup",
  "PUT /api/portal/techaeon/group/{id}": "updateGroup",
  "GET /api/portal/techaeon/group/list": "listGroups",
  "GET /api/portal/techaeon/list": "listTechaeons",

  "GET /api/portal/event/{id}": "getEvent",
  "POST /api/portal/event": "createEvent",
  "PUT /api/portal/event/{id}": "updateEvent",
  "PATCH /api/portal/event/{id}": "patchEvent",
  "POST /api/portal/event/{id}/details": "updateEventDetails",
  "POST /api/portal/event/{id}/invitee": "updateEventInvitee",
  "POST /api/portal/event/{id}/publish": "publishEvent",
  "POST /api/portal/guest": "createGuest",
  "GET /api/portal/guest/{id}": "getGuest",
  "GET /api/portal/guest/{eventId}/list": "listGuests",
  "PUT /api/portal/guest/{id}": "updateGuest",
  "PATCH /api/portal/guest/{id}": "patchGuest",
  "DELETE /api/portal/guest/{id}": "deleteGuest",
  "POST /api/portal/guest/send-invite": "sendInvite",
  "POST /api/portal/guest/send-message": "sendMessageToGuests",
  "POST /api/portal/guest/{guestId}/invitation": "createInvitation",
  "PUT /api/portal/guest/{guestId}/invitation": "updateInvitation",
  "GET /api/portal/invitation/status/list": "listInvitationStatuses",
  "POST /api/portal/design-mapping": "createDesignMapping",
  "GET /api/portal/design-mapping/{id}": "getDesignMapping",
  "GET /api/portal/design-mapping/{eventId}/list": "listDesignMappings",
  "PUT /api/portal/design-mapping/{id}": "updateDesignMapping",
  "DELETE /api/portal/design-mapping/{id}": "deleteDesignMapping",

  "POST /api/portal/contact": "createContact",
  "GET /api/portal/contact/{id}": "getContact",
  "PUT /api/portal/contact/{id}": "updateContact",
  "DELETE /api/portal/contact/{id}": "deleteContact",
  "GET /api/portal/contact/list": "listContacts",
  "POST /api/portal/contact/send-message": "sendMessageToContacts",
  "POST /api/portal/contact/upload-list": "uploadContacts",
  "PUT /api/portal/contact/{Id}/custom-fields": "setContactCustomFields",
  "GET /api/portal/guest-group/list": "listGuestGroups",
  "GET /api/portal/techaeon-design/list": "listTechaeonDesigns",
  "GET /api/portal/techaeon-design/{id}": "getTechaeonDesign",
  "POST /api/portal/techaeon-design": "createTechaeonDesign",
  "PUT /api/portal/techaeon-design/{id}": "updateTechaeonDesign",
  "DELETE /api/portal/techaeon-design/{id}": "deleteTechaeonDesign",
  "POST /api/portal/techaeon-design/upload-images": "uploadDesignImages",
  "GET /api/portal/techaeon-design/colors": "listDesignColors",
  "GET /api/portal/techaeon-design/color/{id}": "getDesignColor",
  "GET /api/portal/techaeon-design/shapes": "listDesignShapes",
  "GET /api/portal/techaeon-design/shape/{id}": "getDesignShape",

  "POST /api/portal/conversations": "createConversation",
  "GET /api/portal/conversations/{id}": "getConversation",
  "GET /api/portal/conversations/with-contact/{contactId}": "getConversationWithContact",
  "GET /api/portal/conversations/list": "listConversations",
  "GET /api/portal/conversations/{conversationId}/messages": "listMessages",
  "POST /api/portal/conversations/send-message": "sendChatMessage",
  "PUT /api/portal/conversations/{id}/mark-read": "markConversationRead",
  "GET /api/portal/conversations/contact/{guestId}": "getContactByGuest",
  "POST /api/portal/conversations/upload-docs": "uploadMessageDocs",
  // Not a REST call: the spec documents the SignalR hub as a GET so it shows up
  // in the reference. Implemented in realtime.ts, not createClient.
  "GET /api/portal/chat": "connectRealtime (src/realtime.ts)",

  "GET /api/portal/custom-fields": "listCustomFields",
  "POST /api/portal/custom-fields": "createCustomField",
  "GET /api/portal/custom-fields/schema": "getCustomFieldSchema",
  // Route params are {Id}/{EntityType} on the gateways since 26 Oct 2026.
  "GET /api/portal/custom-fields/{Id}": "getCustomField",
  "PUT /api/portal/custom-fields/{Id}": "updateCustomField",
  "PATCH /api/portal/custom-fields/{Id}": "patchCustomField",
  "DELETE /api/portal/custom-fields/{Id}": "deleteCustomField",
  "PUT /api/portal/custom-fields/{Id}/status": "changeCustomFieldStatus",
  "PUT /api/portal/custom-fields/{EntityType}/reorder": "reorderCustomFields",

  "GET /api/portal/event/types": "listEventTypes",
  "GET /api/portal/event/list": "listEvents",
  "GET /api/portal/event/list/contact/{contactId}": "listEventsByContact",
  "GET /api/portal/event/list/contact/{contactId}/guests": "listGuestRecordsByContact",
  "GET /api/portal/event/list/guest/{guestId}": "listEventsByGuest",
  "GET /api/portal/invitation/list/contact/{contactId}": "listInvitationsByContact",
  "GET /api/portal/invitation/list/guest/{guestId}": "listInvitationsByGuest",
};

/** Endpoints we've decided not to expose, and why. */
const SKIPPED = {
  "GET /api/portal/contact/export":
    "bulk CSV of every contact — a large PII dump into an LLM context; list_contacts covers paged reads",
};

const operations = (spec) =>
  Object.entries(spec.paths ?? {})
    .flatMap(([path, methods]) =>
      Object.keys(methods)
        .filter((m) => ["get", "put", "post", "delete", "patch"].includes(m))
        .map((m) => `${m.toUpperCase()} ${path}`)
    )
    .sort();

/**
 * Pretty JSON with `example` values stripped. NSwag regenerates request-body
 * `example` blocks with fresh random GUIDs on every render, so a raw body
 * comparison would report a phantom change on every run. Stripping them — for
 * both the comparison and the stored snapshot — leaves a view that only moves
 * on a real contract change (a type, an operation, a required flag). Snapshots
 * are therefore example-free; `--write` refreshes them in that form.
 */
const stableView = (spec) =>
  JSON.stringify(spec, (key, value) => (key === "example" ? undefined : value), 2) + "\n";

const write = process.argv.includes("--write");
let problems = 0;

mkdirSync(SPEC_DIR, { recursive: true });

for (const name of SPECS) {
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) {
    console.error(`✗ ${name}: fetch failed (${res.status})`);
    problems++;
    continue;
  }
  const live = await res.json();
  const liveOps = operations(live);
  // Must match how the snapshot is written below, or the body comparison
  // reports a change on every run.
  const serialised = stableView(live);

  const snapPath = join(SPEC_DIR, `${name}.json`);
  if (existsSync(snapPath)) {
    const prevOps = operations(JSON.parse(readFileSync(snapPath, "utf8")));
    const added = liveOps.filter((o) => !prevOps.includes(o));
    const removed = prevOps.filter((o) => !liveOps.includes(o));

    for (const o of added) {
      console.log(`+ ${name}: NEW  ${o}`);
      problems++;
    }
    for (const o of removed) {
      console.log(`- ${name}: GONE ${o}`);
      problems++;
    }
    // Schema-level edits (response shapes, new fields) don't show up above.
    if (!added.length && !removed.length && serialised !== readFileSync(snapPath, "utf8")) {
      console.log(`~ ${name}: same operations, but the spec body changed — check git diff after --write`);
      problems++;
    }
  } else {
    console.log(`i ${name}: no snapshot yet, recording baseline`);
  }

  for (const op of liveOps) {
    if (!COVERED[op] && !SKIPPED[op]) {
      console.log(`! ${name}: UNIMPLEMENTED ${op}`);
      problems++;
    }
  }

  if (write || !existsSync(snapPath)) {
    writeFileSync(snapPath, serialised);
  }
}

// Anything in COVERED that the specs no longer expose is a dead client method.
const allLive = SPECS.flatMap((n) => {
  const p = join(SPEC_DIR, `${n}.json`);
  return existsSync(p) ? operations(JSON.parse(readFileSync(p, "utf8"))) : [];
});
for (const op of Object.keys(COVERED)) {
  if (!allLive.includes(op)) {
    console.log(`! STALE ${op} → ${COVERED[op]}() has no matching endpoint`);
    problems++;
  }
}

if (problems === 0) {
  console.log(`✓ in sync — ${Object.keys(COVERED).length} operations implemented, ${Object.keys(SKIPPED).length} deliberately skipped`);
} else {
  console.log(`\n${problems} item(s) need attention. Re-run with --write once handled.`);
}
process.exit(problems === 0 ? 0 : 1);
