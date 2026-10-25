#!/usr/bin/env node
// sova.mjs: Sova's command catalogue from a terminal or a script (§app/commands). A thin client of
// the routes the catalogue names (shared/commands-catalog.ts): it never re-implements an action, it
// makes the request the web app makes, as the operator, and prints the route's own JSON answer.
// Node builtins, the catalogue, and the exit classes of shared/project-contract.ts (Node strips
// their types). Not the installed launcher named `sova`: run it as `node scripts/sova.mjs`.
//
//   node scripts/sova.mjs list [--json]            every entry, extensions' own (`ext.*`) included
//   node scripts/sova.mjs describe <id>            one entry, as JSON
//   node scripts/sova.mjs run <id> [--<param> <value>]… [--session <id|path>] [--json '<object>' | --json -] [--host <peer>]
//   node scripts/sova.mjs watch [--events created,renamed,…] [--since <stream>:<seq>]   read-only NDJSON
//   every command also takes --url <http://127.0.0.1:4800>
//
// list and describe print the running server's own list (GET /api/commands, §app.served-commands/list)
// and fall back to this checkout's copy (the catalogue file and the extensions manifest) when it has
// none; with $SOVA_EXTENSIONS_FILE set, the caller named the manifest, so they read the copy and ask
// nothing. run finds its entry in the copy. watch reads Sova's event stream (/ws/events,
// §app.served-commands/watch: each line gains `source` and `cursor`, and --since resumes from a
// cursor) and falls back to the session feed and the list diff (§app.commands/watch) when the server
// has no stream.
//
// The server is --url, else $SOVA_URL, else http://127.0.0.1:$SOVA_PORT (default 4800), and only
// on this machine (127.0.0.1, localhost, ::1): any other host is refused before a request. Its token
// is $SOVA_TOKEN, else the one in $PI_CODING_AGENT_DIR (default ~/.pi/agent) (scripts/sova-token.mjs).
// Exit classes, as sova-project's: 0 done, 1 failed, 2 refused, 3 invalid, 4 busy; and 5 outcome
// unknown, for an in-chat action (`chat.*`, POST /api/chat/action, §app.chat-actions/never-replay)
// only: the action was handed to the chat but its outcome is unknown; it was not and will not be
// retried. It is a 202 `{outcome:"unknown"}` answer, or a connection that opened and then broke
// before any answer (a server restart mid-wait). A connection that never opened is exit 1: nothing
// was delivered; so is a 503 `{outcome:"not-sent"}`, a chat that went away or never opened before
// the action reached it. Nothing here ever retries a request.
//
// Every request carries the token, and in a chat Sova runs the chat's own key too (x-sova-caller,
// from $SOVA_CALLER_KEY): the key only says which chat called. run names its command on the
// entry's request (`x-sova-command: <id>`, not on a --session look-up), so Sova's record of who
// ran what has one row naming it per run (§app.command-audit/record, `sova run audit.list`).
//
// run --host <peer> (or `sova --host <peer> run <id>`) runs the command on a mesh peer
// (§mesh.peers/remote-commands): through this machine's own /peer/<peer>/ proxy to the peer's
// POST /api/commands/<id>, which runs the peer's own entry with what the peer grants this host.
// --session is looked up on the peer; a path param must be absolute. A 404 says which: no such
// command there, no such peer here, or a peer without the door (an older Sova).
//
// It behaves the same in a chat and outside one. In a chat, an entry that only looks takes the
// chat's own session (SOVA_CHAT_ID) when --session is left out; one that changes something always
// needs --session named.

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRequest, COMMANDS, wireKey } from "../shared/commands-catalog.ts";
import { extCommandsOf } from "../shared/commands-ext.ts";
import { diffSessions, fromStreamFrame, indexSessions, parseCursor, STREAM_WATCH_EVENTS } from "../shared/commands-watch.ts";
import { EVENTS_PATH } from "../shared/events.ts";
import { ERROR_CODES, exitOf } from "../shared/project-contract.ts";
import { tokenFile, tokenHeaders } from "./sova-token.mjs";

/** The header a run names its command in (server/command-audit.ts): attribution only. */
export const COMMAND_HEADER = "x-sova-command";

export const EXIT = { done: 0, failed: 1, refused: 2, invalid: 3, busy: 4, unknown: 5 };

/** The route of the in-chat actions, the only one whose answers can be exit 5. */
export const CHAT_ACTION_ROUTE = "/api/chat/action";

