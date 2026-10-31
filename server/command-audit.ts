// Who ran what (§app.command-audit/record, §app.command-audit/list): one row per call a token holder
// makes to the main listener, never the call's params.
//
// A row is written only for a call the gate let in that shows the install token in x-sova-token
// (auth.ts showsToken), or an installed extension's own key there (caller `ext:<id>`): the command
// line, scripts, a chat's tools, the link extension, an extension's backend. A browser
// (cookie only), the page, in-process calls and the peer listener never come here, and neither does
// a call the gate let in without the token (an exempt path, auth off), so only the token's holder
// can add a row. One more kind of row: a transcript card's view running a command through the page
// (caller `card:<type>`, §chat.transcript-cards/view-api), which the server itself notes when it runs
// it (server/transcript-cards-routes.ts). A row is `{at, caller, command?, method, route, status}`: the route as the server
// registers it, never the request's path, query, body or headers.
//
// Off the request path: note() only queues (at most QUEUE_MAX rows, ~2 MB, the oldest dropped and counted);
// a timer writes the batch with one append, at most FLUSH_MS later. The file rotates at FILE_MAX into
// `.1` and `.2`. A socket that asked for them (`/ws/events?with=command.ran`) hears each row live
// (server/events.ts announce), outside the stream's ring and numbering.
import type { IncomingMessage } from "node:http";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { COMMANDS } from "../shared/commands-catalog";
import { COMMAND_RAN, type CommandFrame } from "../shared/events";
import { extensionCaller, onUpgradeAllowed, showsToken, TOKEN_HEADER } from "./auth";
import { CALLER_HEADER, callerKeys, type Caller } from "./caller-keys";
import { EXT_COMMAND_NAME_RE } from "../shared/commands-ext";
import { EXTENSION_ID_RE } from "./extensions";
import { eventHub } from "./events";
import { judgedPath } from "./mesh/paths";
import { stateRoot } from "./state-root";

/** The header `scripts/sova.mjs run <id>` names its command in. */
export const COMMAND_HEADER = "x-sova-command";
export const AUDIT_PATH = "/api/audit";

export const FLUSH_MS = 250;
export const BATCH_ROWS = 1000;
export const QUEUE_MAX = 10_000;
export const FILE_MAX = 4 * 1024 * 1024;
export const KEEP_OLD = 2;
export const LIST_MAX = 1000;
export const LIST_DEFAULT = 100;
export const FILTER_MAX = 128;

export interface AuditRow {
  at: string;
  caller: Caller;
  command?: string;
  method: string;
  route: string;
  status: number;
}

const COMMAND_IDS = new Set(COMMANDS.map((c) => c.id));
/** A command name a row may carry: a catalogue id or exactly what an extension command's id can be,
    `ext.<id>.<name>` with the manifest's id alphabet and the command-name alphabet, else none. */
export function commandName(header: string | undefined): string | undefined {
  const v = header?.trim();
  if (!v || v.length > 120) return undefined;
  if (COMMAND_IDS.has(v)) return v;
  // A project mode's command (§chat.mode-menu/project-mode-commands): named by its own id.
  if (/^mode\.[a-z][a-z0-9-]{0,29}\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(v) && v.length <= 72) return v;
  if (!v.startsWith("ext.")) return undefined;
  const dot = v.lastIndexOf(".");
  const id = v.slice(4, dot);
  return dot > 4 && EXTENSION_ID_RE.test(id) && id !== "." && id !== ".." && EXT_COMMAND_NAME_RE.test(v.slice(dot + 1)) ? v : undefined;
}

/** The app's dynamic families (auth.ts DYNAMIC): the page and its files are never recorded. */
const DYNAMIC = /^\/(?:api|ext|peer|explain|design|ws)(?:\/|$)/;
const PLAIN_DYNAMIC = /^\/(?:api|ext|peer|explain|design|ws)\//;

export interface AuditOptions {
  dir?: () => string;
  now?: () => number;
  flushMs?: number;
  batchRows?: number;
  queueMax?: number;
  fileMax?: number;
  /** Told of each row as it is noted (the event stream's opted-in sockets). */
  onRow?: (row: AuditRow) => void;
  /** Whether anyone hears onRow now (checked first, so a row is formatted only for a listener). */
  listening?: () => boolean;
  log?: (line: string) => void;
}

/** A row as queued: its time as a number, made into `at` when it is written or listed. */
type Queued = Omit<AuditRow, "at"> & { t: number };
let lastT = -1;
let lastAt = "";
/** `t` as ISO time, the last one kept: rows come in runs of the same millisecond. */
const isoOf = (t: number): string => (t === lastT ? lastAt : ((lastT = t), (lastAt = new Date(t).toISOString())));
const rowOf = ({ t, ...rest }: Queued): AuditRow => ({ at: isoOf(t), ...rest });
/** A row's line, in AuditRow's key order: the same text JSON.stringify(rowOf(r)) gives, built directly. */
const lineOf = (r: Queued): string =>
  `{"at":"${isoOf(r.t)}","caller":${JSON.stringify(r.caller)}${r.command !== undefined ? `,"command":${JSON.stringify(r.command)}` : ""},"method":${JSON.stringify(r.method)},"route":${JSON.stringify(r.route)},"status":${r.status}}\n`;

