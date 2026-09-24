import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SummarizerBackend, SummarizerChoice, SummarizerSettings, SummarizerSettingsInfo } from "../shared/protocol";

/**
 * Settings → Summaries: which model writes the sidebar's summary line. The file is the
 * topic-outline extension's (`~/.pi/agent/topic-outline.json`), read by the TUI and every Sova
 * runtime once per session, at session_start — so a save reaches sessions started afterwards, and
 * the file's other keys (trigger, limits, claudeBin, share*, and each kept summarizer's timeoutMs
 * / maxBudgetUsd) belong to the user and are written back exactly as they were.
 *
 * Nothing here is imported from pi-config: the extension's rules are small, and mirrored below
 * with a pointer to the original. The extension reads `join(homedir(), ".pi/agent")`; this uses
 * the agent dir, which is the same folder unless PI_CODING_AGENT_DIR isolates a test server.
 */
export const topicOutlineFile = () => join(getAgentDir(), "topic-outline.json");

const BACKENDS: readonly SummarizerBackend[] = ["claude-code", "pi"];

/**
 * The extension's own chain when the file is missing or names no usable summarizer — a copy of
 * DEFAULT_CONFIG.summarizers in pi-config/extensions/topic-outline/config.ts. Keep them equal:
 * the screen shows these as the current choice, and a save that keeps one carries its timeout and
 * budget over, so the written file behaves like the defaults did.
 */
const DEFAULT_SUMMARIZERS: Record<string, unknown>[] = [
  { backend: "claude-code", model: "haiku", timeoutMs: 45_000, maxBudgetUsd: 0.05 },
  { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", timeoutMs: 60_000 },
];

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The entries the extension would run, as the raw objects the file holds (unknown keys included).
 * Mirrors `sanitizeSummarizers` in pi-config/extensions/topic-outline/config.ts: an entry counts
 * when its backend is "claude-code" or "pi" and its model a non-empty string; everything else is
 * skipped, and a list with nothing usable means the defaults.
 */
function usableEntries(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (e): e is Record<string, unknown> =>
      isRecord(e) && BACKENDS.includes(e.backend as SummarizerBackend) && typeof e.model === "string" && e.model !== "",
  );
  return out.length ? out : undefined;
}

const choiceOf = (entry: Record<string, unknown>): SummarizerChoice => ({
  backend: entry.backend as SummarizerBackend,
  model: entry.model as string,
});

const toSettings = (chain: Record<string, unknown>[]): SummarizerSettings => ({
  primary: choiceOf(chain[0]!),
  fallback: chain[1] ? choiceOf(chain[1]) : null,
});

type Stored =
  | { kind: "missing" }
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "unreadable"; reason: string };

