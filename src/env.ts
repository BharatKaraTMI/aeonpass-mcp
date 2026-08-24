// Side-effect module: loads `.env` into process.env for the Node entrypoints.
//
// Import it *first* in an entrypoint — ESM evaluates imports in order, so this
// runs before any module body reads process.env.
//
// Only the Node entrypoints (`index.ts`, `node.ts`) use it. Vercel and Workers
// don't: those platforms inject configuration themselves and have no
// filesystem to read a dotfile from.
//
// Real environment variables win over the file — that is Node's own
// `--env-file` precedence, and it keeps `AEONPASS_BASE_URL=… npm run dev`
// working as a one-off override.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `../.env` relative to this module is the package root under both `src/`
// (tsx) and `dist/` (compiled), so the stdio server finds its config no matter
// which directory the MCP client happened to launch it from. cwd is the
// fallback for the case where the package is installed elsewhere.
const candidates = new Set([
  fileURLToPath(new URL("../.env", import.meta.url)),
  resolve(process.cwd(), ".env"),
]);

for (const path of candidates) {
  if (!existsSync(path)) continue;
  try {
    process.loadEnvFile(path);
  } catch (err) {
    // A malformed .env shouldn't take the server down: everything it holds is
    // either optional or reported with a clearer error downstream.
    console.error(`Warning: could not read ${path}: ${(err as Error).message}`);
  }
}