export class CommandAudit {
  private queue: Queued[] = [];
  private dropped = 0;
  /** Dropped since this server started, for the list's answer. */
  private droppedTotal = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The timer set is the immediate one (a full batch): no other note re-arms it. */
  private timerNow = false;
  private writing: Promise<void> | null = null;
  private size: number | null = null;
  /** The record, kept open for appends between rotations (one write per batch, no open per batch). */
  private handle: FileHandle | null = null;
  private handleAt = 0;
  private lastWarn = 0;

  constructor(private readonly o: AuditOptions = {}) {}

  private dir(): string {
    return (this.o.dir ?? (() => join(stateRoot(), "audit")))();
  }
  file(n = 0): string {
    return join(this.dir(), n ? `commands.${n}.jsonl` : "commands.jsonl");
  }

  /** Queue a row; never waits, never throws to its caller's answer. */
  note(row: AuditRow): void {
    const { at, ...rest } = row;
    this.queued({ t: Date.parse(at), ...rest });
  }

  /** note() for a row whose time is still a number (the request path: no formatting there). */
  queued(row: Queued): void {
    this.queue.push(row);
    if (this.queue.length > (this.o.queueMax ?? QUEUE_MAX)) {
      this.queue.shift();
      this.dropped++;
      this.droppedTotal++;
    }
    try {
      if (this.o.onRow && (this.o.listening?.() ?? true)) this.o.onRow(rowOf(row));
    } catch {
      // a listener never stops the record
    }
    this.schedule();
  }

  /** One timer at most: FLUSH_MS after the first queued row, at once for a full batch. While a
      write runs, nothing is armed: its end schedules what came in meanwhile. */
  private schedule(): void {
    if (this.writing) return;
    const now = this.queue.length >= (this.o.batchRows ?? BATCH_ROWS);
    if (this.timer && (!now || this.timerNow)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerNow = now;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, now ? 0 : (this.o.flushMs ?? FLUSH_MS));
    this.timer.unref?.();
  }