/** A mesh peer's id, as peers.json has it (server/mesh/peers.ts PEER_ID_RE). */
export const HOST_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** What a remote run's 404 means: the peer's door's own "no command" (server/commands-routes.ts
    NO_COMMAND), this host's proxy's unknown peer, or else a peer with no such door (an older Sova). */
export function remoteNotFound(host, json) {
  const error = json && typeof json.error === "string" ? json.error : "";
  if (error.startsWith("no command")) return error;
  if (error === "Unknown peer") return `no peer ${host} in this host's mesh (Settings → Mesh)`;
  return `${host} doesn't run remote commands (an older Sova?)`;
}
/** What exit 5 says, on stderr. */
export const UNKNOWN_LINE = "the action was handed to the chat but its outcome is unknown: Sova may have acted. Check the chat before you run it again; it was not and will not be retried.";

/** A usage or input mistake, a refusal, a failure: the message and its exit class. */
export class CliError extends Error {
  /** `usage`: a mistake in the arguments themselves, answered with the usage line too. */
  constructor(message, code, usage = false) {
    super(message);
    this.code = code;
    this.usage = usage;
  }
}
const invalid = (m) => new CliError(m, EXIT.invalid, true);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The server's base URL, only when it is on this machine. */
export function serverBase(flag, env = process.env) {
  const raw = flag ?? env.SOVA_URL ?? `http://127.0.0.1:${env.SOVA_PORT ?? 4800}`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw invalid(`--url is not a URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw invalid(`--url must be http(s): ${raw}`);
  if (!LOOPBACK.has(u.hostname)) throw new CliError(`refused: ${u.hostname} is not this machine (only 127.0.0.1, localhost or ::1)`, EXIT.refused);
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

/** The extensions file the server reads: SOVA_EXTENSIONS_FILE, else <agent dir>/sova/extensions.json
    (the agent dir resolved exactly as the token's is). */
export const extensionsFile = (env = process.env) => env.SOVA_EXTENSIONS_FILE || join(dirname(tokenFile()), "extensions.json");

/** Core entries, then each extension's own, read from its manifest now. A missing or bad file is none. */
export function allEntries(env = process.env) {
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(extensionsFile(env), "utf8"));
  } catch {
    doc = null;
  }
  return [...COMMANDS, ...extCommandsOf(doc)];
}

/** `list`'s text: one line per entry, id, effect and label. */
export function listLines(entries) {
  const w = Math.max(...entries.map((e) => e.id.length));
  return entries.map((e) => `${e.id.padEnd(w)}  ${e.effect.padEnd(7)}  ${e.label}`);
}

/** The exit class of a route's answer: a project result by its own code, else by HTTP status. */
export function exitForAnswer(status, json) {
  const code = json && typeof json === "object" && json.error && typeof json.error === "object" ? json.error.code : undefined;
  if (ERROR_CODES.includes(code)) return exitOf(json);
  if (status >= 200 && status < 300) return EXIT.done;
  if (status === 401 || status === 403 || status === 409) return EXIT.refused;
  if (status === 423 || status === 429) return EXIT.busy;
  if (status >= 400 && status < 500) return EXIT.invalid;
  return EXIT.failed;
}

/** One command-line value as its param's type. */
export function coerce(name, p, raw, cwd = process.cwd()) {
  if (p.nullable && raw === "null") return null;
  switch (p.type) {
    case "number":
    case "integer": {
      const n = Number(raw);
      if (raw === "" || !Number.isFinite(n) || (p.type === "integer" && !Number.isInteger(n))) throw invalid(`--${name} must be ${p.type === "integer" ? "a whole number" : "a number"}`);
      return n;
    }
    case "boolean":
      if (raw === true || raw === "true") return true;
      if (raw === "false") return false;
      throw invalid(`--${name} is true or false`);
    case "list":
      return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw invalid(`--${name} must be JSON`);
      }
    case "path":
      return resolve(cwd, String(raw));
    default:
      if (p.enum && !p.enum.includes(raw)) throw invalid(`--${name} must be one of: ${p.enum.join(", ")}`);
      return String(raw);
  }
}

/**
 * `run`'s arguments after the id → { values, session, json, url }. `--<param> <value>` per param
 * (a boolean may stand alone), `--session`, `--url`, `--json <object|->`. Anything else is invalid.
 */
export function parseRunArgs(entry, args) {
  const out = { values: {}, session: undefined, json: undefined, url: undefined };
  /** Path params as given, for a remote run's check (they must be absolute there). */
  const givenPaths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) throw invalid(`unexpected argument ${a}`);
    const name = a.slice(2);
    const next = args[i + 1];
    const value = () => {
      if (next === undefined) throw invalid(`--${name} needs a value`);
      i++;
      return next;
    };
    if (name === "url") out.url = value();
    else if (name === "host") {
      // A remote run (§mesh.peers/remote-commands): only set when given.
      const host = value();
      if (!HOST_RE.test(host)) throw invalid(`--host must be a peer's id (lower-case letters, digits and -): ${host}`);
      out.host = host;
    } else if (name === "json") out.json = value();
    else if (name === "session") {
      if (!entry.params.session) throw invalid(`${entry.id} takes no session`);
      out.session = value();
    } else {
      const p = entry.params[name];
      if (!p || p.type === "session") throw invalid(`${entry.id} has no param --${name} (sova describe ${entry.id})`);
      if (p.type === "boolean" && (next === undefined || next.startsWith("--"))) out.values[name] = true;
      else {
        if (p.type === "path" && next !== undefined && !(p.nullable && next === "null")) givenPaths.push([name, next]);
        out.values[name] = coerce(name, p, value());
      }
    }
  }
  if (out.host !== undefined) for (const [name, raw] of givenPaths) remotePath(name, raw, out.host);
  return out;
}

