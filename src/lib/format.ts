// The clock, the stamp and the relative time are pi-config's `stamp` formatter, so the TUI's
// transcript stamps and every time in Sova read the same ("1:43 PM", "Mar 4 1:43 PM", "5m ago").
export { agoTime, clockTime, relativeTime, stampAgo, stampTime } from "../../pi-config/extensions/stamp/format.ts";
// Claude model names and ids are Sova's Claude catalog (claude-code/catalog.ts, which imports
// nothing): the one copy the extension, the server and the web app read.
import { claudeByAnswer, claudeName, resolveClaude } from "../../pi-config/extensions/claude-code/catalog.ts";
export { canonicalClaudeId, claudeModel, claudeName as claudeModelName, unverifiedClaudeNote } from "../../pi-config/extensions/claude-code/catalog.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** How long until a future time, for "next refresh in {rel}": "in 3m", "in 2h", "in 1d"; under a
    minute "in under a minute". Null when the time is unreadable or already passed. */
export function relativeIn(iso: string, now = Date.now()): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t <= now) return null;
  const sec = Math.round((t - now) / 1000);
  if (sec < 60) return "in under a minute";
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

export function prettyJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Shows $HOME as `~`. */
export function tildePath(p: string, home: string | null): string {
  if (!home) return p;
  if (p === home) return "~";
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** $HOME inferred from a session file path (`<home>/.pi/agent/sessions/...`). */
export function homeFromSessionPath(path: string): string | null {
  const i = path.indexOf("/.pi/agent/sessions/");
  return i > 0 ? path.slice(0, i) : null;
}

/** Model id without the provider: "anthropic/claude-opus-5" → "claude-opus-5". */
export function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const i = model.indexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

/** The provider a model ref names: "anthropic/claude-opus-5" → "anthropic"; "" when it has none. */
export function modelProvider(model: string | null | undefined): string {
  if (!model) return "";
  const i = model.indexOf("/");
  return i > 0 ? model.slice(0, i) : "";
}

/**
 * A model's name for display (§app.claude-code-provider/model-names): a Claude model under any
 * provider reads its catalog name, of the model that answered when that is known ("Opus 5.5",
 * "Haiku 4.5", an old alias read through the frozen legacy table); anything else its short id.
 */
export function modelLabel(model: string | null | undefined, answered?: string | null): string | null {
  return claudeName(answered) ?? claudeName(model) ?? shortModel(model);
}

/**
 * "Asked for Opus 5.5; Opus 4.8 answered." when the model that answered is another Claude catalog
 * model than the one asked for (§app.claude-code-provider/model-identity), else null.
 */
export function modelMismatch(asked: string | null | undefined, answered: string | null | undefined): string | null {
  const a = resolveClaude(asked);
  const b = claudeByAnswer(answered);
  return a && b && a.id !== b.id ? `Asked for ${a.name}; ${b.name} answered.` : null;
}

/**
 * What a by-model usage row's `title` adds to its id (§app.insights/usage-model-rows): the ids its
 * calls asked for, and, for a row another model answered, the mismatch (its label then carries ⚠).
 */
export function usageModelNote(row: { model: string; requested?: string[]; asked?: string }): string {
  const parts: string[] = [];
  if (row.asked) parts.push(modelMismatch(row.asked, row.model) ?? `Asked for ${row.asked}.`);
  if (row.requested?.length) parts.push(`Asked as ${row.requested.join(", ")}.`);
  return parts.join(" ");
}

/**
 * A model id for a meta line, where the width belongs to the numbers beside it: a Claude model's
 * catalog name ("anthropic/claude-haiku-4-5-20251001" → "Haiku 4.5", "claude-opus-5[1m]" → "Opus 5");
 * any other id without provider or dated build, with a dotted version ("openai/gpt-4-1" → "gpt-4.1").
 * Lossy on purpose: the full id belongs in the `title` next to it.
 */
export function compactModel(model: string | null | undefined): string | null {
  const name = claudeName(model);
  if (name) return name;
  const short = shortModel(model);
  if (!short) return null;
  const variant = /\[([^\]]+)\]\s*$/.exec(short)?.[1];
  const id = short
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/-20\d{6}(?=$|-)/, "") // dated build
    .replace(/^claude-/, "")
    .replace(/-(\d+)-(\d+)$/, "-$1.$2");
  if (!id) return short;
  return variant ? `${id} ${variant.toUpperCase()}` : id;
}

/** Compact span: "40s" · "42m" · "2h 17m" · "3d 4h". */
export function duration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 ? `${hr}h ${min % 60}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  return hr % 24 ? `${day}d ${hr % 24}h` : `${day}d`;
}

/** "Mar 4" (year added when it isn't this year's). */
export function shortDate(t: number, now = Date.now()): string {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

/** 50000 → "50,000". */
export const thousands = (n: number) => n.toLocaleString("en-US");
