// How the installed Claude Code CLI's own model table differs from Sova's Claude catalog
// (pi-config/extensions/claude-code/catalog.ts, §app.claude-code-provider/catalog). Dev only, $0:
// it reads the CLI binary's bundled table (no model call, no network) and prints what to change.
// Adopting a model stays an edit to catalog.ts, by hand. Run with `pnpm run claude:catalog`
// (Node strips the catalog's types), or `-- --bundle <path to a claude binary>`.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_1M_WINDOW, CLAUDE_DEFAULT_WINDOW, CLAUDE_MODELS, latestClaude } from "../pi-config/extensions/claude-code/catalog.ts";

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

/** The bundled model table: one entry per `{id:"claude-…",family:"…",display_name:"…"`, its fields read by pattern. */
function bundleModels(text) {
  const starts = [...text.matchAll(/\{id:"(claude-[a-z0-9-]+)",family:"([a-z]+)",display_name:"([^"]+)"/g)];
  const out = new Map();
  starts.forEach((m, k) => {
    if (out.has(m[1])) return;
    const chunk = text.slice(m.index, Math.min(m.index + 3000, starts[k + 1]?.index ?? Infinity));
    const context = /context:\{([^}]*)\}/.exec(chunk)?.[1] ?? "";
    const out1 = /max_output_tokens:\{default:(\d+),upper:(\d+)\}/.exec(chunk);
    out.set(m[1], {
      id: m[1],
      family: m[2],
      name: m[3],
      firstParty: /first_party:"([^"]+)"/.exec(chunk)?.[1],
      window: /native_1m:!0/.test(context) ? CLAUDE_1M_WINDOW : /window:(\d+)/.test(context) ? Number(/window:(\d+)/.exec(context)[1]) : CLAUDE_DEFAULT_WINDOW,
      maxOutput: out1 ? Number(out1[1]) : undefined,
    });
  });
  const latest = /latest_per_family:\{([^}]*)\}/.exec(text)?.[1] ?? "";
  return { models: out, latest: Object.fromEntries([...latest.matchAll(/(\w+):"([^"]+)"/g)].map((m) => [m[1], m[2]])) };
}

const path = bundlePath();
const { models, latest } = bundleModels(readFileSync(path).toString("latin1"));
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