/** On another host a path relative to this shell's folder means nothing: refused, never resolved here. */
function remotePath(name, raw, host) {
  if (typeof raw === "string" && !isAbsolute(raw)) throw invalid(`--${name}: on another host (${host}) a path must be absolute: ${raw}`);
}

/** `--json`'s object, merged under the flags: typed values as given, paths resolved. */
export function mergeJson(entry, text, values, cwd = process.cwd()) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw invalid("--json must be a JSON object");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw invalid("--json must be a JSON object");
  const merged = {};
  let session;
  for (const [k, v] of Object.entries(obj)) {
    const p = entry.params[k];
    if (!p) throw invalid(`${entry.id} has no param ${k} (sova describe ${entry.id})`);
    if (p.type === "session") session = String(v);
    else merged[k] = p.type === "path" && typeof v === "string" ? resolve(cwd, v) : v;
  }
  return { values: { ...merged, ...values }, session };
}

const looksLikePath = (s) => s.includes("/") || s.endsWith(".jsonl");

// ---- the wire -----------------------------------------------------------------------------------

// node:http, not fetch: a project verb can take longer than fetch's 300 s header limit.
// `timeoutMs`: give up (an error) when the whole answer hasn't come by then; none by default.
function send(base, method, url, body, timeoutMs, extra = {}) {
  return new Promise((done, fail) => {
    const u = new URL(`${base}${url}`);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { ...tokenHeaders(), ...extra, ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) };
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, { method, headers }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => done({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      // An answer had begun, so the connection had opened: a break now is never "nothing delivered".
      const broke = (err) => fail(Object.assign(err ?? new Error("the connection broke during the answer"), { opened: true }));
      r.on("error", broke);
      r.on("close", () => {
        if (!r.complete) broke(new Error("the connection broke during the answer"));
      });
    });
    // Whether the connection opened (its `connect`, or a reused keep-alive socket that already had):
    // an error after that may come after the server read the request; one before it means nothing
    // was delivered. Not `socket.connecting` at the error: Node and Bun both say false after a refusal.
    let opened = false;
    req.on("socket", (s) => {
      if (req.reusedSocket || s.connecting === false) opened = true;
      else s.once("connect", () => void (opened = true));
    });
    req.on("error", (err) => {
      if (opened) Object.assign(err, { opened: true });
      fail(err);
    });
    if (timeoutMs) {
      const t = setTimeout(() => req.destroy(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs);
      req.on("close", () => clearTimeout(t));
    }
    req.end(data);
  });
}

/** How long list and describe wait for the served list before using their own copy (the route answers in well under 1 ms). */
export const SERVED_TIMEOUT_MS = 500;

/** Whether `json` is GET /api/commands's answer, whole enough to print from. */
export function isServedList(json) {
  if (!json || typeof json !== "object" || json.version !== 1 || !Array.isArray(json.commands) || !json.commands.length) return false;
  return json.commands.every(
    (e) => e && typeof e === "object" && typeof e.id === "string" && typeof e.label === "string" && typeof e.effect === "string" && e.params && typeof e.params === "object" && e.route && typeof e.route.path === "string",
  );
}