  /** Write what is queued (one append; one write at a time). */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
    if (!this.queue.length && !this.dropped) return;
    const rows = this.queue;
    const dropped = this.dropped;
    this.queue = [];
    this.dropped = 0;
    const now = new Date((this.o.now ?? Date.now)()).toISOString();
    const text = (dropped ? `${JSON.stringify({ at: now, dropped })}\n` : "") + rows.map(lineOf).join("");
    this.writing = this.write(text).finally(() => (this.writing = null));
    await this.writing;
    if (this.queue.length || this.dropped) this.schedule();
  }

  private async write(text: string): Promise<void> {
    try {
      const bytes = Buffer.byteLength(text);
      // Opened again each minute, so a record someone moved or deleted is started afresh soon.
      if (this.handle && Date.now() - this.handleAt > 60_000) await this.close();
      if (!this.handle) await this.openRecord();
      if (this.size! > 0 && this.size! + bytes > (this.o.fileMax ?? FILE_MAX)) {
        await this.rotate();
        await this.openRecord();
      }
      await this.handle!.write(text);
      this.size! += bytes;
    } catch (err) {
      await this.close();
      const t = Date.now();
      if (t - this.lastWarn > 60_000) {
        this.lastWarn = t;
        (this.o.log ?? ((l) => console.warn(`[audit] ${l}`)))(`a batch was not written: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async openRecord(): Promise<void> {
    await mkdir(this.dir(), { recursive: true, mode: 0o700 });
    this.handle = await open(this.file(), "a", 0o600);
    this.handleAt = Date.now();
    this.size = (await this.handle.stat()).size;
  }

  /** Let go of the open record (a rotation, a write error, a test's end). */
  async close(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    this.size = null;
    await h?.close().catch(() => {});
  }

  private async rotate(): Promise<void> {
    await this.close();
    await rm(this.file(KEEP_OLD), { force: true });
    for (let n = KEEP_OLD - 1; n >= 1; n--) await rename(this.file(n), this.file(n + 1)).catch(() => {});
    await rename(this.file(), this.file(1));
    this.size = 0;
  }

  /** The newest rows first, queued ones included: at most `limit`, `caller`'s or `command`'s only. */
  async list(q: { limit?: number; caller?: string; command?: string } = {}): Promise<{ rows: AuditRow[]; dropped?: number }> {
    const limit = q.limit ?? LIST_DEFAULT;
    const rows: AuditRow[] = [];
    const take = (r: unknown): boolean => {
      const row = r as AuditRow;
      if (!row || typeof row.caller !== "string" || typeof row.route !== "string") return false;
      if (q.caller !== undefined && row.caller !== q.caller) return false;
      if (q.command !== undefined && row.command !== q.command) return false;
      rows.push(row);
      return rows.length >= limit;
    };
    for (let i = this.queue.length - 1; i >= 0; i--) if (take(rowOf(this.queue[i]!))) return this.answer(rows);
    // A batch being written is in neither the queue nor (yet) the file: wait for it.
    while (this.writing) await this.writing;
    for (let n = 0; n <= KEEP_OLD; n++) {
      let text: string;
      try {
        text = await readFile(this.file(n), "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!line) continue;
        let r: unknown;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        if (take(r)) return this.answer(rows);
      }
    }
    return this.answer(rows);
  }

  private answer(rows: AuditRow[]): { rows: AuditRow[]; dropped?: number } {
    return this.droppedTotal ? { rows, dropped: this.droppedTotal } : { rows };
  }
}

/** Each row, live, to the event stream's sockets that asked for them. */
function announce(row: AuditRow): void {
  const frame: CommandFrame = { type: "command", name: COMMAND_RAN, ...row };
  eventHub()?.announce(frame);
}

/** The server's record. Its rows reach the stream only while a socket listens (the hub is awake). */
export const commandAudit = new CommandAudit({ onRow: (row) => announce(row), listening: () => (eventHub()?.commandListeners ?? 0) > 0 });

/**
 * The record's start for a main-listener request the gate let in: null unless it shows the token
 * (and is to a dynamic path); else the note to make once it is answered, with the status and the
 * route that answered (Hono's `routePath`). Never throws.
 */
export function auditStart(c: Context, audit: CommandAudit = commandAudit): ((status: number, route: string) => void) | null {
  try {
    const env = c.env as { incoming?: unknown; meshPeer?: unknown } | undefined;
    if (!env?.incoming || env.meshPeer) return null;
    const token = c.req.header(TOKEN_HEADER);
    if (token === undefined) return null;
    // The common case needs no decoding: a plain dynamic prefix. Anything else is judged as the gate judges it.
    const raw = c.req.path;
    if (!(PLAIN_DYNAMIC.test(raw) && !raw.includes("%")) && !DYNAMIC.test(judgedPath(raw) ?? "/")) return null;
    let caller: Caller;
    if (showsToken(token)) caller = callerKeys.callerOf(c.req.header(CALLER_HEADER));
    else {
      // An installed extension's own key (§app.extensions/backend-key): always its extension's row,
      // whatever x-sova-caller says.
      const ext = extensionCaller(token);
      if (ext === null) return null;
      caller = `ext:${ext}`;
    }
    const command = commandName(c.req.header(COMMAND_HEADER));
    const method = c.req.method;
    const t = Date.now();
    return (status, route) => {
      try {
        audit.queued(command ? { t, caller, command, method, route, status } : { t, caller, method, route, status });
      } catch {
        // the record never changes an answer
      }
    };
  } catch {
    return null;
  }
}

/** The socket paths a row names; any other upgrade by its family only. */
function socketRoute(path: string): string {
  if (path === "/ws/chat" || path === "/ws/watch" || path === "/ws/events") return path;
  if (/^\/ext\/[^/]+\/ws(?:\/|$)/.test(path)) return "/ext/:id/ws/*";
  if (/^\/peer\/[^/]+\/ws(?:\/|$)/.test(path)) return "/peer/:id/ws/*";
  return "/ws/*";
}

/** An upgrade the gate allowed: a row (status 101) when it shows the token. */
export function noteUpgrade(req: IncomingMessage, audit: CommandAudit = commandAudit): void {
  const one = (n: string): string | undefined => {
    const v = req.headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const token = one(TOKEN_HEADER);
  let caller: Caller;
  if (showsToken(token)) caller = callerKeys.callerOf(one(CALLER_HEADER));
  else {
    const ext = extensionCaller(token);
    if (ext === null) return;
    caller = `ext:${ext}`;
  }
  const path = judgedPath(new URL(req.url ?? "/", "http://localhost").pathname);
  if (!path) return;
  const command = commandName(one(COMMAND_HEADER));
  audit.note({ at: new Date().toISOString(), caller, ...(command ? { command } : {}), method: "GET", route: socketRoute(path), status: 101 });
}
onUpgradeAllowed((req) => noteUpgrade(req));

const sentence = (c: Context, error: string) => c.json({ error }, 400);

/** GET /api/audit (`audit.list`). */
export function registerAuditRoutes(app: Hono, audit: CommandAudit = commandAudit): void {
  app.get(AUDIT_PATH, async (c) => {
    const raw = c.req.query("limit");
    let limit = LIST_DEFAULT;
    if (raw !== undefined) {
      if (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > LIST_MAX) return sentence(c, `limit must be a whole number from 1 to ${LIST_MAX}.`);
      limit = Number(raw);
    }
    const caller = c.req.query("caller");
    const command = c.req.query("command");
    if (caller !== undefined && caller.length > FILTER_MAX) return sentence(c, `caller is longer than ${FILTER_MAX} characters.`);
    if (command !== undefined && command.length > FILTER_MAX) return sentence(c, `command is longer than ${FILTER_MAX} characters.`);
    return c.json(await audit.list({ limit, ...(caller !== undefined ? { caller } : {}), ...(command !== undefined ? { command } : {}) }));
  });
}
