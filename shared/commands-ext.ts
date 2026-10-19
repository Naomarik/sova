/**
 * Extensions' own actions (§app.commands/extension-commands): the optional `commands` key of an
 * extensions.json entry, read by the command line itself from the file, and by the server for what
 * GET /api/extensions says each extension offers (shared/extension-offers.ts): one rule for both.
 * Pure and import-free but for types (the command line loads it through Node's type stripping:
 * erasable syntax only).
 *
 * Every id is `ext.<extension id>.<name>`, so an extension can never name, replace or shadow a core
 * entry (core ids never start with `ext.`; shared/commands-catalog.test.ts). Running one is a POST to
 * the extension's own backend through Sova's existing proxy, which strips Sova's token.
 */
import type { CommandEntry, CommandParam, ParamType } from "./commands-catalog.ts";

/** The server's own id rule (server/extensions.ts EXTENSION_ID_RE); the server still decides
    whether an entry is installed: an id it dropped answers 404 through the proxy. */
const EXT_ID_RE = /^[A-Za-z0-9._-]+$/;
export const EXT_COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PARAM_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** The command line's own options: a param may not take one of these names. */
const RESERVED_PARAMS = new Set(["url", "json", "session", "events", "help"]);
export const LABEL_MAX = 48;
export const SUMMARY_MAX = 200;
/** Declared commands past this many are never read. */
export const COMMANDS_MAX = 32;
const PARAMS_MAX = 16;

const TYPES: Record<string, ParamType> = { string: "string", number: "number", integer: "integer", boolean: "boolean", array: "list", object: "json" };

export interface ExtCommandEntry extends CommandEntry {
  /** The extension's id, as installed. */
  extension: string;
}

const plain = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

/** One declared command → an entry, or null when it isn't valid (it is left out alone). */
export function extCommand(extId: string, raw: unknown): ExtCommandEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !EXT_COMMAND_NAME_RE.test(r.name)) return null;
  if (!plain(r.label, LABEL_MAX)) return null;
  if (r.summary !== undefined && !plain(r.summary, SUMMARY_MAX)) return null;
  const params: Record<string, CommandParam> = {};
  if (r.params !== undefined) {
    if (typeof r.params !== "object" || r.params === null || Array.isArray(r.params)) return null;
    const entries = Object.entries(r.params as Record<string, unknown>);
    if (entries.length > PARAMS_MAX) return null;
    for (const [name, def] of entries) {
      if (!PARAM_NAME_RE.test(name) || RESERVED_PARAMS.has(name)) return null;
      if (typeof def !== "object" || def === null || Array.isArray(def)) return null;
      const d = def as Record<string, unknown>;
      const type = typeof d.type === "string" ? TYPES[d.type] : undefined;
      if (!type) return null;
      if (d.description !== undefined && !plain(d.description, SUMMARY_MAX)) return null;
      if (d.required !== undefined && typeof d.required !== "boolean") return null;
      params[name] = { type, description: typeof d.description === "string" ? d.description : "", in: "body", ...(d.required === true ? { required: true } : {}) };
    }
  }
  return {
    id: `ext.${extId}.${r.name}`,
    extension: extId,
    label: (r.label as string).trim(),
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    effect: "changes",
    params,
    route: { method: "POST", path: `/ext/${extId}/api/commands/${r.name}` },
    sessionKey: null,
    sessionFile: "never",
    meshNeed: "full",
  };
}

/** Every valid extension command in an extensions.json document, in manifest order. An entry
    with a bad id, a second entry with a taken id, a bad command and a second command with a taken
    name are each left out alone. Anything that isn't `{version: 1, extensions: [...]}` is none. */
export function extCommandsOf(doc: unknown): ExtCommandEntry[] {
  const d = doc as { version?: unknown; extensions?: unknown } | null;
  if (!d || typeof d !== "object" || d.version !== 1 || !Array.isArray(d.extensions)) return [];
  const out: ExtCommandEntry[] = [];
  const ids = new Set<string>();
  for (const raw of d.extensions) {
    const e = raw as { id?: unknown; commands?: unknown } | null;
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !EXT_ID_RE.test(e.id) || e.id === "." || e.id === "..") continue;
    if (ids.has(e.id)) continue;
    ids.add(e.id);
    out.push(...extCommandsFrom(e.id, e.commands));
  }
  return out;
}

/** One entry's `commands` value → its valid commands, in order: the first COMMANDS_MAX read, a bad
    one and a second one with a taken name left out alone. Anything but an array is none. */
export function extCommandsFrom(extId: string, commands: unknown): ExtCommandEntry[] {
  if (!Array.isArray(commands)) return [];
  const out: ExtCommandEntry[] = [];
  const names = new Set<string>();
  for (const c of commands.slice(0, COMMANDS_MAX)) {
    const entry = extCommand(extId, c);
    if (!entry) continue;
    const name = entry.id.slice(`ext.${extId}.`.length);
    if (names.has(name)) continue;
    names.add(name);
    out.push(entry);
  }
  return out;
}