/** The running server's list (§app.served-commands/list), or null for "use the copy": no server, no
    such route, an answer that isn't the list, or none within SERVED_TIMEOUT_MS. */
async function servedEntries(base) {
  try {
    const res = await send(base, "GET", "/api/commands", undefined, SERVED_TIMEOUT_MS);
    if (res.status !== 200) return null;
    const json = JSON.parse(res.text);
    return isServedList(json) ? json.commands : null;
  } catch {
    return null;
  }
}

/** list's and describe's entries: the served list, else the copy; the copy alone when the caller
    named the manifest ($SOVA_EXTENSIONS_FILE). */
async function entriesFor(base, env) {
  if (!env.SOVA_EXTENSIONS_FILE) {
    const served = await servedEntries(base);
    if (served) return served;
  }
  return allEntries(env);
}

/** `chatAction`: whether the request is an in-chat action (default: judged by its URL, as for a local run). */
async function call(base, method, url, body, extra, chatAction = url.startsWith(CHAT_ACTION_ROUTE)) {
  let res;
  try {
    res = await send(base, method, url, body, undefined, extra);
  } catch (err) {
    // An in-chat action whose connection opened and then broke: it may have reached the chat (exit 5).
    if (chatAction && err && err.opened === true) throw new CliError(`${UNKNOWN_LINE} (${err instanceof Error ? err.message : err})`, EXIT.unknown);
    throw new CliError(`cannot reach Sova at ${base} (${err instanceof Error ? err.message : err})`, EXIT.failed);
  }
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text: res.text, json };
}

/** A route's answer that isn't a 2xx, as a CliError carrying its exit class. */
function refusal(res, what) {
  const msg = res.json && typeof res.json.error === "string" ? res.json.error : res.json?.error?.message ?? res.text.slice(0, 200);
  return new CliError(`${what}: ${res.status} ${msg}`, exitForAnswer(res.status, res.json));
}

/** The value a session param takes on its route: a path or an id, from either. */
async function resolveSession(base, key, given) {
  if (key === "path") {
    if (looksLikePath(given)) return resolve(given);
    const res = await call(base, "GET", `/api/sessions/summary?id=${encodeURIComponent(given)}`);
    if (res.status !== 200 || typeof res.json?.path !== "string") throw refusal(res, `session ${given}`);
    return res.json.path;
  }
  if (!looksLikePath(given)) return given;
  const res = await call(base, "GET", "/api/sessions");
  if (res.status !== 200 || !Array.isArray(res.json)) throw refusal(res, "the session list");
  const want = resolve(given);
  const hit = res.json.find((s) => s.path === want);
  if (!hit) throw invalid(`no listed session has the path ${want}; name it by id`);
  return hit.id;
}

/** The `mode.<id>.<name>` entries of the modes a chat has on now (GET /api/mode?path=). */
async function modeCommandsOf(base, session, env) {
  const path = await resolveSession(base, "path", session);
  const res = await call(base, "GET", `/api/mode?path=${encodeURIComponent(path)}`);
  if (res.status !== 200 || !res.json || typeof res.json !== "object") throw refusal(res, `session ${session}'s modes`);
  const on = new Set(Array.isArray(res.json.projectModes) ? res.json.projectModes : []);
  const out = [];
  for (const m of Array.isArray(res.json.projectMinors) ? res.json.projectMinors : [])
    if (on.has(m?.id)) for (const c of Array.isArray(m.commands) ? m.commands : []) {
      const entry = entryFor(`mode.${m.id}.${c?.name}`, env);
      if (entry && entry.id.startsWith("mode.")) out.push({ ...entry, summary: typeof c.description === "string" ? c.description : entry.summary });
    }
  return out;
}

// ---- commands -------------------------------------------------------------------------------------

const out = (v) => process.stdout.write(`${typeof v === "string" ? v : JSON.stringify(v, null, 2)}\n`);

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

/** `mode.<mode id>.<name>`: a project mode's command (§chat.mode-menu/project-mode-commands). */
export const MODE_COMMAND_RE = /^mode\.([a-z][a-z0-9-]{0,29})\.([a-z][a-z0-9]*(?:_[a-z0-9]+)*)$/;

