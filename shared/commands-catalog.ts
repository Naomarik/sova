/**
 * The command catalogue (§app.commands/catalogue): Sova's user-visible actions as plain data, each
 * entry pointing at the route that already does it. Pure: no imports beyond the project contract's
 * verb lists, no fs, no fetch, so the command line (scripts/sova.mjs, through Node's type
 * stripping: erasable syntax only), the tests and a later server route read it alike.
 *
 * An entry never re-implements its action: running it is exactly the HTTP request its route takes,
 * and every answer and refusal is the route's own. Rules for adding one: agents/server/commands/overview.md.
 */
import type { CommandEntry, CommandParam, CommandRoute } from "./commands/types.ts";
import { SESSION_ENTRIES } from "./commands/sessions.ts";
import { PROJECT_ENTRIES, VERB_ENTRIES } from "./commands/projects.ts";
import { OVERSEER_ENTRIES } from "./commands/overseer.ts";
import { OTHER_ENTRIES } from "./commands/other.ts";

export type { CommandEffect, CommandEntry, CommandParam, CommandRoute, MeshNeed, ParamIn, ParamType } from "./commands/types.ts";

/** Every core entry, in a stable order. Ids are append-only (shared/commands-ids.json). */
export const COMMANDS: readonly CommandEntry[] = [
  ...SESSION_ENTRIES,
  ...VERB_ENTRIES,
  ...PROJECT_ENTRIES,
  ...OVERSEER_ENTRIES,
  ...OTHER_ENTRIES,
];

export const findCommand = (id: string): CommandEntry | undefined => COMMANDS.find((c) => c.id === id);

/** The wire name of a param. */
export const wireKey = (name: string, p: CommandParam): string => p.key ?? name;

export interface BuiltRequest {
  method: CommandRoute["method"];
  /** The route's path with its `:name` segments filled in, plus the query string. */
  url: string;
  /** The JSON body, for every method but GET and DELETE. */
  body?: Record<string, unknown>;
}

/** A path value that is a dot segment, in any spelling a URL parser resolves (`.`, `..`, `%2e`, `.%2E`). */
export const isDotSegment = (v: string): boolean => /^(?:\.|%2e){1,2}$/i.test(v);

/**
 * The HTTP request an entry makes for `values`, which are already typed (a list is an array, a
 * session already the path or id its route takes). Throws on a missing required param, a path
 * param that is missing, or a path value that is a dot segment (it would resolve out of the
 * route); it checks nothing else: the route is the authority.
 */
export function buildRequest(entry: CommandEntry, values: Readonly<Record<string, unknown>>): BuiltRequest {
  let path = entry.route.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(entry.params)) {
    const v = values[name] !== undefined ? values[name] : p.default;
    if (v === undefined) {
      if (p.required) throw new Error(`--${name} is required`);
      continue;
    }
    const key = wireKey(name, p);
    if (p.in === "path") {
      // `.` and `..` survive encodeURIComponent, and URL parsing would resolve them out of the route.
      if (isDotSegment(String(v))) throw new Error(`--${name} can't be "." or ".."`);
      path = path.replace(`:${key}`, encodeURIComponent(String(v)));
    }
    else if (p.in === "query") query.set(key, Array.isArray(v) ? v.join(",") : String(v));
    else body[key] = v;
  }
  if (/\/:[^/]+/.test(path)) throw new Error(`${entry.id}: a path param is missing`);
  const qs = query.toString();
  const url = qs ? `${path}?${qs}` : path;
  if (entry.route.method === "GET" || entry.route.method === "DELETE") return { method: entry.route.method, url };
  return { method: entry.route.method, url, body: { ...body, ...(entry.route.fixed ?? {}) } };
}
