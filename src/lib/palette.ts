// The command palette's model (§app/command-palette): its rows, the reasons a row can't act, the
// filter, which row Enter acts on, and the form a command's panel shows. DOM- and Solid-free, so
// every rule here runs under `bun test` with no page.
//
// The one rule everything here keeps: nothing acts unless the person chose that row. No row is
// active until an arrow or the pointer makes one so, `enterTarget` answers null otherwise, and a
// command's row opens its panel rather than running (§app.command-palette/picking).

import type { CommandEntry, CommandParam, ParamType } from "../../shared/commands-catalog";
import type { SlashCommand } from "../../shared/protocol";

export type PaletteGroup = "go" | "chat" | "commands" | "extensions";

/** The groups in the order they show, with their labels. */
export const GROUPS: readonly { id: PaletteGroup; label: string }[] = [
  { id: "go", label: "Go to" },
  { id: "chat", label: "This chat" },
  { id: "commands", label: "Commands" },
  { id: "extensions", label: "Extensions" },
];

/** What acting on a row does; the view resolves it. */
export type RowAct = { kind: "view"; id: string } | { kind: "chat"; name: string } | { kind: "command"; entry: CommandEntry };

export interface PaletteRow {
  /** Unique within the list: `view:<id>`, `chat:<name>`, `cmd:<id>`. */
  key: string;
  group: PaletteGroup;
  label: string;
  /** The second line: a command's id (mono), a slash command's description. */
  detail?: string;
  /** A shortcut, shown at the row's end. */
  keys?: string;
  /** Why it can't act now, or null. Shown in place of `detail`. */
  disabled: string | null;
  act: RowAct;
}

/** What the rows' reasons are read from (§app.command-palette/disabled). */
export interface PaletteContext {
  /** The open session, if any. `terminal`: a terminal has it open. */
  session: { path: string; id: string; title: string; terminal: boolean } | null;
  /** The open chat's composer, if one is on screen. */
  composer: { commands: SlashCommand[]; off: string | null; hasDraft: boolean } | null;
}

/** A view row as the view gives it (commands/view.ts). */
export interface ViewRowInput {
  id: string;
  label: string;
  keys?: string;
  disabled: string | null;
}

// ---- disabled reasons --------------------------------------------------------------------

export const REASON = {
  noSession: "Open a session first.",
  terminal: "Not while a terminal has this session open.",
  cli: (id: string) => `Needs the command line: sova run ${id}.`,
  draft: "The composer has a draft.",
} as const;

/** A param the generated form can't take: JSON. */
export const richParam = (p: CommandParam): boolean => p.type === "json";

/** Why a command's row can't act now, or null. `dialogs`: ids that open their own dialog. */
export function commandBlocked(entry: CommandEntry, ctx: PaletteContext, dialogs: ReadonlySet<string>): string | null {
  if (entry.sessionKey && !ctx.session) return REASON.noSession;
  if (entry.sessionKey && entry.sessionFile === "refuses-live" && ctx.session?.terminal) return REASON.terminal;
  if (!dialogs.has(entry.id) && Object.values(entry.params).some((p) => p.required && richParam(p))) return REASON.cli(entry.id);
  return null;
}

/** Why a chat row can't act now, or null. */
export function chatBlocked(composer: NonNullable<PaletteContext["composer"]>): string | null {
  if (composer.off) return composer.off;
  if (composer.hasDraft) return REASON.draft;
  return null;
}

// ---- rows --------------------------------------------------------------------------------

