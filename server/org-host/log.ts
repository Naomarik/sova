// The org's transition log (design §5.5): one append-only JSONL segment per month,
// `<workspace>/statecharts/log/<yyyy-mm>.jsonl` for portable sessions and
// `<stateRoot>/statecharts/<org>/log/<yyyy-mm>.jsonl` for host-local ones.
//
// Privacy: a row never holds link tokens or hashes, never message text, never About text or contact
// values. `scrub` applies the statechart's `:redact` rules over the defaults, by key name, anywhere in the
// envelope and in `changed` (a dotted path matches when ANY of its segments has a rule, outermost first:
// `contact.email` is contact), and to a field-change record's from/to (`{field: "contact", from, to}`): "drop" removes the key, "contact" writes "[contact]", "digest" writes
// `{sha, len}` (sha-256 of the text, hex). A refusal's model tail is never logged.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Json, Step } from "../statecharts";

export type RedactRule = "drop" | "contact" | "digest";

/** Keys scrubbed in every statechart's rows. */
export const DEFAULT_REDACT: Record<string, RedactRule> = {
  token: "drop",
  tokens: "drop",
  tokenHash: "drop",
  hash: "drop",
  secret: "drop",
  link: "drop",
  links: "drop",
  url: "drop",
  contact: "contact",
  email: "contact",
  phone: "contact",
  whatsapp: "contact",
  about: "digest",
  text: "digest",
  message: "digest",
  quote: "digest",
  // free text the operator or an overseer wrote (a build's start prompt)
  prompt: "digest",
};

/** The value keys of a field-change record (`{field: "contact", from, to}`): scrubbed by the field's rule. */
const FIELD_VALUE_KEYS = ["from", "to", "value", "old", "new"];

export interface LogRow {
  at: number;
  org: string;
  session: string | null;
  statechart: string | null;
  event: string;
  by: string | null;
  via?: string;
  reason?: string;
  envelope: Json;
  before: string[];
  after: string[];
  changed: Record<string, Json>;
  effects: string[];
  refused?: string;
  refusedStage?: string;
  refusedCheck?: string;
  held?: { id: string; until: number; what?: string | null; wait?: string; confirm?: boolean };
  /** r8a: "feed" or "quiet" (the project feed shows feed rows only). */
  feed?: "feed" | "quiet";
  /** The session's project, when it belongs to one. */
  project?: string | null;
  offHours?: number;
  /** The journal that wrote it (replay appends a row once). */
  j?: string;
  /** The engine's own time, when `at` was moved on to keep it unique (a log replay runs on it). */
  t?: number;
  /** A host start's data, scrubbed (its envelope is who started it). */
  start?: Json;
  /** The run a report answers. */
  invokeId?: string;
  /** No statechart step wrote it (`logAct`: a note, an idea, a confirm). */
  plain?: boolean;
  [extra: string]: Json | undefined;
}

export function digest(text: string): { sha: string; len: number } {
  return { sha: createHash("sha256").update(text).digest("hex"), len: text.length };
}

/** The rule for a key or a dotted path: the first segment, outermost first, that has one
    (`contact.email` is contact). */
function ruleFor(key: string, rules: Record<string, RedactRule>): RedactRule | undefined {
  if (rules[key]) return rules[key];
  for (const seg of key.split(".")) if (rules[seg]) return rules[seg];
  return undefined;
}

function apply(rule: RedactRule, v: unknown): Json | undefined {
  if (rule === "drop") return undefined;
  if (rule === "contact") return v == null ? null : "[contact]";
  if (v == null) return null;
  return digest(typeof v === "string" ? v : JSON.stringify(v));
}

/** `value` with every redacted key scrubbed, recursively. */
export function scrub(value: unknown, rules: Record<string, RedactRule> = DEFAULT_REDACT): Json {
  if (Array.isArray(value)) return value.map((v) => scrub(v, rules));
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    const obj = value as Record<string, unknown>;
    const fieldRule = typeof obj["field"] === "string" ? ruleFor(obj["field"], rules) : undefined;
    for (const [k, v] of Object.entries(obj)) {
      const rule = ruleFor(k, rules) ?? (fieldRule && FIELD_VALUE_KEYS.includes(k) ? fieldRule : undefined);
      if (rule) {
        const x = apply(rule, v);
        if (x !== undefined) out[k] = x;
      } else out[k] = scrub(v, rules);
    }
    return out;
  }
  if (value === undefined || typeof value === "function") return null;
  return value as Json;
}

