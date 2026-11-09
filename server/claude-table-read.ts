// The short child that reads Claude Code's program file (about 342 MB, held as one string while it
// runs, so never in the server) and prints what bundle-table.ts made of it, as one JSON line.
import { readFileSync } from "node:fs";
import { parseClaudeTable } from "../pi-config/extensions/claude-code/bundle-table.ts";

try {
  const result = parseClaudeTable(readFileSync(process.argv[2]!).toString("latin1"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: err instanceof Error ? err.message : String(err) })}\n`);
}