/**
 * The entry `id` names: a catalogue or extension entry, or a project mode's command as the catalogue's
 * `chat.mode-command` row with its mode and name fixed (it needs --session, as every entry that changes something
 * does; --args '<object>' are the command's arguments). Undefined for neither.
 */
export function entryFor(id, env = process.env) {
  const entries = allEntries(env);
  const found = entries.find((e) => e.id === id);
  const m = found ? null : MODE_COMMAND_RE.exec(id);
  const row = m ? entries.find((e) => e.id === "chat.mode-command") : undefined;
  if (!m || !row) return found;
  const { mode: _mode, name: _name, ...params } = row.params;
  return { ...row, id, label: `${m[1]}: ${m[2]}`, summary: `Run ${m[1]}'s command ${m[2]} in a chat that has it on.`, params, route: { ...row.route, fixed: { mode: m[1], name: m[2] } } };
}

async function run(id, args, env) {
  const entry = entryFor(id, env);
  if (!entry) throw invalid(`no command ${id} (sova list)`);
  const parsed = parseRunArgs(entry, args);
  const host = parsed.host;
  // A remote run goes through this host's own proxy to the peer (§mesh.peers/remote-commands).
  const base = host === undefined ? serverBase(parsed.url, env) : `${serverBase(parsed.url, env)}/peer/${host}`;
  let values = parsed.values;
  let session = parsed.session;
  if (parsed.json !== undefined) {
    const text = parsed.json === "-" ? await readStdin() : parsed.json;
    if (host !== undefined) {
      // As given, before mergeJson makes them absolute here.
      let raw = null;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = null; // mergeJson says what is wrong with it
      }
      if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (entry.params[k]?.type === "path" && v !== null) remotePath(k, v, host);
    }
    const merged = mergeJson(entry, text, values);
    values = merged.values;
    session = session ?? merged.session;
  }
  for (const [name, p] of Object.entries(entry.params)) {
    // A path's default is this process's cwd-relative path, made absolute as sova-project does; a
    // remote run leaves it to the peer's own default.
    if (p.type === "path" && values[name] === undefined && p.default !== undefined && host === undefined) values[name] = resolve(p.default);
    if (p.type !== "session") continue;
    // The chat's own session, for an entry that only looks (§app.commands/cli).
    const given = session ?? (entry.effect === "looks" ? env.SOVA_CHAT_ID : undefined);
    if (given === undefined) throw invalid(`${entry.id} needs --session <id|path>`);
    values[name] = await resolveSession(base, wireKey(name, p) === "id" ? "id" : "path", given);
  }
  let req;
  try {
    req = buildRequest(entry, values);
  } catch (err) {
    throw invalid(err instanceof Error ? err.message : String(err));
  }
  const chatAction = entry.route.path.startsWith(CHAT_ACTION_ROUTE);
  const res = host === undefined
    ? await call(base, req.method, req.url, req.body, { [COMMAND_HEADER]: entry.id }, chatAction)
    : await call(base, "POST", `/api/commands/${encodeURIComponent(entry.id)}`, values, { [COMMAND_HEADER]: entry.id }, chatAction);
  if (res.json === undefined) {
    // An extension's backend answers as it likes; a core route always answers JSON.
    if (entry.extension && res.status >= 200 && res.status < 300) {
      out(res.text);
      return EXIT.done;
    }
    process.stderr.write(`sova: ${req.method} ${req.url} answered ${res.status} without JSON: ${res.text.slice(0, 200)}\n`);
    return res.status >= 200 && res.status < 300 ? EXIT.failed : exitForAnswer(res.status, undefined);
  }
  out(res.json);
  if (res.status === 202 && chatAction && res.json && res.json.outcome === "unknown") {
    process.stderr.write(`sova: ${UNKNOWN_LINE}\n`);
    return EXIT.unknown;
  }
  const code = exitForAnswer(res.status, res.json);
  if (code !== EXIT.done) process.stderr.write(`sova: ${entry.id} answered ${res.status}${host === undefined ? "" : ` on ${host}`}\n`);
  if (host !== undefined && res.status === 404) process.stderr.write(`sova: ${remoteNotFound(host, res.json)}\n`);
  if (host !== undefined && res.status === 403) process.stderr.write(`sova: ${host} doesn't grant this host what ${entry.id} needs (its Mesh page decides)\n`);
  return code;
}

