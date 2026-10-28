// The commands inventory's pure parts (server/commands-inventory.test.ts, scripts/commands-inventory.mjs):
// which of the three things a route is (a catalogue entry, a declared not-a-command class, a row on the
// shrinking baseline), and three text scans over the source: the ChatClientMessage frame types, the
// document/window keydown listeners and the hand-written ToolSpecs, per file. No I/O but listFiles;
// erasable syntax only and `.ts` import extensions, because the script loads it through Node's type
// stripping. The fixtures in fixtures/ prove each scan's forms, hidden ones included.
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ---- routes --------------------------------------------------------------------------------------

/** A route as Hono registers it: `GET /api/sessions/:id`. */
export type RouteKey = string;

export const routeKey = (method: string, path: string): RouteKey => `${method} ${path}`;

/**
 * The declared not-a-command classes: doors the operator keeps closed, transport, test-only routes,
 * assets and middleware. A route matching one is never a command and never a baseline row. Order
 * matters only for the docs; a route matching two classes is a failure of its own.
 */
export interface RouteClass {
  id: string;
  label: string;
  why: string;
  matches: (method: string, path: string) => boolean;
}

export const ROUTE_CLASSES: readonly RouteClass[] = [
  {
    id: "peer",
    label: "Peer protocol",
    why: "Sova-to-Sova calls on the mesh and the relay to a peer's own routes; the peer listener's door, never the operator's actions.",
    matches: (_m, p) => /^\/api\/peer(?:\/|$)/.test(p) || /^\/peer\/:[^/]+\//.test(p),
  },
  {
    id: "auth",
    label: "Auth",
    why: "Pairing, unlocking and the token: how a browser gets in, not something done once inside.",
    matches: (_m, p) => /^\/api\/auth\//.test(p),
  },
  {
    id: "share-pages",
    label: "Share pages",
    why: "The public share listener's pages (`/h`, `/i`, `/s`): a visitor's view, never the operator's.",
    matches: (_m, p) => /^\/[his]\//.test(p),
  },
  {
    id: "ext-proxy",
    label: "Extension proxy",
    why: "`/ext/*`: an extension's own pages and API behind the proxy; its actions are `ext.<id>.*`.",
    matches: (_m, p) => /^\/ext(?:\/|$)/.test(p),
  },
  {
    id: "transport",
    label: "Transport and frames",
    why: "Sockets and the chat frame relay: how actions travel, not actions.",
    matches: (m, p) => /^\/ws(?:\/|$)/.test(p) || (m === "POST" && p === "/api/chat/frames"),
  },
  {
    id: "catalogue",
    label: "The catalogue itself",
    why: "`GET /api/commands`: the list of actions this server can run, as `sova list` reads it; how a script learns the actions, not one of them. Exactly that method and path: anything else under it is classed on its own.",
    matches: (m, p) => m === "GET" && p === "/api/commands",
  },
  {
    id: "test-only",
    label: "Test only",
    why: "`/api/test`: registered only when a test asks for it (SOVA_CHAT_TEST_SERVED=1).",
    matches: (_m, p) => /^\/api\/test(?:\/|$)/.test(p),
  },
  {
    id: "assets",
    label: "Pages and assets",
    why: "The app shell, design CSS and explanation pages: what the browser loads to draw.",
    matches: (m, p) => (m === "GET" && p === "/*") || /^\/design\//.test(p) || /^\/explain(?:\/|$)/.test(p),
  },
  {
    id: "trust-grants",
    label: "Trust grants",
    why: "Approving what a project's files may make Sova do (an offers file's run buttons, §chat.offers/approval; a project's transcript cards, §chat.transcript-cards/trust), applying a settings card with its approvals (§app.project-overseer/settings) and setting this machine's copy limit, whose raise is a grant (§app.project-services/services-ui; an agent proposes it through sova_settings): the operator's own grant of trust, never an action a script or an agent runs.",
    matches: (m, p) => (m === "POST" && (p === "/api/projects/:pid/offers/approve" || p === "/api/projects/:pid/settings/apply" || p === "/api/session-cards/trust")) || (m === "PUT" && p === "/api/projects/:pid/services/limit"),
  },
  {
    id: "card-box",
    label: "A card view's own calls",
    why: "What a transcript card's sealed view asks through its box, for its own card only (§chat.transcript-cards/view-api): its built code, the state Sova keeps for it, and a catalogue command run as the card (which records the command itself). The box's plumbing, from the page: never an action of its own.",
    matches: (m, p) => (m === "GET" && p === "/api/session-cards/view") || (m === "POST" && (p === "/api/session-cards/state" || p === "/api/session-cards/run")),
  },
  {
    id: "middleware",
    label: "Middleware and fallbacks",
    why: "`app.use` gates and the `/api` not-found answer: they run around routes, they are not routes.",
    matches: (m, p) => m === "ALL" && (p === "/*" || p === "/api/*"),
  },
];