/** Every row, in group order: the views, the open chat's commands, then the served list. */
export function buildRows(views: readonly ViewRowInput[], served: readonly CommandEntry[] | null, ctx: PaletteContext, dialogs: ReadonlySet<string>): PaletteRow[] {
  const rows: PaletteRow[] = views.map((v) => ({ key: `view:${v.id}`, group: "go", label: v.label, keys: v.keys, disabled: v.disabled, act: { kind: "view", id: v.id } }));
  const composer = ctx.composer;
  if (composer) {
    const why = chatBlocked(composer);
    const seen = new Set<string>();
    for (const c of composer.commands) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      rows.push({ key: `chat:${c.name}`, group: "chat", label: `/${c.name}`, detail: c.description || undefined, disabled: why, act: { kind: "chat", name: c.name } });
    }
  }
  const core: PaletteRow[] = [];
  const ext: PaletteRow[] = [];
  const ids = new Set<string>();
  for (const entry of served ?? []) {
    if (ids.has(entry.id)) continue; // one row per id, whatever the server sent
    ids.add(entry.id);
    const row: PaletteRow = {
      key: `cmd:${entry.id}`,
      group: entry.id.startsWith("ext.") ? "extensions" : "commands",
      label: entry.label,
      detail: entry.id,
      disabled: commandBlocked(entry, ctx, dialogs),
      act: { kind: "command", entry },
    };
    (row.group === "extensions" ? ext : core).push(row);
  }
  return [...rows, ...core, ...ext];
}

// ---- filtering ---------------------------------------------------------------------------

const fold = (s: string) => s.toLowerCase();

/** How well `row` matches a lowercased query: lower is better; null is no match. */
export function matchScore(row: PaletteRow, q: string): number | null {
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  const label = fold(row.label);
  const desc = fold(row.act.kind === "command" ? row.act.entry.summary : (row.detail ?? ""));
  const id = fold(row.act.kind === "command" ? row.act.entry.id : row.act.kind === "chat" ? row.act.name : "");
  const hay = `${label}\n${id}\n${desc}`;
  if (!words.every((w) => hay.includes(w))) return null;
  const whole = words.join(" ");
  if (label.startsWith(whole) || id.startsWith(whole) || label.startsWith(`/${whole}`)) return 0;
  if (words.every((w) => label.split(/[\s/.:-]+/).some((part) => part.startsWith(w)))) return 1;
  if (words.every((w) => label.includes(w) || id.includes(w))) return 2;
  return 3;
}

/** The rows matching `query`, groups in their order, best match first within each. */
export function filterRows(rows: readonly PaletteRow[], query: string): PaletteRow[] {
  const q = fold(query.trim());
  if (!q) return [...rows];
  const order = new Map(GROUPS.map((g, i) => [g.id, i]));
  return rows
    .map((row, i) => ({ row, i, s: matchScore(row, q) }))
    .filter((x): x is { row: PaletteRow; i: number; s: number } => x.s !== null)
    .sort((a, b) => order.get(a.row.group)! - order.get(b.row.group)! || a.s - b.s || a.i - b.i)
    .map((x) => x.row);
}

// ---- the active row ----------------------------------------------------------------------

/** No row is active: at each opening and after each change of the query. */
export const NO_ROW = -1;

/** The next active index for an arrow, wrapping; from none, ↓ is the first and ↑ the last. */
export function moveActive(active: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return NO_ROW;
  if (active < 0 || active >= count) return dir === 1 ? 0 : count - 1;
  return (active + dir + count) % count;
}

/** The row Enter acts on: the active one, if it can act; otherwise none. */
export function enterTarget(rows: readonly PaletteRow[], active: number): PaletteRow | null {
  const row = active >= 0 ? rows[active] : undefined;
  return row && !row.disabled ? row : null;
}

// ---- a command's panel -------------------------------------------------------------------

export type FieldKind = "text" | "number" | "checkbox" | "select" | "session";

export interface FormField {
  name: string;
  param: CommandParam;
  kind: FieldKind;
  required: boolean;
  /** A select's values; an optional one starts with "" (left out). */
  options?: readonly string[];
  hint?: string;
}

export interface CommandForm {
  fields: FormField[];
  /** Params the form leaves out (JSON): the command line takes them. */
  leftOut: string[];
}

/** The field a param type always gets; the rest are a select with a fixed set, else text. */
const KIND_OF: Partial<Record<ParamType, FieldKind>> = { session: "session", boolean: "checkbox", number: "number", integer: "number" };

