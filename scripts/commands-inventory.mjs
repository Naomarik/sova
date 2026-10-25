#!/usr/bin/env node
// Renders docs/commands.md from server/commands-inventory/baseline.json and shared/commands-catalog.ts.
//
//   node scripts/commands-inventory.mjs           rewrite docs/commands.md
//   node scripts/commands-inventory.mjs --check   exit 1, changing nothing, when it is stale
//
// The baseline itself is computed by the test, which builds the app:
//   SOVA_INVENTORY_OUT=$PWD/server/commands-inventory/baseline.json pnpm test -- server/commands-inventory.test.ts
// Exit codes: 0 written or current, 1 stale (--check), 2 bad usage.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderCommandsDoc } from "../server/commands-inventory/render.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(REPO, "server/commands-inventory/baseline.json");
const DOC = join(REPO, "docs/commands.md");

const args = process.argv.slice(2);
if (args.some((a) => a !== "--check")) {
  process.stderr.write("usage: node scripts/commands-inventory.mjs [--check]\n");
  process.exit(2);
}
const want = renderCommandsDoc(JSON.parse(readFileSync(BASELINE, "utf8")));
let have = null;
try {
  have = readFileSync(DOC, "utf8");
} catch {
  // no doc yet
}
if (args.includes("--check")) {
  if (have === want) process.exit(0);
  process.stderr.write("docs/commands.md is stale: run node scripts/commands-inventory.mjs\n");
  process.exit(1);
}
if (have !== want) writeFileSync(DOC, want);
process.stdout.write(have === want ? "docs/commands.md is current\n" : "wrote docs/commands.md\n");