function readStored(file: string): Stored {
  if (!existsSync(file)) return { kind: "missing" };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { kind: "unreadable", reason: `${file} isn't valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  return isRecord(data) ? { kind: "ok", data } : { kind: "unreadable", reason: `${file} doesn't hold a JSON object` };
}

/** The chain the extension runs today, and whether it is the defaults because the file named none. */
function effectiveChain(stored: Stored): { chain: Record<string, unknown>[]; usingDefaults: boolean } {
  const listed = stored.kind === "ok" ? usableEntries(stored.data.summarizers) : undefined;
  return listed ? { chain: listed, usingDefaults: false } : { chain: DEFAULT_SUMMARIZERS, usingDefaults: true };
}

/** GET: what the extension would run, read tolerantly — a file it would ignore reads as the defaults, as it does there. */
export function readSummarizerSettings(file = topicOutlineFile()): SummarizerSettingsInfo {
  const stored = readStored(file);
  const { chain, usingDefaults } = effectiveChain(stored);
  const info: SummarizerSettingsInfo = {
    settings: toSettings(chain),
    defaults: toSettings(DEFAULT_SUMMARIZERS),
    usingDefaults,
    beyond: Math.max(0, chain.length - 2),
    file,
  };
  if (stored.kind === "unreadable") info.unreadable = stored.reason;
  return info;
}

/**
 * The PUT body, strictly: `{ primary: {backend, model}, fallback: {backend, model} | null }` and
 * nothing else. Model shapes are the ones each backend can run: a pi ref is "provider/model"
 * (the extension's pi summarizer refuses anything else), a Claude Code model is a bare alias or id
 * handed to `claude --model`, so no "/", no leading "-". Whether the model is offered is not
 * checked here: the screen shows that, and the chain skips a model that can't run.
 */
export function parseSummarizerSettings(raw: unknown): SummarizerSettings | { error: string } {
  const shape = "Expected { primary: { backend, model }, fallback: { backend, model } | null }";
  if (!isRecord(raw)) return { error: shape };
  const extra = Object.keys(raw).filter((k) => k !== "primary" && k !== "fallback");
  if (extra.length) return { error: `Unknown field ${extra.map((k) => JSON.stringify(k)).join(", ")}. ${shape}` };
  const primary = parseChoice(raw.primary, "primary");
  if ("error" in primary) return primary;
  if (!("fallback" in raw)) return { error: `fallback is required (null for none). ${shape}` };
  if (raw.fallback === null) return { primary, fallback: null };
  const fallback = parseChoice(raw.fallback, "fallback");
  if ("error" in fallback) return fallback;
  if (fallback.backend === primary.backend && fallback.model === primary.model)
    return { error: "The fallback is the same as the primary. Choose another model, or no fallback." };
  return { primary, fallback };
}

function parseChoice(raw: unknown, slot: string): SummarizerChoice | { error: string } {
  if (!isRecord(raw)) return { error: `${slot} must be { backend, model }` };
  const extra = Object.keys(raw).filter((k) => k !== "backend" && k !== "model");
  if (extra.length) return { error: `${slot} has unknown field ${extra.map((k) => JSON.stringify(k)).join(", ")}; only backend and model can be set here` };
  const { backend, model } = raw;
  if (!BACKENDS.includes(backend as SummarizerBackend)) return { error: `${slot}.backend must be "claude-code" or "pi"` };
  if (typeof model !== "string" || model === "") return { error: `${slot}.model must be a non-empty string` };
  if (model.length > 200 || /[\s\u0000-\u001f\u007f]/.test(model)) return { error: `${slot}.model can't contain whitespace or control characters` };
  if (backend === "pi") {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) return { error: `${slot}.model must be a pi "provider/model" ref` };
  } else if (model.includes("/") || model.startsWith("-")) {
    return { error: `${slot}.model must be a Claude Code model alias or id (no "/", no leading "-")` };
  }
  return { backend: backend as SummarizerBackend, model };
}

/**
 * PUT: replace the chain with primary (+ fallback) and nothing else of the file. Re-reads first,
 * so a key another writer (or the user's editor) just changed survives; an entry whose backend and
 * model are kept keeps every other field it had — its timeout, its budget, anything we don't
 * know — wherever it moves in the chain. A model that isn't kept is written as the default entry
 * when it is one of the defaults, else bare, running on the extension's own per-backend defaults.
 * Atomic via tmp + rename. An unreadable file is refused, never overwritten: its other keys can't
 * be preserved if they can't be read.
 */
export function writeSummarizerSettings(raw: unknown, file = topicOutlineFile()): SummarizerSettingsInfo | { error: string; status: 400 | 409 } {
  const parsed = parseSummarizerSettings(raw);
  if ("error" in parsed) return { error: parsed.error, status: 400 };
  const stored = readStored(file);
  if (stored.kind === "unreadable") return { error: `${stored.reason}. Fix or remove it, then save again.`, status: 409 };

  const { chain: current } = effectiveChain(stored);
  const used = new Set<Record<string, unknown>>();
  const match = (e: Record<string, unknown>, choice: SummarizerChoice) => e.backend === choice.backend && e.model === choice.model;
  const entryFor = (choice: SummarizerChoice): Record<string, unknown> => {
    const kept = current.find((e) => !used.has(e) && match(e, choice));
    if (kept) {
      used.add(kept);
      return { ...kept };
    }
    // A default model picked back (Reset to Defaults, or by hand) comes back as the default entry.
    const builtIn = DEFAULT_SUMMARIZERS.find((e) => match(e, choice));
    return builtIn ? { ...builtIn } : { backend: choice.backend, model: choice.model };
  };
  const summarizers = [entryFor(parsed.primary)];
  if (parsed.fallback) summarizers.push(entryFor(parsed.fallback));

  const base = stored.kind === "ok" ? stored.data : {};
  const next = { ...base, summarizers };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
  return readSummarizerSettings(file);
}