/** sova watch: the event stream when the server has one, else the feed and the list diff. */
async function watch(args, env) {
  let url;
  let events = null;
  let since = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url" && args[i + 1] !== undefined) url = args[++i];
    else if (a === "--events" && args[i + 1] !== undefined) {
      events = new Set(args[++i].split(",").map((s) => s.trim()).filter(Boolean));
      for (const e of events) if (e !== "feed" && !STREAM_WATCH_EVENTS.includes(e)) throw invalid(`--events: no event ${e} (feed, ${STREAM_WATCH_EVENTS.join(", ")})`);
    } else if (a === "--since" && args[i + 1] !== undefined) {
      since = parseCursor(args[++i]);
      if (!since) throw invalid(`--since takes a cursor <stream>:<seq>, as a watch line's "cursor" gives it: ${args[i]}`);
    } else throw invalid(`unexpected argument ${a}`);
  }
  const base = serverBase(url, env);
  const wanted = (name) => !events || events.has(name);
  const print = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const wsBase = base.replace(/^http/, "ws");
  const stream = await openStream(`${wsBase}${EVENTS_PATH}${since ? `?stream=${since.stream}&since=${since.since}` : ""}`);
  if (stream && "refused" in stream) throw new CliError(`the event stream refused the cursor: ${stream.refused}`, EXIT.invalid);
  if (!stream) return diffWatch(base, wsBase, wanted, since);

  // The stream: each event as the line the diff prints, plus its source and cursor.
  return await new Promise((done) => {
    let finished = false;
    const finish = (what, e, code = EXIT.failed) => {
      if (finished) return;
      finished = true;
      process.stderr.write(`sova: ${what} (${e.code}${e.reason ? ` ${e.reason}` : ""})\n`);
      feed?.close();
      stream.ws.close();
      done(code);
    };
    const onFrame = (frame) => {
      if (frame?.type === "error") {
        process.stderr.write(`sova: the event stream: ${frame.message}\n`);
        return;
      }
      const line = fromStreamFrame(frame, stream.hello.stream);
      if (!line || !wanted(line.event)) return;
      print(line.event === "gap" ? { ...line, at: Date.now() } : line);
    };
    for (const f of stream.early) onFrame(f);
    stream.ws.onmessage = (m) => onFrame(parse(m.data));
    stream.ws.onclose = (e) => finish("the event stream closed", e);
    // The feed's own frames, as before, while they are wanted.
    const feed = wanted("feed") ? new WebSocket(`${wsBase}/ws/watch?feed=sessions`, { headers: tokenHeaders() }) : null;
    if (feed) {
      feed.onmessage = (m) => {
        const frame = parse(m.data);
        if (frame !== undefined) print({ event: "feed", frame, at: Date.now() });
      };
      feed.onerror = () => {};
      feed.onclose = (e) => finish("the session feed closed", e);
    }
  });
}

function parse(data) {
  try {
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}

/** How long the stream has to greet before watch treats the server as having none. */
const HELLO_TIMEOUT_MS = 5000;

/**
 * /ws/events, open and greeted: { ws, hello, early } (frames that came with the hello), or
 * { refused } (the server refused the cursor: its `error` frame), or null when this server has no
 * stream (the socket failed or closed before a hello, or none came in time).
 */
function openStream(url) {
  return new Promise((done) => {
    let settled = false;
    const early = [];
    let hello = null;
    let ws;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!v) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // already gone
        }
      }
      done(v);
    };
    const timer = setTimeout(() => settle(null), HELLO_TIMEOUT_MS);
    try {
      ws = new WebSocket(url, { headers: tokenHeaders() });
    } catch {
      clearTimeout(timer);
      done(null);
      return;
    }
    ws.onmessage = (m) => {
      const frame = parse(m.data);
      if (!hello) {
        if (frame?.type === "hello" && typeof frame.stream === "string") {
          hello = frame;
          // The replay follows the hello at once; hand over on the next turn with what came with it.
          setTimeout(() => settle({ ws, hello, early }), 0);
        } else if (frame?.type === "error") settle({ refused: String(frame.message ?? "refused") });
        return;
      }
      if (!settled) early.push(frame);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (!hello) settle(null);
    };
  });
}

