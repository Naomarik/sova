#!/usr/bin/env node
// Writes src/card-toolkit/commands.gen.ts, the card toolkit's command types, from the catalogue.
//
//   node scripts/card-toolkit-types.mjs           rewrite it
//   node scripts/card-toolkit-types.mjs --check   exit 1, changing nothing, when it is stale
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../shared/commands-catalog.ts";
import { cardToolkitTypes } from "../shared/card-toolkit-types.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src/card-toolkit/commands.gen.ts");
const want = cardToolkitTypes(COMMANDS);
let have = null;
try {
  have = readFileSync(OUT, "utf8");
} catch {
  // none yet
}
if (process.argv.includes("--check")) process.exit(have === want ? 0 : 1);
if (have !== want) writeFileSync(OUT, want);
