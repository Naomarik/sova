#!/usr/bin/env node
// Merge check: Sova's reader still makes sense of the Claude Code installed on this computer. Sova
// follows that table by itself and only says so quietly in Settings when it can't, so a Claude Code
// that changes the table's layout has to fail loudly here. Reads the program file; no model call.
//   node scripts/merge-checks/claude-table.mjs [--bundle <path to a claude binary>]
// Exit 0: parsed with models, or no Claude Code on this computer (SOVA_OUT {skipped}). Exit 1: none found.
import { readFileSync, realpathSync } from "node:fs";
import { opt, report, skip } from "./lib.mjs";
import { parseClaudeTable } from "../../pi-config/extensions/claude-code/bundle-table.ts";
import { claudeExecutable } from "../../pi-config/extensions/claude-code/claude-executable.ts";

const out = process.env.SOVA_OUT || null;
let file = opt(process.argv.slice(2), "--bundle");
if (!file) {
  try {
    file = claudeExecutable();
  } catch {
    skip(out, "no Claude Code on this computer");
  }
}
const parsed = parseClaudeTable(readFileSync(realpathSync(file)).toString("latin1"));
if (!parsed.ok || !Object.keys(parsed.table.latest).length) {
  const message = parsed.ok ? "the table has no latest_per_family" : parsed.reason;
  console.error(`FAILED: Sova can't read Claude Code's model table in ${file}: ${message}`);
  report(out, { passed: 0, failed: 1, failures: [{ name: "Claude Code's model table", file: "pi-config/extensions/claude-code/bundle-table.ts", message }] });
  process.exit(1);
}
console.log(`Claude Code's table: ${parsed.table.rows.length} models, version ${parsed.table.cliVersion ?? "unknown"}, latest ${Object.values(parsed.table.latest).join(", ")}`);
report(out, { passed: 1, failed: 0 });