/** The form a command's panel shows (§app.command-palette/command-panel). */
export function formOf(entry: CommandEntry): CommandForm {
  const fields: FormField[] = [];
  const leftOut: string[] = [];
  for (const [name, param] of Object.entries(entry.params)) {
    const required = !!param.required;
    if (richParam(param)) {
      leftOut.push(name);
      continue;
    }
    const kind = KIND_OF[param.type] ?? (param.enum?.length ? "select" : "text");
    if (kind === "select") fields.push({ name, param, kind, required, options: required ? [...param.enum!] : ["", ...param.enum!] });
    else fields.push({ name, param, kind, required, hint: param.type === "list" ? "Separate with commas" : undefined });
  }
  return { fields, leftOut };
}

export type FormInput = Readonly<Record<string, string | boolean | undefined>>;

/**
 * The typed values for `buildRequest` from what the form holds, or the first problem as a
 * sentence. Empty optional fields are left out (the route's default); an optional checkbox is sent
 * only when checked, a required one always. The route still checks everything.
 */
export function valuesOf(form: CommandForm, input: FormInput, session: PaletteContext["session"], sessionKey: CommandEntry["sessionKey"]): { values: Record<string, unknown> } | { error: string } {
  const values: Record<string, unknown> = {};
  for (const f of form.fields) {
    const raw = input[f.name];
    if (f.kind === "session") {
      if (!session) return { error: REASON.noSession };
      values[f.name] = sessionKey === "id" ? session.id : session.path;
      continue;
    }
    if (f.kind === "checkbox") {
      if (raw === true || f.required) values[f.name] = raw === true;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      if (f.required) return { error: `Fill in ${f.name}.` };
      continue;
    }
    if (f.kind === "number") {
      const n = Number(text);
      if (!Number.isFinite(n) || (f.param.type === "integer" && !Number.isInteger(n))) return { error: `Give ${f.name} ${f.param.type === "integer" ? "a whole number" : "a number"}.` };
      values[f.name] = n;
    } else if (f.param.type === "list") {
      values[f.name] = text.split(",").map((s) => s.trim()).filter(Boolean);
    } else values[f.name] = text;
  }
  return { values };
}

/**
 * The host a command must go to, beyond what the request names: a command that names the open
 * session by id goes to the host holding that session, as the rest of the page sends a peer's
 * session's requests (a path-named one is routed by its path already). null: as the request says.
 */
export function commandHost(entry: Pick<CommandEntry, "sessionKey">, session: PaletteContext["session"], hostOf: (path: string) => string | null): string | null {
  return entry.sessionKey === "id" && session ? hostOf(session.path) : null;
}

// The panel's two-step lives with its arming (lib/palette-arm.ts), which imports this file's types only.
export { panelStep, type PanelEvent } from "./palette-arm";

export type AnswerState = "done" | "refused" | "unknown";

/** An in-chat action handed over whose outcome isn't known (202 `unknown`, `sova run` exit 5). */
export const UNKNOWN_TEXT = "Handed to the chat, but its outcome is unknown. Check the chat before you run it again: it wasn't and won't be retried.";

/** A route's answer, as the panel shows it: the refusal's own sentence, or the body as text. */
export function answerText(status: number, body: unknown): { state: AnswerState; text: string } {
  const obj = body && typeof body === "object" ? (body as { error?: unknown; outcome?: unknown }) : null;
  if (status === 202 && obj?.outcome === "unknown") return { state: "unknown", text: UNKNOWN_TEXT };
  const state: AnswerState = status >= 200 && status < 300 ? "done" : "refused";
  if (state === "refused" && typeof obj?.error === "string") return { state, text: obj.error };
  if (body === undefined || body === null || body === "") return { state, text: state === "done" ? "" : `The server answered ${status}.` };
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return { state, text: text.length > ANSWER_MAX ? `${text.slice(0, ANSWER_MAX)}\n…` : text };
}

/** The most of an answer the panel shows. */
export const ANSWER_MAX = 20_000;