/** A regex over concrete paths for a Hono pattern (`:name` is one segment, `*` the rest). */
export function patternRe(path: string): RegExp {
  const body = path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

const paramCount = (path: string) => (path.match(/:[^/]+|\*/g) ?? []).length;

export interface EntryRoute {
  id: string;
  route: { method: string; path: string };
}

/**
 * The registered route an entry's request lands on: the one registered at exactly its path, or else
 * the one pattern matching it with the fewest params (Hono's static-first order). `null` when none,
 * or when two tie (the inventory can't say which; a failure).
 */
export function routeOfEntry(entry: EntryRoute, routes: readonly { method: string; path: string }[]): RouteKey | null {
  const same = routes.filter((r) => r.method === entry.route.method);
  if (same.some((r) => r.path === entry.route.path)) return routeKey(entry.route.method, entry.route.path);
  const concrete = entry.route.path.replace(/:[^/]+/g, "x");
  const hits = same.filter((r) => !r.path.includes("*") && patternRe(r.path).test(concrete));
  if (!hits.length) return null;
  const least = Math.min(...hits.map((r) => paramCount(r.path)));
  const best = hits.filter((r) => paramCount(r.path) === least);
  return best.length === 1 ? routeKey(best[0]!.method, best[0]!.path) : null;
}

/** One route's row in the inventory. */
export interface RouteRow {
  /** `classifyRequest(method, path).need` with `:name` and `*` filled: pinned, so no change widens mesh reach quietly. */
  need: string;
  /** `command`, a class id, or `pending` (a row on the baseline that only shrinks). */
  is: string;
  /** The catalogue ids pointing at it, when `is` is `command`. */
  ids?: string[];
}

export const concretePath = (path: string) => path.replace(/:[^/]+/g, "x").replace(/\*/g, "x");

/**
 * Every registered route (method + path, deduplicated) and what it is. Problems are returned, not
 * thrown: a route in two classes, a class route a catalogue entry points at, an entry landing on no
 * route.
 */
export function inventoryRoutes(
  routes: readonly { method: string; path: string }[],
  entries: readonly EntryRoute[],
  needOf: (method: string, path: string) => string,
): { rows: Record<RouteKey, RouteRow>; problems: string[] } {
  const problems: string[] = [];
  const ids = new Map<RouteKey, string[]>();
  for (const e of entries) {
    const k = routeOfEntry(e, routes);
    if (!k) problems.push(`${e.id}: ${e.route.method} ${e.route.path} lands on no single registered route`);
    else ids.set(k, [...(ids.get(k) ?? []), e.id]);
  }
  const rows: Record<RouteKey, RouteRow> = {};
  const keys = [...new Set(routes.map((r) => routeKey(r.method, r.path)))].sort();
  for (const k of keys) {
    const sp = k.indexOf(" ");
    const method = k.slice(0, sp);
    const path = k.slice(sp + 1);
    const classes = ROUTE_CLASSES.filter((c) => c.matches(method, path)).map((c) => c.id);
    if (classes.length > 1) problems.push(`${k} is in two classes: ${classes.join(", ")}`);
    const cmd = ids.get(k);
    if (cmd && classes.length) problems.push(`${k} is class ${classes[0]} but catalogue entries point at it: ${cmd.join(", ")}`);
    const need = needOf(method === "ALL" ? "GET" : method, concretePath(path));
    rows[k] = cmd ? { need, is: "command", ids: [...cmd].sort() } : { need, is: classes[0] ?? "pending" };
  }
  return { rows, problems };
}

// ---- source masking --------------------------------------------------------------------------------

/**
 * The text with comments blanked, and, when `strings` is set, the insides of string, template and
 * regex literals blanked too (delimiters kept, newlines kept, so offsets and line numbers hold).
 * Template `${…}` parts are blanked with their template: nothing the scans look for lives there.
 */
export function mask(text: string, strings: boolean): string {
  const out = text.split("");
  const blank = (i: number) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  let lastSig = ""; // the last non-space code character, to tell a regex from a division
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && d === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\") {
          if (strings) blank(i);
          i++;
        }
        if (strings) blank(i);
        i++;
      }
      i++;
      lastSig = c;
      continue;
    }
    if (c === "`") {
      i++;
      let depth = 0;
      while (i < n) {
        const t = text[i]!;
        if (t === "\\") {
          if (strings) blank(i), blank(i + 1);
          i += 2;
          continue;
        }
        if (depth === 0 && t === "`") break;
        if (t === "$" && text[i + 1] === "{") depth++;
        else if (t === "}" && depth > 0) depth--;
        if (strings) blank(i);
        i++;
      }
      i++;
      lastSig = "`";
      continue;
    }
    if (c === "/" && (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /\b(?:return|typeof|case|in|of)$/.test(text.slice(Math.max(0, i - 8), i).trimEnd()))) {
      // a regex literal
      i++;
      let cls = false;
      while (i < n && text[i] !== "\n") {
        const t = text[i]!;
        if (t === "\\") {
          if (strings) blank(i), blank(i + 1);
          i += 2;
          continue;
        }
        if (t === "[") cls = true;
        else if (t === "]") cls = false;
        else if (t === "/" && !cls) break;
        if (strings) blank(i);
        i++;
      }
      i++;
      lastSig = "/x";
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join("");
}

