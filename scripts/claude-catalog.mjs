// How the installed Claude Code CLI's own model table differs from Sova's Claude catalog
// (pi-config/extensions/claude-code/catalog.ts, §app.claude-code-provider/catalog). Dev only, $0:
// it reads the CLI binary's bundled table (no model call, no network) and prints what to change.
// Sova follows the table by itself (server/claude-table.ts); this shows a person what it would see. Run with `pnpm run claude:catalog`
// (Node strips the catalog's types), or `-- --bundle <path to a claude binary>`.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseClaudeTable } from "../pi-config/extensions/claude-code/bundle-table.ts";
import { CLAUDE_MODELS, latestClaude } from "../pi-config/extensions/claude-code/catalog.ts";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

/** The newest installed CLI binary (the native installer keeps one file per version). */
function bundlePath() {
  const given = arg("--bundle");
  if (given) return realpathSync(given);
  const dir = join(homedir(), ".local", "share", "claude", "versions");
  const versions = readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v) && statSync(join(dir, v)).isFile());
  versions.sort((a, b) => a.split(".").map(Number).reduce((d, n, i) => d || n - Number(b.split(".")[i]), 0));
  if (!versions.length) throw new Error(`No Claude Code binary under ${dir}; pass --bundle <path>.`);
  return join(dir, versions.at(-1));
}

const path = bundlePath();
const parsed = parseClaudeTable(readFileSync(path).toString("latin1"));
if (!parsed.ok) throw new Error(`Can't read this CLI's table: ${parsed.reason}`);
const { latest } = parsed.table;
const models = new Map(parsed.table.rows.map((row) => [row.id, row]));
console.log(`Claude Code bundle: ${path} (${models.size} models)`);
const lines = [];
for (const entry of CLAUDE_MODELS) {
  const b = models.get(entry.id);
  if (!b) {
    lines.push(`- ${entry.id} (${entry.name}): not in this CLI's table`);
    continue;
  }
  if (b.name !== entry.name) lines.push(`~ ${entry.id}: name ${entry.name} → ${b.name}`);
  if (b.window !== entry.window) lines.push(`~ ${entry.id}: window ${entry.window} → ${b.window}`);
  if (b.maxOutput !== undefined && b.maxOutput !== entry.maxOutput) lines.push(`~ ${entry.id}: maxOutput ${entry.maxOutput} → ${b.maxOutput}`);
  const api = b.firstParty && b.firstParty !== entry.id ? [b.firstParty] : [];
  if (JSON.stringify(api) !== JSON.stringify(entry.apiIds)) lines.push(`~ ${entry.id}: apiIds ${JSON.stringify(entry.apiIds)} → ${JSON.stringify(api)}`);
}
for (const [family, id] of Object.entries(latest)) {
  const ours = ["opus", "sonnet", "fable", "haiku"].includes(family) ? latestClaude(family).id : undefined;
  if (ours && ours !== id) lines.push(`! ${family}: the CLI's latest is ${id}; the catalog's current is ${ours}`);
  if (!CLAUDE_MODELS.some((m) => m.id === id)) {
    const b = models.get(id);
    lines.push(`+ ${id}${b ? ` (${b.name}, window ${b.window}, maxOutput ${b.maxOutput ?? "?"}${b.firstParty && b.firstParty !== id ? `, apiIds ["${b.firstParty}"]` : ""})` : ""}: the CLI's latest ${family}, not in the catalog`);
  }
}
console.log(lines.length ? lines.join("\n") : "The catalog agrees with this CLI.");
