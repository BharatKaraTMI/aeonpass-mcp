#!/usr/bin/env node
// Detects drift between the published Aeon Pass OpenAPI specs and this server.
//
// Why this exists: `info.version` is "1.0.0" on all three specs and has stayed
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
/**
 * Specs to check. `holdUntil` marks one whose *published* spec is known to lag
 * the surface we implement against: while no live operation sits under that
 * path prefix, the committed snapshot is held — coverage is checked against it
 * rather than diffed away, and `--write` leaves it alone. Drop the field once
 * the published spec catches up; the check says when that happens.
 */
const SPECS = [
  { name: "techaeon" },
  { name: "event" },
  { name: "organization" },
  // The published chat spec is still the pre-portal, JWT-only surface: no
  // /api/portal/conversations/* in it at all. specs/message.json is the dev
  // spec that has them (doc/dev-messageAPI.json). Diffing the two would report
  // every portal operation as GONE and every JWT one as NEW.
  { name: "message", holdUntil: "/api/portal/" },
];

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
  "POST /api/portal/guest": "createGuest",
  "POST /api/portal/guest/{eventId}/list": "listGuests",
  "PUT /api/portal/guest/{id}": "updateGuest",
  "PATCH /api/portal/guest/{id}": "patchGuest",
  "DELETE /api/portal/guest/{id}": "deleteGuest",
  "POST /api/portal/guest/send-invite": "sendInvite",
  "POST /api/portal/guest/send-message": "sendMessageToGuests",

  "POST /api/portal/contact": "createContact",
  "GET /api/portal/contact/{id}": "getContact",
  "PUT /api/portal/contact/{id}": "updateContact",
  "DELETE /api/portal/contact/{id}": "deleteContact",
  "GET /api/portal/contact/list": "listContacts",
  "POST /api/portal/contact/send-message": "sendMessageToContacts",
  "POST /api/portal/contact/upload-list": "uploadContacts",
  "GET /api/portal/guest-group/list": "listGuestGroups",

  "GET /api/portal/conversations/list": "listConversations",
  "POST /api/portal/conversations": "createConversation",
  "GET /api/portal/conversations/{id}": "getConversation",
  "GET /api/portal/conversations/with-contact/{contactId}": "getConversationWithContact",
  "GET /api/portal/conversations/contact/{guestId}": "getContactByGuest",
  "GET /api/portal/conversations/{conversationId}/messages": "listMessages",
  "POST /api/portal/conversations/send-message": "sendConversationMessage",
  "PUT /api/portal/conversations/{id}/mark-read": "markConversationRead",
  "POST /api/portal/conversations/upload-docs": "uploadConversationDocs",
  // Not a REST call — a SignalR handshake, which a stateless per-request MCP
  // server cannot hold open. getChatHubInfo() returns the URL, the auth and the
  // events so a caller can connect the socket themselves.
  "GET /api/portal/chat": "getChatHubInfo",
};

/** Endpoints we've decided not to expose, and why. */
const SKIPPED = {
  "GET /api/portal/contact/export":
    "bulk CSV of every contact — a large PII dump into an LLM context; list_contacts covers paged reads",
};

/** Whole surfaces we don't expose. One reason each, rather than 12 identical lines. */
const SKIPPED_SURFACES = [
  {
    paths: ["/api/chat", "/api/conversations"],
    reason:
      "the chat service's JWT surface — it authenticates an end user's session, and this server only ever holds an X-API-KEY. /api/portal/conversations/* is the same functionality on that key. Covers the Twilio inbound webhook too, which the gateway calls rather than us.",
  },
];

/** The reason this operation is deliberately unimplemented, or undefined. */
const skipReason = (op) => {
  if (SKIPPED[op]) return SKIPPED[op];
  const path = op.slice(op.indexOf(" ") + 1);
  return SKIPPED_SURFACES.find((s) =>
    s.paths.some((p) => path === p || path.startsWith(`${p}/`))
  )?.reason;
};

const operations = (spec) =>
  Object.entries(spec.paths ?? {})
    .flatMap(([path, methods]) =>
      Object.keys(methods)
        .filter((m) => ["get", "put", "post", "delete", "patch"].includes(m))
        .map((m) => `${m.toUpperCase()} ${path}`)
    )
    .sort();

const write = process.argv.includes("--write");
let problems = 0;

mkdirSync(SPEC_DIR, { recursive: true });

for (const { name, holdUntil } of SPECS) {
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
  const serialised = JSON.stringify(live, null, 2) + "\n";

  const snapPath = join(SPEC_DIR, `${name}.json`);
  const hasSnapshot = existsSync(snapPath);
  const snapOps = hasSnapshot ? operations(JSON.parse(readFileSync(snapPath, "utf8"))) : [];

  // Held: the published spec hasn't grown the surface we implement against, so
  // it is the stale one and the snapshot stands. Coverage still gets checked —
  // against the snapshot, which is what the client actually targets.
  const held = holdUntil && !liveOps.some((o) => o.includes(` ${holdUntil}`));

  if (held) {
    console.log(
      `i ${name}: published spec has no ${holdUntil}* operations — holding the committed snapshot (${snapOps.length} operations). Drift is not checked for it.`
    );
  } else if (hasSnapshot) {
    if (holdUntil) {
      console.log(
        `+ ${name}: the published spec now carries ${holdUntil}* — drop holdUntil from SPECS and re-run with --write`
      );
      problems++;
    }
    const added = liveOps.filter((o) => !snapOps.includes(o));
    const removed = snapOps.filter((o) => !liveOps.includes(o));

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

  for (const op of held ? snapOps : liveOps) {
    if (!COVERED[op] && !skipReason(op)) {
      console.log(`! ${name}: UNIMPLEMENTED ${op}`);
      problems++;
    }
  }

  // Never overwrite a held snapshot: --write would replace the surface we
  // implement with the older published one.
  if (!held && (write || !hasSnapshot)) {
    writeFileSync(snapPath, serialised);
  }
}

// Anything in COVERED that the specs no longer expose is a dead client method.
const allLive = SPECS.flatMap(({ name }) => {
  const p = join(SPEC_DIR, `${name}.json`);
  return existsSync(p) ? operations(JSON.parse(readFileSync(p, "utf8"))) : [];
});
for (const op of Object.keys(COVERED)) {
  if (!allLive.includes(op)) {
    console.log(`! STALE ${op} → ${COVERED[op]}() has no matching endpoint`);
    problems++;
  }
}

if (problems === 0) {
  console.log(
    `✓ in sync — ${Object.keys(COVERED).length} operations implemented, ` +
      `${Object.keys(SKIPPED).length} operation(s) and ${SKIPPED_SURFACES.length} surface(s) deliberately skipped`
  );
} else {
  console.log(`\n${problems} item(s) need attention. Re-run with --write once handled.`);
}
process.exit(problems === 0 ? 0 : 1);
