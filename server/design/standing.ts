// Which providers a Lookbook Setup card lists: only those that can run right now, minus the ones the user hid. Read once,
// when the card's model list is built; a provider that starts working while the card is up never joins that card.
// Anything not known for sure keeps its rows: only a reading that says it can't run leaves a provider out.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DesignLeftOutWhy } from "../../shared/design";
import type { UsageInsight, UsageProvider } from "../../shared/protocol";
import { agentRoot, stateRoot } from "../state-root";
import { openAiSignInStopped, tokenTimedOut } from "../../shared/sign-in-standing";

/** What one reading says about a provider: it can't run, and why; or null (it runs, or nobody can tell). */
export type Standing = DesignLeftOutWhy | null;

/** Local Ollama, as one probe of its own server found it. names: the models it has downloaded. */
export type OllamaProbe = { state: "running"; names: string[] } | { state: "not-running" } | { state: "unknown" };

/** The readings the standing of each model is worked out from. */
export interface StandingReadings {
  usage: Pick<UsageInsight, "available" | "stale" | "providers" | "claudeLogins"> | null;
  ollama: OllamaProbe | null;
}

/** The usage reading that speaks for a pi provider, or null when none does. */
function usageIdOf(provider: string): UsageProvider["id"] | null {
  const p = provider.toLowerCase();
  if (p === "openai-codex") return "openai";
  if (p === "zai" || p.startsWith("zai-")) return "zai";
  if (p === "deepseek") return "deepseek";
  if (p === "ollama-cloud") return "ollama";
  return null;
}

/** One usage reading's word on a sign-in or key: only states that say it can't run count. OpenAI's by the rule the Usage
    page and Settings → Accounts use: a token that only timed out renews by itself, and the Codex app's own sign-in says
    nothing about pi's. */
function usageStanding(p: UsageProvider | undefined, now: number): Standing {
  if (!p) return null;
  if (p.id === "openai") {
    if (p.auth?.source === "codex-cli") return null;
    if (openAiSignInStopped(p, now)) return "signed-out";
    return p.state === "nologin" ? "signed-out" : p.state === "badkey" ? "bad-key" : null;
  }
  if (p.state === "nologin") return "signed-out";
  if (p.state === "expired") return tokenTimedOut(p.auth, now) ? null : "signed-out";
  if (p.state === "badkey") return "bad-key";
  if (p.state === "nokey") return "no-key";
  return null;
}

/** Claude Code's route: out only when every login this device holds and may use needs a new sign-in. */
function claudeCliStanding(usage: StandingReadings["usage"]): Standing {
  const logins = (usage?.claudeLogins ?? []).filter((l) => l.enabled && (l.holder ? l.holder.self : true));
  if (!logins.length) return null;
  return logins.every((l) => !l.signedIn || l.standing.state === "auth") ? "signed-out" : null;
}

/**
 * Whether the model `ref` can run, by the readings: local Ollama by the probe (not running; running without this model
 * downloaded), the others by their sign-in or key. A stale, missing or unreadable reading never leaves anything out.
 */
export function modelStanding(ref: string, readings: StandingReadings, now = Date.now()): Standing {
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash).toLowerCase();
  const id = ref.slice(slash + 1);
  if (provider === "ollama") {
    const o = readings.ollama;
    if (!o || o.state === "unknown") return null;
    if (o.state === "not-running") return "not-running";
    return o.names.some((n) => n === id || n === `${id}:latest` || `${n}:latest` === id) ? null : "not-downloaded";
  }
  const usage = readings.usage;
  if (!usage || !usage.available || usage.stale) return null;
  if (provider === "claude-code-cli") return claudeCliStanding(usage);
  const uid = usageIdOf(provider);
  return uid ? usageStanding(usage.providers.find((p) => p.id === uid), now) : null;
}

/** Local Ollama's address, from the agent's models.json (`providers.ollama.baseUrl`), else its default. */
export function localOllamaOrigin(agentDir: string = agentRoot()): string {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as { providers?: Record<string, { baseUrl?: unknown }> };
    const base = raw.providers?.ollama?.baseUrl;
    if (typeof base === "string") return new URL(base).origin;
  } catch {
    // No file, or no Ollama in it: its usual address.
  }
  return "http://127.0.0.1:11434";
}

/** How long the card waits on local Ollama before it says it can't tell. */
export const OLLAMA_PROBE_MS = 800;

/** Ask local Ollama what it has downloaded. Refused: not running; any other failure or a slow answer: can't tell. */
export async function probeLocalOllama(origin: string = localOllamaOrigin(), timeoutMs = OLLAMA_PROBE_MS, fetcher: typeof fetch = fetch): Promise<OllamaProbe> {
  try {
    const res = await fetcher(`${origin}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { state: "unknown" };
    const body = (await res.json()) as { models?: { name?: unknown; model?: unknown }[] };
    if (!Array.isArray(body?.models)) return { state: "unknown" };
    const names = body.models.flatMap((m) => [m?.name, m?.model]).filter((x): x is string => typeof x === "string");
    return { state: "running", names: [...new Set(names)] };
  } catch (err) {
    return refused(err) ? { state: "not-running" } : { state: "unknown" };
  }
}

/** A connection refused, wherever the runtime puts its code. */
function refused(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    const code = (e as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ConnectionRefused") return true;
  }
  return false;
}

/** The readings for a card being built: the probe only when local Ollama has models listed. Tests stand in for it. */
const realStandings = async (refs: readonly string[]): Promise<StandingReadings> => {
  const { getUsageInsight } = await import("../insights");
  const [usage, ollama] = await Promise.all([getUsageInsight().catch(() => null), refs.some((r) => r.toLowerCase().startsWith("ollama/")) ? probeLocalOllama() : Promise.resolve(null)]);
  return { usage, ollama };
};
let readStandingsImpl = realStandings;
export const readStandings = (refs: readonly string[]): Promise<StandingReadings> => readStandingsImpl(refs).catch(() => ({ usage: null, ollama: null }));
export const setStandingsForTest = (fn: ((refs: readonly string[]) => Promise<StandingReadings>) | null): void => {
  readStandingsImpl = fn ?? realStandings;
};

// ---- the sections the user hid -----------------------------------------------------------------

const hiddenFile = () => join(stateRoot(), "design-hidden-providers.json");

/** The picker sections the user hid on a Setup card: later cards leave them out too. */
export function readHiddenSections(): string[] {
  try {
    const v = JSON.parse(readFileSync(hiddenFile(), "utf8")) as { sections?: unknown };
    return Array.isArray(v.sections) ? v.sections.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remember a section as hidden or shown, for every later card. */
export function rememberHidden(section: string, hidden: boolean): string[] {
  const now = readHiddenSections().filter((s) => s !== section);
  if (hidden) now.push(section);
  const f = hiddenFile();
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ sections: now }, null, 2)}\n`);
  renameSync(tmp, f);
  return now;
}