/** The index of the bracket closing the one at `open` in masked text, or -1. */
function closing(masked: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]", "<": ">" };
  const want = pairs[masked[open]!];
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === masked[open]) depth++;
    else if (c === want && --depth === 0) return i;
  }
  return -1;
}

/** Splits masked[from, to) at top-level `sep` characters (depth 0 in (), [], {}); offsets into the text. */
function splitTop(masked: string, from: number, to: number, sepChar: string, angles = false): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i]!;
    if (c === "=" && masked[i + 1] === ">") i++;
    else if (c === "{" || c === "(" || c === "[" || (angles && c === "<")) depth++;
    else if (c === "}" || c === ")" || c === "]" || (angles && c === ">")) depth--;
    else if (depth === 0 && c === sepChar) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, to]);
  return parts;
}

const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

/** A string literal's value at the start of `s` (after spaces), or null when it isn't one. */
function literalAt(s: string): string | null {
  const m = /^\s*(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`)/.exec(s);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

// ---- scan 1: ChatClientMessage frame types --------------------------------------------------------

/**
 * The `type` literals of `export type ChatClientMessage = …`, in source order. A member that is not an
 * inline object with a literal `type` (a named type, an Extract, a computed type) comes back in
 * `unresolved`, so a frame type can't hide behind an alias.
 */
export function chatClientTypes(text: string): { types: string[]; unresolved: string[] } | null {
  const masked = mask(text, true);
  const decl = /\bexport\s+type\s+ChatClientMessage\s*=/.exec(masked);
  if (!decl) return null;
  const start = decl.index + decl[0].length;
  let end = start;
  let depth = 0;
  for (; end < masked.length; end++) {
    const c = masked[end]!;
    if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
    else if (c === "}" || c === ")" || c === "]" || (c === ">" && masked[end - 1] !== "=")) depth--;
    else if (depth === 0 && c === ";") break;
  }
  const types: string[] = [];
  const unresolved: string[] = [];
  for (const [a, b] of splitTop(masked, start, end, "|", true)) {
    const seg = masked.slice(a, b).trim();
    if (!seg) continue;
    const lead = a + masked.slice(a, b).indexOf(seg[0]!);
    if (masked[lead] !== "{") {
      unresolved.push(text.slice(a, b).trim().replace(/\s+/g, " "));
      continue;
    }
    const close = closing(masked, lead);
    let found: string | null = null;
    for (const [pa, pb] of splitTop(masked, lead + 1, close, ";").flatMap(([x, y]) => splitTop(masked, x, y, ","))) {
      const key = /^\s*(?:readonly\s+)?["']?type["']?\s*:/.exec(masked.slice(pa, pb));
      if (key) found = literalAt(text.slice(pa + key[0].length, pb));
    }
    if (found === null || masked.slice(close + 1, b).trim()) unresolved.push(text.slice(a, b).trim().replace(/\s+/g, " "));
    else types.push(found);
  }
  return { types, unresolved };
}

// ---- scan 2: document/window keydown listeners ------------------------------------------------------

export interface Listener {
  /** `window`, `document`, `document.body`, `globalThis`, `global` (a bare call: the window), or `<target>.onkeydown`. */
  target: string;
  line: number;
}

/** Every keydown listener on the document or the window in one file (comments ignored, strings read). */
export function keydownListeners(text: string): Listener[] {
  if (!text.includes("keydown")) return [];
  const code = mask(text, false);
  const out: Listener[] = [];
  const target = String.raw`(document(?:\s*\??\.\s*(?:body|documentElement))?|window|globalThis|self)`;
  const ev = String.raw`\(\s*(["'\`])keydown\2`;
  for (const m of code.matchAll(new RegExp(String.raw`(?<!\.\s*)\b${target}\s*\??\.\s*addEventListener\s*${ev}`, "g")))
    out.push({ target: m[1]!.replace(/\s|\?/g, ""), line: lineOf(text, m.index) });
  // A bare call is the window's (a browser module's global scope); never one on an object.
  for (const m of code.matchAll(/(?<!\??\.\s*)(?<![\w$])addEventListener\s*\(\s*(["'`])keydown\1/g)) out.push({ target: "global", line: lineOf(text, m.index) });
  for (const m of code.matchAll(new RegExp(String.raw`(?<!\.\s*)\b${target}\s*\??\.\s*onkeydown\s*=(?!=)`, "g")))
    out.push({ target: `${m[1]!.replace(/\s|\?/g, "")}.onkeydown`, line: lineOf(text, m.index) });
  const seen = new Set<string>();
  return out
    .filter((l) => {
      const k = `${l.target}:${l.line}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => a.line - b.line || a.target.localeCompare(b.target));
}

// ---- scan 3: hand-written ToolSpecs -----------------------------------------------------------------

/** The top-level keys of the object literal whose braces are at masked[open] and masked[close]. */
function objectKeys(masked: string, open: number, close: number): { keys: Map<string, number>; spreads: number } {
  const keys = new Map<string, number>();
  let spreads = 0;
  for (const [a, b] of splitTop(masked, open + 1, close, ",")) {
    const seg = masked.slice(a, b);
    if (/^\s*\.\.\./.test(seg)) {
      spreads++;
      continue;
    }
    const m = /^\s*(?:async\s+)?(?:get\s+|set\s+)?["']?([A-Za-z_$][\w$]*)["']?\s*(:|\(|$)/.exec(seg);
    if (m) keys.set(m[1]!, a + seg.indexOf(m[1]!) + m[1]!.length);
  }
  return { keys, spreads };
}

export interface ToolFound {
  /** The literal name, or `<computed: …>` when it isn't a literal. */
  name: string;
  line: number;
}

/**
 * Every object literal in one file shaped as a ToolSpec: a `name` key beside `parameters` and
 * `label` or `description`, beside both `label` and `description` (a factory's options), or, with a
 * spread filling the rest in, beside `execute`. A name held in a string constant of the same file is
 * that constant's value; any other non-literal name is `<computed: …>`.
 */
export function toolSpecs(text: string): ToolFound[] {
  // Every shape below needs a `name` key and a `label`, `description` or `execute` one.
  if (!text.includes("name") || !/\b(?:label|description|execute)\b/.test(text)) return [];
  const masked = mask(text, true);
  const out: ToolFound[] = [];
  // Every brace pair, in one pass.
  const pairs: [number, number][] = [];
  const stack: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === "{") stack.push(i);
    else if (masked[i] === "}" && stack.length) pairs.push([stack.pop()!, i]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [i, close] of pairs) {
    if (!/\bname\b/.test(masked.slice(i, close))) continue;
    const { keys, spreads } = objectKeys(masked, i, close);
    const nameAt = keys.get("name");
    if (nameAt === undefined) continue;
    const shaped =
      (keys.has("parameters") && (keys.has("label") || keys.has("description"))) ||
      // a factory's options (projectVerbsTool({ name, label, description, … })) or a spread base
      (keys.has("label") && keys.has("description")) ||
      (spreads > 0 && keys.has("execute"));
    if (!shaped) continue;
    const rest = text.slice(nameAt, close);
    const colon = /^\s*:/.exec(rest);
    let name: string;
    if (!colon) name = "<computed: shorthand name>";
    else {
      const lit = literalAt(rest.slice(colon[0].length));
      if (lit !== null && !/^\s*(["'`])[^"'`]*\1\s*[+?]/.test(rest.slice(colon[0].length))) name = lit;
      else {
        const [a, b] = splitTop(masked, nameAt + colon[0].length, close, ",")[0]!;
        const expr = text.slice(a, b).trim().replace(/\s+/g, " ");
        // A constant of this file: `const INSPECT_TOOL = "baton_inspect"` is that name.
        const konst = /^[A-Za-z_$][\w$]*$/.test(expr) ? new RegExp(String.raw`\bconst\s+${expr.replace(/\$/g, "\\$")}\s*(?::\s*[\w$]+\s*)?=\s*(["'\`])([^"'\`$\\]*)\1\s*(?:as\s+const\s*)?;`).exec(text) : null;
        name = konst ? konst[2]! : `<computed: ${expr}>`;
      }
    }
    out.push({ name, line: lineOf(text, nameAt) });
  }
  return out;
}

// ---- files -----------------------------------------------------------------------------------------

/** Repo-relative files under `dirs` (posix separators) matching `keep`, sorted. */
export function listFiles(root: string, dirs: readonly string[], keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = relative(root, full).split(sep).join("/");
        if (keep(rel)) out.push(rel);
      }
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort();
}

/** Source files the listener scan reads: the page's code, never tests. */
export const isPageSource = (rel: string) => /\.(?:ts|tsx)$/.test(rel) && !/\.test\.tsx?$/.test(rel) && !rel.includes("/fixtures/");

/** Source files the ToolSpec scan reads: server and shared code, never tests, fixtures or test helpers. */
export const isToolSource = (rel: string) =>
  rel.endsWith(".ts") && !rel.endsWith(".test.ts") && !rel.includes("/fixtures/") && !rel.startsWith("server/harness/pi/golden/") && !rel.startsWith("server/testing/");

// ---- the baseline ------------------------------------------------------------------------------------

export interface Inventory {
  /** Every registered route on the main listener's app and what it is. */
  routes: Record<RouteKey, RouteRow>;
  /** The ChatClientMessage `type` literals, in source order. */
  frames: string[];
  /** Per page-source file, its document/window keydown listeners' targets, in source order. */
  keydown: Record<string, string[]>;
  /** Per server/shared file, its hand-written ToolSpec names, in source order. */
  tools: Record<string, string[]>;
}

/** The differences between the committed inventory and the computed one, one sentence each. */
export function compareInventory(base: Inventory, now: Inventory): string[] {
  const out: string[] = [];
  for (const [k, row] of Object.entries(now.routes)) {
    const was = base.routes[k];
    if (!was) out.push(`route ${k} is new (${row.is}${row.ids ? `: ${row.ids.join(", ")}` : ""}, need ${row.need})${row.is === "pending" ? ": give it a catalogue entry; the pending list never grows" : ""}`);
    else {
      if (was.need !== row.need) out.push(`route ${k}: mesh need ${was.need} → ${row.need} (classifyRequest changed what it takes to reach it)`);
      if (was.is !== row.is) out.push(`route ${k}: ${was.is} → ${row.is}${was.is === "pending" ? ": drop its pending row (the baseline shrinks)" : ""}`);
      else if ((was.ids ?? []).join() !== (row.ids ?? []).join()) out.push(`route ${k}: entries ${(was.ids ?? []).join(", ")} → ${(row.ids ?? []).join(", ")}`);
    }
  }
  for (const [k, row] of Object.entries(base.routes)) if (!now.routes[k]) out.push(`route ${k} (${row.is}) is no longer registered: drop its row`);
  if (base.frames.join() !== now.frames.join()) out.push(`ChatClientMessage types: [${base.frames.join(", ")}] → [${now.frames.join(", ")}]`);
  for (const key of ["keydown", "tools"] as const) {
    const files = new Set([...Object.keys(base[key]), ...Object.keys(now[key])]);
    for (const f of [...files].sort()) {
      const a = (base[key][f] ?? []).join(", ");
      const b = (now[key][f] ?? []).join(", ");
      if (a !== b) out.push(`${key} ${f}: [${a}] → [${b}]`);
    }
  }
  return out;
}

/** Pending rows in `now` that `before` didn't have pending: the growth the HEAD guard refuses. */
export function pendingGrowth(before: Inventory, now: Inventory): string[] {
  return Object.entries(now.routes)
    .filter(([k, r]) => r.is === "pending" && before.routes[k]?.is !== "pending")
    .map(([k]) => k);
}

/** The baseline file's text: one route, file or list per line, so a diff names what moved. */
export function formatInventory(inv: Inventory): string {
  const obj = (o: Record<string, unknown>, indent: string) => {
    const keys = Object.keys(o).sort();
    return keys.length ? `{\n${keys.map((k) => `${indent}  ${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(",\n")}\n${indent}}` : "{}";
  };
  return `{\n  "routes": ${obj(inv.routes, "  ")},\n  "frames": ${JSON.stringify(inv.frames)},\n  "keydown": ${obj(inv.keydown, "  ")},\n  "tools": ${obj(inv.tools, "  ")}\n}\n`;
}