/** The fallback (§app.commands/watch): relays the feed and prints the derived changes until the socket closes. */
async function diffWatch(base, wsBase, wanted, since) {
  const emit = (obj) => {
    if (wanted(obj.event)) process.stdout.write(`${JSON.stringify({ ...obj, at: Date.now() })}\n`);
  };
  const readList = async () => {
    const res = await call(base, "GET", "/api/sessions");
    if (res.status !== 200 || !Array.isArray(res.json)) throw refusal(res, "the session list");
    return res.json;
  };
  let last = indexSessions(await readList());
  if (since) throw new CliError("this Sova has no event stream (/ws/events), so --since can't resume; nothing was printed", EXIT.failed);
  // One read at a time; a burst of frames while one runs folds into one more read.
  let reading = false;
  let again = false;
  const refresh = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const list = await readList();
        for (const ev of diffSessions(last, list)) emit(ev);
        last = indexSessions(list);
      } while (again);
    } catch (err) {
      process.stderr.write(`sova: ${err instanceof Error ? err.message : err}\n`);
    } finally {
      reading = false;
    }
  };
  return await new Promise((done) => {
    const ws = new WebSocket(`${wsBase}/ws/watch?feed=sessions`, { headers: tokenHeaders() });
    ws.onmessage = (m) => {
      const frame = parse(m.data);
      if (frame === undefined) return;
      emit({ event: "feed", frame });
      if (frame?.type === "list_changed" || (frame?.type === "marks" && !frame.full)) void refresh();
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      process.stderr.write(`sova: the session feed closed (${e.code}${e.reason ? ` ${e.reason}` : ""})\n`);
      done(EXIT.failed);
    };
  });
}

const USAGE = `usage: node scripts/sova.mjs list [--json] [--session <id|path>] | describe <id> | run <id> [--<param> <value>]… [--session <id|path>] [--json '<object>' | -] [--host <peer>] | watch [--events a,b] [--since <stream>:<seq>]
       a project mode's command: run mode.<mode>.<name> --session <id|path> [--args '<object>']
       every command takes --url <http://127.0.0.1:4800> (this machine only); run --host <peer> runs it on that mesh peer, through this machine
       exit: 0 done, 1 failed, 2 refused, 3 invalid, 4 busy, 5 outcome unknown (chat.* only: check the chat; never retried)`;

export async function main(argv, env = process.env) {
  // `sova --host <peer> run <id> …`: the same as `run <id> … --host <peer>`, for run only.
  if (argv[0] === "--host") {
    const [, host, sub, id, ...more] = argv;
    if (host === undefined) throw invalid("--host needs a peer's id");
    if (sub !== "run") throw invalid("--host goes with run only (sova --host <peer> run <id>)");
    if (!id) throw invalid("name a command (sova list)");
    return run(id, [...more, "--host", host], env);
  }
  const [cmd, ...rest] = argv;
  if (cmd === "list") {
    let url;
    let json = false;
    let session;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--json") json = true;
      else if (rest[i] === "--url" && rest[i + 1] !== undefined) url = rest[++i];
      else if (rest[i] === "--session" && rest[i + 1] !== undefined) session = rest[++i];
      else throw invalid(`unexpected argument ${rest[i]}`);
    }
    const base = serverBase(url, env);
    const entries = await entriesFor(base, env);
    // With --session: that chat's project mode commands too, those of the modes it has on now.
    if (session !== undefined) entries.push(...(await modeCommandsOf(base, session, env)));
    out(json ? entries : listLines(entries).join("\n"));
    return EXIT.done;
  }
  if (cmd === "describe") {
    const [id, ...more] = rest;
    if (!id) throw invalid("name a command (sova list)");
    let url;
    for (let i = 0; i < more.length; i++) {
      if (more[i] === "--url" && more[i + 1] !== undefined) url = more[++i];
      else throw invalid(`unexpected argument ${more[i]}`);
    }
    const entry = (await entriesFor(serverBase(url, env), env)).find((e) => e.id === id);
    if (!entry) throw invalid(`no command ${id} (sova list)`);
    out(entry);
    return EXIT.done;
  }
  if (cmd === "run") {
    const [id, ...args] = rest;
    if (!id) throw invalid("name a command (sova list)");
    return run(id, args, env);
  }
  if (cmd === "watch") return watch(rest, env);
  throw invalid(cmd ? `no command ${cmd}` : "name a command");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof CliError) {
        process.stderr.write(`sova: ${err.message}\n`);
        if (err.usage) process.stderr.write(`${USAGE}\n`);
        process.exit(err.code);
      }
      process.stderr.write(`sova: ${err instanceof Error ? err.stack : err}\n`);
      process.exit(EXIT.failed);
    },
  );
}
