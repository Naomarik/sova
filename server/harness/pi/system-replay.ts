// The system prompt and tools as pi replays a branch's system entries (pi 0.86+, §app.baton/told): pi-ai's
// own replay, over the pi messages behind the branch's `system` HEntries, so it is what pi sent.
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { HEntry } from "../../../shared/harness";
import { rawOf } from "./reader";

/** A system entry's message, as pi 0.86+ writes it. */
export interface SystemMessage {
  role: "system";
  content: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: { name: string; description?: string; parameters?: unknown }[];
  toolsRemoved?: { name: string }[];
  timestamp?: number;
}

/** pi-ai's transcript replay (the functions pi itself replays system entries with). */
export interface Replay {
  getCurrentSystemPrompt(messages: readonly { role: string }[]): string;
  getCurrentTools(messages: readonly { role: string }[]): { name: string; description?: string; parameters?: unknown }[];
}

let replayLoad: Promise<Replay> | null = null;
/** pi-ai, resolved beside the pi package's real path (pnpm keeps it there, not in Sova's own dependencies). */
export function piReplay(): Promise<Replay> {
  replayLoad ??= (async () => {
    const pi = realpathSync(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    let dir = dirname(pi);
    while (basename(dir) !== "pi-coding-agent" && dirname(dir) !== dir) dir = dirname(dir);
    return (await import(pathToFileURL(join(dirname(dir), "pi-ai", "dist", "utils", "transcript.js")).href)) as Replay;
  })();
  return replayLoad;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isoOf = (ms: unknown): string => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "");

export interface ReplayedSystem {
  /** The prompt as last recorded before the cut; null when the branch has no system entry before it. */
  prompt: { text: string; at: string; changes: number } | null;
  /** The prompt replayed through the cut's own entry, when the branch has one. */
  through?: { text: string; at: string };
  tools: { name: string; description?: string; parameters?: unknown }[];
}

/**
 * The prompt and tools as the branch's system entries last recorded them, before the first entry that adds
 * the tool `cutAt`; and the prompt replayed through that entry. Pure, given the replay.
 */
export function replaySystem(branch: readonly HEntry[], replay: Replay, cutAt: string): ReplayedSystem {
  const system = branch.filter((h) => h.kind === "system").map((h) => ({ message: rawOf(h).message as SystemMessage, at: str(h.at) }));
  const cut = system.findIndex((s) => (s.message.toolsAdded ?? []).some((t) => t.name === cutAt));
  const before = cut === -1 ? system : system.slice(0, cut);
  const changed = before.filter((s) => Object.keys(s.message.sections ?? {}).length > 0 || str(s.message.content) !== "");
  const last = changed.at(-1);
  const messages = before.map((s) => s.message);
  return {
    prompt: before.length ? { text: replay.getCurrentSystemPrompt(messages), at: last?.at || before.at(-1)!.at || isoOf(before.at(-1)!.message.timestamp), changes: changed.length } : null,
    ...(cut === -1 ? {} : { through: { text: replay.getCurrentSystemPrompt(system.map((s) => s.message)), at: system[cut]!.at || isoOf(system[cut]!.message.timestamp) } }),
    tools: replay.getCurrentTools(messages),
  };
}