/** `changed` ({path: [from, to]}) scrubbed: a redacted path's values by its rule, else recursively. */
export function scrubChanged(changed: Record<string, unknown> | undefined, rules: Record<string, RedactRule>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [path, pair] of Object.entries(changed ?? {})) {
    const rule = ruleFor(path, rules);
    const [from, to] = Array.isArray(pair) ? pair : [null, pair];
    if (rule === "drop") out[path] = ["[dropped]", "[dropped]"];
    else if (rule) out[path] = [apply(rule, from) ?? null, apply(rule, to) ?? null];
    else out[path] = [scrub(from, rules), scrub(to, rules)];
  }
  return out;
}

/** The log row of an engine step (before `at` is made unique). */
export function rowOfStep(org: string, step: Step, rules: Record<string, RedactRule>): LogRow {
  const row: LogRow = {
    at: step.at,
    org,
    session: step.sessionId,
    statechart: step.statechart ?? null,
    event: step.event,
    by: step.by ?? null,
    envelope: scrub(step.data ?? {}, rules),
    before: step.before,
    after: step.after,
    changed: scrubChanged(step.changed, rules),
    effects: step.effects ?? [],
  };
  if (step.via) row.via = step.via;
  if (step.reason) row.reason = step.reason;
  // the run a report answers (a log replay sends it again with it)
  if (step.invokeId) row.invokeId = step.invokeId;
  if (step.refused) {
    row.refused = step.refused.sentence;
    if (step.refused.stage) row.refusedStage = step.refused.stage;
    if (step.refused.check) row.refusedCheck = step.refused.check;
  }
  if (step.held) {
    row.held = { id: step.held.id, until: step.held.until, what: step.held.what ?? null };
    if (step.held.wait) row.held.wait = step.held.wait;
    if (step.held.confirm) row.held.confirm = true;
  }
  row.feed = step.feed ?? "feed";
  row.project = step.projectId ?? null;
  if (step.offHours != null) row.offHours = step.offHours;
  return row;
}

export function segmentOf(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`;
}

export function segmentFile(dir: string, at: number): string {
  return join(dir, segmentOf(at));
}

export interface RowFilter {
  session?: string;
  sessions?: string[];
  since?: number;
  until?: number;
  limit?: number;
  newestFirst?: boolean;
}

export interface LogProblem {
  file: string;
  why: string;
}

/** Rows of every segment under `dirs`, filtered; unparseable lines are reported, never thrown. */
export function readRows(dirs: string[], filter: RowFilter = {}, problems: LogProblem[] = []): LogRow[] {
  const want = filter.sessions ? new Set(filter.sessions) : filter.session ? new Set([filter.session]) : null;
  const rows: LogRow[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      const file = join(dir, name);
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.trim()) return;
        let row: LogRow;
        try {
          row = JSON.parse(line) as LogRow;
        } catch {
          problems.push({ file, why: `line ${i + 1} is not JSON` });
          return;
        }
        if (want && !want.has(row.session ?? "")) return;
        if (filter.since != null && row.at < filter.since) return;
        if (filter.until != null && row.at > filter.until) return;
        rows.push(row);
      });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  if (filter.newestFirst) rows.reverse();
  return filter.limit != null ? rows.slice(0, filter.limit) : rows;
}

/** The newest `at` in the newest segment of each dir (to keep `at` unique across restarts). */
export function lastAt(dirs: string[]): number {
  let last = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const newest = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort().at(-1);
    if (!newest) continue;
    for (const line of readFileSync(join(dir, newest), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        last = Math.max(last, (JSON.parse(line) as LogRow).at ?? 0);
      } catch {
        // a broken line blocks nothing here
      }
    }
  }
  return last;
}

/** Append rows to their segment files (one write per file). */
export function appendRows(entries: { file: string; row: LogRow }[]): void {
  const byFile = new Map<string, string[]>();
  for (const { file, row } of entries) byFile.set(file, [...(byFile.get(file) ?? []), JSON.stringify(row)]);
  for (const [file, lines] of byFile) {
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, lines.join("\n") + "\n");
  }
}
