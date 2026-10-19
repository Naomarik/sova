#!/usr/bin/env node
// chat-key-census.mjs: which past chats called Sova with the operator's key, and how. Reads a
// directory of session files (pi JSONL) and lists every tool call a chat's model made that reaches
// Sova's main listener with the install token: sova-project, scripts/sova.mjs, the `sova` launcher,
// an HTTP or socket request to a loopback Sova port, a read of the token file, and the link
// extension's tools (which present the token they were handed). S15 consumes the result: what
// chats really used is what a chat key must keep allowing.
//
//   node scripts/chat-key-census.mjs <sessions dir> [--json] [--port 4800]
//
// Read-only: it opens files for reading only and never follows a link out of the directory. It
// never prints a command line, a prompt, a header value, a token or a path: only what kind of call
// it was, and names Sova itself defines: a catalogue id, a project verb, a launcher word, or the
// route a URL reaches as the server registers it (server/commands-inventory/baseline.json, the
// route inventory; `<other>` / `<unmatched …>` for anything else), and how many calls and chats
// (session files) each had. A user's own `!` command and text
// that merely mentions a command are not tool calls and are not counted.

import { createReadStream, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../shared/commands-catalog.ts";
import { isVerb } from "../shared/project-contract.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

export const KINDS = ["sova-project", "sova.mjs", "sova launcher", "http live", "http other", "token read", "link tool"];

/** Every `*.jsonl` under `dir`, never leaving it (a symlink is skipped). */
export function sessionFiles(dir) {
  const root = realpathSync(resolve(dir));
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return { root, files: out };
}

/** The server's own sockets (upgrades are not Hono routes, so not in the inventory). */
const SOCKETS = ["/ws/chat", "/ws/watch", "/ws/events"];
/** The launcher's own words (scripts/install.sh). */
const LAUNCHER_WORDS = new Set(["token", "app", "open", "desktop"]);
const CLI_WORDS = new Set(["list", "describe", "run", "watch"]);
const COMMAND_IDS = new Set(COMMANDS.map((c) => c.id));
const DYNAMIC = /^\/(?:api|ext|peer|explain|design|ws)(?:\/|$)/;

/** The registered routes, most specific first: [{method, path, re}]. */
export function loadRoutes(file = join(REPO, "server/commands-inventory/baseline.json")) {
  const keys = Object.keys(JSON.parse(readFileSync(file, "utf8")).routes);
  const routes = keys.map((k) => {
    const [method, path] = k.split(" ");
    const re = new RegExp(`^${path.split("/").map((seg) => (seg === "*" ? ".*" : seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`);
    return { method, path, re, score: (path.match(/:|\*/g) ?? []).length * 100 - path.length };
  });
  for (const path of SOCKETS) routes.push({ method: "WS", path, re: new RegExp(`^${path}$`), score: -path.length });
  return routes.sort((x, y) => x.score - y.score);
}

/** What a URL's path reaches: `<METHOD> <registered pattern>`, the page's shell, or `<unmatched>`,
    never a segment of the URL itself (a project, a folder, a peer's name) nor its query. */
export function routeOf(method, rawPath, routes) {
  const path = (rawPath.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  if (method === "WS") {
    const hit = routes.find((r) => r.method === "WS" && r.re.test(path));
    return hit ? `WS ${hit.path}` : "WS <unmatched>";
  }
  if (!DYNAMIC.test(path)) return `${method} <page>`;
  const hit = routes.find((r) => r.method === method && r.re.test(path) && r.path !== "/*" && r.path !== "/api/*") ??
    routes.find((r) => r.method === "ALL" && r.re.test(path) && r.path !== "/*" && r.path !== "/api/*");
  if (hit) return `${method} ${hit.path}`;
  const family = /^\/api\/([a-z][a-z-]*)(?:\/|$)/.exec(path)?.[1];
  const known = family && routes.some((r) => r.path.startsWith(`/api/${family}/`) || r.path === `/api/${family}`);
  return `${method} <unmatched${known ? ` /api/${family}/…` : ""}>`;
}

// Where a shell starts a command: the start, after a separator or a subshell, or after a word that runs the next one.
const COMMAND_POS = String.raw`(?:^|[\n;&|(\`]|\$\(|\b(?:then|do|else|exec|xargs|time|timeout\s+\S+|env(?:\s+\w+=\S*)*|[A-Z_][A-Z0-9_]*=\S*)\s)\s*`;
// sova-project's verb is its first argument (scripts/sova-project.mjs): a flag first is no verb.
// A program named by path or bare, run directly or by node/bun.
const RUNNER = String.raw`(?:(?:node|bun|pnpm\s+exec)\s+)?(?:[\w.~$\{\}/-]*/)?`;
const SOVA_PROJECT = new RegExp(`${COMMAND_POS}${RUNNER}sova-project(?:\\.mjs)?(?:\\s+([a-z][\\w.-]*))?`, "g");
const SOVA_MJS = new RegExp(`${COMMAND_POS}${RUNNER}sova\\.mjs(?:\\s+([a-z]+))?(?:\\s+([a-z][\\w.-]*))?`, "g");
const LAUNCHER = new RegExp(`${COMMAND_POS}sova\\s+([a-z][\\w-]*)`, "g");
/** Something in the call that makes a request (a grep for an address is not one). */
const REQUESTER = /\b(?:curl|wget|xh|https?(?=\s)|websocat|fetch|WebSocket|request|urllib|requests|playwright|pw\.sh|goto|page\.|chromium|open)\b/;
const REQUESTING_TOOLS = new Set(["fetch_content", "get_search_content"]);

/** A shell line with the insides of its quoted strings blanked, so a quoted word is never a command. */
export function unquoted(command) {
  return command.replace(/'[^'\n]*'|"(?:[^"\\\n]|\\.)*"/g, (q) => q[0] + " ".repeat(Math.max(0, q.length - 2)) + q[0]);
}
const LOOPBACK_URL = /\b(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d{2,5}|\$\{?[A-Za-z_]\w*\}?)(\/(?:[^\s'"`\\)<>;&|]|&(?!&))*)?/g;
const BARE_LOOPBACK = /(?<![\w/:.])(?:127\.0\.0\.1|localhost):(\d{2,5}|\$\{?[A-Za-z_]\w*\}?)(\/(?:[^\s'"`\\)<>;&|]|&(?!&))*)?/g;
const TOKEN_READ = /auth-token\b|sova-token\.mjs|auth:token|\$\{?SOVA_TOKEN\b|(?:^|[\s;&|(`$])sova\s+token\b/;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** The method of the request whose URL is at `at`: a -X/--request/method: in the same command
    (from the requester before it to the next separator), else GET, or POST for a curl with a body. */
function methodNear(text, at) {
  const before = text.slice(0, at);
  const start = Math.max(before.lastIndexOf("\n"), before.search(/[^;&|\n]*$/));
  const rest = text.slice(at);
  const endRel = rest.search(/[\n;]|&&|\|\|/);
  const cmd = text.slice(start < 0 ? 0 : start, endRel < 0 ? text.length : at + endRel);
  const m = /(?:-X|--request)\s*['"]?([A-Za-z]+)/.exec(cmd) ?? /\bmethod\s*:\s*['"]([A-Za-z]+)/i.exec(cmd);
  if (m) return METHODS.has(m[1].toUpperCase()) ? m[1].toUpperCase() : "<other>";
  if (/\bcurl\b/.test(cmd) && /\s(?:-d|--data(?:-raw|-binary)?|--json)\b/.test(cmd)) return "POST";
  return "GET";
}

/** How a call touches the token: reading the file, the helper, the variable, the launcher, or only naming it. */
function tokenUse(command) {
  if (/sova-token\.mjs|auth:token/.test(command)) return "sova-token.mjs";
  if (/(?:^|[\s;&|(`$])sova\s+token\b/.test(command)) return "sova token";
  if (/(?:\bcat|\bhead|\btail|\bless|\$\(<|<)\s*['"]?[^\s;|&'"]*auth-token\b/.test(command) || /readFileSync\([^)]*auth-token/.test(command)) return "reads the file";
  if (/\$\{?SOVA_TOKEN\b/.test(command)) return "$SOVA_TOKEN";
  return "names auth-token";
}

let routesCache = null;
const defaultRoutes = () => (routesCache ??= loadRoutes());

/** The calls one tool call makes to Sova: [{kind, what}]. */
export function classify(name, args, opts = {}) {
  const livePort = String(opts.port ?? 4800);
  const found = [];
  if (typeof name !== "string") return found;
  if (name.startsWith("link_")) found.push({ kind: "link tool", what: name });
  const command = name === "bash" && args && typeof args.command === "string" ? args.command : null;
  const text = command ?? (args ? JSON.stringify(args) : "");
  if (command) {
    const bare = unquoted(command);
    const known = (set, w) => (w === undefined ? "(none)" : set.has(w) ? w : "<other>");
    for (const m of bare.matchAll(SOVA_PROJECT)) found.push({ kind: "sova-project", what: m[1] === undefined ? "(none)" : isVerb(m[1]) ? m[1] : "<other>" });
    for (const m of bare.matchAll(SOVA_MJS)) {
      const word = known(CLI_WORDS, m[1]);
      found.push({ kind: "sova.mjs", what: word === "run" || word === "describe" ? `${word} ${known(COMMAND_IDS, m[2])}` : word });
    }
    for (const m of bare.matchAll(LAUNCHER)) found.push({ kind: "sova launcher", what: known(LAUNCHER_WORDS, m[1]) });
    if (TOKEN_READ.test(command)) found.push({ kind: "token read", what: tokenUse(command) });
  }
  const requests = REQUESTING_TOOLS.has(name) || (command !== null && REQUESTER.test(command));
  if (name === "read" && args && typeof args.path === "string" && /(?:^|\/)sova\/auth-token$/.test(args.path)) found.push({ kind: "token read", what: "read tool" });
  const seen = new Set();
  for (const re of requests ? [LOOPBACK_URL, BARE_LOOPBACK] : []) {
    for (const m of text.matchAll(re)) {
      const port = m[1];
      if (!/^48\d\d$/.test(port) && !port.startsWith("$")) continue;
      const scheme = /^wss?:/.test(m[0]) ? "WS" : methodNear(text, m.index ?? 0);
      const route = routeOf(scheme, m[2] ?? "/", opts.routes ?? defaultRoutes());
      const key = `${port} ${route}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind: port === livePort ? "http live" : "http other", what: port === livePort ? route : `${route} (port ${port.startsWith("$") ? "$var" : port})` });
    }
  }
  return found;
}

/** Tally the census over `files`. */
export async function census(files, opts = {}) {
  const kinds = new Map(KINDS.map((k) => [k, { calls: 0, chats: new Set(), what: new Map() }]));
  let toolCalls = 0;
  const chatsWithAny = new Set();
  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"toolCall"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = entry?.type === "message" ? entry.message : null;
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const part of msg.content) {
        if (!part || part.type !== "toolCall") continue;
        toolCalls++;
        for (const { kind, what } of classify(part.name, part.arguments, opts)) {
          const k = kinds.get(kind);
          k.calls++;
          k.chats.add(file);
          chatsWithAny.add(file);
          const w = k.what.get(what) ?? { calls: 0, chats: new Set() };
          w.calls++;
          w.chats.add(file);
          k.what.set(what, w);
        }
      }
    }
  }
  return {
    files: files.length,
    toolCalls,
    chats: chatsWithAny.size,
    kinds: KINDS.map((kind) => {
      const k = kinds.get(kind);
      return {
        kind,
        calls: k.calls,
        chats: k.chats.size,
        what: [...k.what.entries()].map(([what, w]) => ({ what, calls: w.calls, chats: w.chats.size })).sort((a, b) => b.calls - a.calls || a.what.localeCompare(b.what)),
      };
    }),
  };
}

const cell = (s) => String(s).replace(/\|/g, "\\|");

/** The census as Markdown: counts only. */
export function toMarkdown(result) {
  const lines = [
    "# Chat key census",
    "",
    `${result.files} session files, ${result.toolCalls} tool calls; ${result.chats} chats called Sova with the operator's key.`,
    "",
    "| Kind | Calls | Chats |",
    "| --- | ---: | ---: |",
    ...result.kinds.map((k) => `| ${k.kind} | ${k.calls} | ${k.chats} |`),
  ];
  for (const k of result.kinds) {
    if (!k.what.length) continue;
    lines.push("", `## ${k.kind}`, "", "| Command or route | Calls | Chats |", "| --- | ---: | ---: |");
    for (const w of k.what) lines.push(`| \`${cell(w.what)}\` | ${w.calls} | ${w.chats} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(argv) {
  let dir;
  let json = false;
  let port = 4800;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--port" && argv[i + 1]) port = Number(argv[++i]);
    else if (!a.startsWith("-") && dir === undefined) dir = a;
    else {
      process.stderr.write(`chat-key-census: unexpected argument ${a}\n`);
      return 3;
    }
  }
  if (!dir) {
    process.stderr.write("usage: node scripts/chat-key-census.mjs <sessions dir> [--json] [--port 4800]\n");
    return 3;
  }
  const { files } = sessionFiles(dir);
  const result = await census(files, { port });
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : toMarkdown(result));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`chat-key-census: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

