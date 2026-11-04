// MCP servers in Sova chats. pi's own MCP extension (createMcpExtension) carries the
// tools through pi's pipeline; Sova holds its seams:
// - `loadConfig` answers nothing, so pi's own reading of mcp.json and a repository's .pi/mcp.json never happens, and
//   the chat's list reaches pi as registered servers, every one `direct`;
// - `createTransport`: pi connects every server at session_start and declares what it lists. Sova hands it a
//   transport that answers the handshake and `tools/list` from the chat's list and starts the real server at the
//   first call, so a late connect can't change the declared tools and a chat that never calls a server runs nothing.
// The list itself is data: made by the server (server/mcp/list.ts), kept in the session from the first message on.
import { join } from "node:path";
import { createMcpExtension, type McpServerConfig, type McpTransportFactory } from "@earendil-works/pi-coding-agent";
import type { McpErrorLine, McpNote, McpToolName } from "../../../shared/mcp";
import { prepareSessionCommand, type PreparedSessionCommand } from "../../../pi-config/extensions/sandbox/session-policy.ts";
import type { ParentScope } from "../../../pi-config/extensions/sandbox/policy.ts";
import { SANDBOX_DISCOVER_EVENT, SANDBOX_STATE_EVENT } from "../../../pi-config/extensions/sandbox/state.ts";
import { reservedName } from "../../mcp/config";
import { NO_MCP, normalizeChatList, workerListOf, type McpChatList, type McpChatServer } from "../../mcp/list";
import { readyToRun } from "../../mcp/resolve";
import { secretValues, withoutSecrets } from "../../mcp/saved-values";
import { addChatLine, type McpCheckRecord } from "../../mcp/store";
import { cleanMcpEnv, ENV_ALLOW, Events, StdioServer, type JsonRpc, type Launch } from "../../mcp/transport";
import { agentRoot, stateRoot } from "../../state-root";
import type { PiExtensionAPI } from "./extension-types";
import { addressValues, AddressServer, McpCallFailed, type AddressLaunch } from "./mcp-http";
import { noteMcpTool } from "./mcp-tools";

type McpTransport = ReturnType<McpTransportFactory>;

/** A server's copy behind a SnapshotTransport: a command's process, or an address's session. */
type McpUpstream = Pick<StdioServer, "start" | "send" | "close" | "onMessage" | "onError" | "onClose" | "stderr" | "sandboxed" | "values"> & { readonly pid: number | undefined };

/** The session entries: a chat's list, kept from its first message on, and a failure's note. */
export const MCP_LIST_ENTRY = "sova-mcp-list";
export const MCP_NOTE_ENTRY = "sova-mcp-note";

export type McpServerState = "idle" | "starting" | "running" | "exited" | "failed";

/** What a chat's copy of a server is doing, from the transport Sova holds; pi has no public read of this. */
export interface McpServerStatus {
  name: string;
  state: McpServerState;
  pid?: number;
  /** The copy runs inside the chat's sandbox. */
  sandboxed: boolean;
  /** Why it isn't running, with its last output. */
  error?: string;
  starts: number;
}

/**
 * `sova`, in any case, is Sova's own: its tools reach a Claude Code chat under the MCP server `sova`, so a server of
 * that name would give a chat two tools that read alike. The rule is `reservedName`; a list is
 * held to it again here, the last door.
 */
export const reservedMcpServerName = reservedName;

/** pi reads a client secret through its own expansion when it refreshes; `$$` and `$!` are its literal forms (P36). */
export const piLiteral = (value: string): string => value.replace(/\$/g, "$$$$").replace(/^!/, "$$!");

/**
 * A listed server as pi's config: every tool declared. A command never reaches pi, nor does any header: the transport
 * is Sova's. An address that signs in or takes a provider's token goes by its URL, the one way pi builds the auth
 * provider a transport is handed (P36). One that can't start now needs none: its start says why.
 */
export function mcpConfigOf(server: McpChatServer): McpServerConfig {
  const plain: McpServerConfig = { command: server.name, exposure: "direct" };
  if (server.kind !== "address") return plain;
  const ready = readyToRun(server.owner, server.name);
  if (!ready.ok) return plain;
  const { url, headers, oauth, auth, timeout } = ready.entry;
  const secret = oauth?.clientSecret;
  const limit = timeout ? { timeout } : {};
  if (Object.keys(headers ?? {}).some((h) => h.toLowerCase() === "authorization") && !auth) return { ...plain, ...limit };
  return { url: url!, exposure: "direct", ...limit, ...(auth ? { auth } : {}), ...(oauth ? { oauth: { ...oauth, ...(typeof secret === "string" ? { clientSecret: piLiteral(secret) } : {}) } } : {}) } as McpServerConfig;
}

const HANDSHAKE_ID = "sova-mcp-handshake";
/** JSON-RPC's "server error" range: the call failed, nothing about the client's request was wrong. */
const SERVER_ERROR = -32000;
/** A server's announcements of a changed list: the chat's list is fixed, so they stop here. */
const LIST_CHANGED = new Set(["notifications/tools/list_changed", "notifications/resources/list_changed", "notifications/prompts/list_changed"]);

/**
 * What pi's client talks to in a chat. It answers the handshake and `tools/list` from the Check record,
 * so pi "connects" at once and declares exactly the record's tools, whatever the server would say today.
 * The first anything-else starts the real server, handshakes with it and passes messages through; a
 * server that exited starts again at the next call. A start that fails answers that call with the reason.
 */
export class SnapshotTransport extends Events {
  private upstream: McpUpstream | undefined;
  private starting: Promise<McpUpstream> | undefined;
  private initializeParams: unknown;
  private pending = new Set<string | number>();
  private closed = false;
  private stopping = false;
  /** The run in hand: what it was filled with stays out of everything said about it. */
  private run: Pick<StdioServer, "values"> | undefined;

  constructor(
    private readonly record: McpCheckRecord,
    private readonly start_: () => McpUpstream,
    private readonly report: (patch: Partial<McpServerStatus>, how?: "changed" | "failed" | "address-under-on") => void,
    private readonly requestTimeoutMs: number,
  ) {
    super();
  }

  async start(): Promise<void> {}

  private reply(id: JsonRpc["id"], result: unknown) {
    queueMicrotask(() => this.emitMessage({ jsonrpc: "2.0", id, result }));
  }
  private fail(id: JsonRpc["id"], message: string) {
    const clean = this.clean(message);
    queueMicrotask(() => this.emitMessage({ jsonrpc: "2.0", id, error: { code: SERVER_ERROR, message: clean } }));
  }
  private clean(text: string): string {
    return withoutSecrets(text, this.run?.values ?? []);
  }
  private status(patch: Partial<McpServerStatus>, how?: "changed" | "failed" | "address-under-on") {
    this.report(patch.error ? { ...patch, error: this.clean(patch.error) } : patch, how);
  }
  /** Every string of a server's error reply or notification. A tool's result is its own answer, and passes as it came. */
  private cleanDeep(value: unknown): unknown {
    if (typeof value === "string") return this.clean(value);
    if (Array.isArray(value)) return value.map((v) => this.cleanDeep(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.cleanDeep(v)]));
    return value;
  }

  async send(message: JsonRpc): Promise<void> {
    if (message.method === "initialize") {
      this.initializeParams = message.params;
      const { protocolVersion, serverInfo, instructions } = this.record;
      return this.reply(message.id, { protocolVersion, serverInfo, capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });
    }
    if (message.method === "notifications/initialized") return;
    if (message.method === "tools/list") return this.reply(message.id, { tools: this.record.tools });
    if (message.method === "ping") return this.reply(message.id, {});
    const isRequest = message.method !== undefined && message.id !== undefined;
    if (!isRequest) {
      // A cancel or a reply to the server's own request: only a running server can want it.
      await this.upstream?.send(message).catch(() => {});
      return;
    }
    const id = message.id as string | number;
    this.pending.add(id);
    try {
      const server = await this.running();
      await server.send(message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof McpCallFailed) return this.lost(id, reason);
      this.pending.delete(id);
      this.fail(id, reason);
    }
  }

  /** An address server's failed request: what a process's exit is to a command server. The next call opens a new copy. */
  private async lost(id: string | number, reason: string): Promise<void> {
    if (!this.pending.has(id)) return;
    for (const waiting of this.pending) this.fail(waiting, reason);
    this.pending.clear();
    const server = this.upstream;
    this.upstream = undefined;
    this.status({ state: "failed", pid: undefined, error: reason });
    await server?.close().catch(() => {});
  }

  private running(): Promise<McpUpstream> {
    if (this.upstream) return Promise.resolve(this.upstream);
    this.starting ??= this.open().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async open(): Promise<McpUpstream> {
    const server = this.start_();
    this.run = server;
    this.status({ state: "starting", error: undefined });
    let handshake: { resolve(): void; reject(error: Error): void } | undefined;
    const answered = new Promise<void>((resolve, reject) => {
      handshake = { resolve, reject };
    });
    let up = false;
    const describe = (reason: string) => {
      const inSandbox = server.sandboxed ? " inside the sandbox" : "";
      const tail = server.stderr.trim();
      return `${reason}${inSandbox}${tail ? `\n${tail}` : ""}`;
    };
    server.onMessage((message) => {
      if (message.id === HANDSHAKE_ID) {
        if (message.error) handshake?.reject(new Error(describe(`the server refused the handshake: ${JSON.stringify(message.error)}`)));
        else handshake?.resolve();
        return;
      }
      if (message.method && LIST_CHANGED.has(message.method)) return;
      if (message.id !== undefined && message.method === undefined) this.pending.delete(message.id as string | number);
      this.emitMessage(message.result !== undefined ? message : (this.cleanDeep(message) as JsonRpc));
    });
    server.onError((error) => this.emitError(new Error(this.clean(error.message))));
    server.onClose(() => {
      const wasUp = up;
      this.upstream = undefined;
      if (this.closed || this.stopping) return;
      const reason = describe(wasUp ? "the server exited" : "the server exited while starting");
      // One that exited with no call waiting has failed nobody: the next call starts it again.
      this.status({ state: wasUp && !this.pending.size ? "exited" : "failed", pid: undefined, error: reason });
      handshake?.reject(new Error(reason));
      for (const id of this.pending) this.fail(id, reason);
      this.pending.clear();
    });
    try {
      await server.start();
      this.status({ pid: server.pid, sandboxed: server.sandboxed });
      await server.send({ jsonrpc: "2.0", id: HANDSHAKE_ID, method: "initialize", params: this.initializeParams });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        answered,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(describe(`the server didn't answer within ${this.requestTimeoutMs / 1000} s`))), this.requestTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      await server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status({ state: "failed", pid: undefined, error: message }, error instanceof McpStartRefused ? error.how : undefined);
      await server.close().catch(() => {});
      throw new Error(`MCP server "${this.record.serverInfo.name}" didn't start: ${message}`);
    }
    up = true;
    this.upstream = server;
    this.status({ state: "running" });
    return server;
  }

  /** Stops the running copy; the next call starts another (a sandbox change does this). */
  async stopCopy(): Promise<void> {
    await this.starting?.catch(() => {});
    this.stopping = true;
    await this.upstream?.close();
    this.upstream = undefined;
    this.stopping = false;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopCopy();
    this.emitClose();
  }
}

interface SandboxState {
  on: boolean;
  scope?: { worktreeRoots?: string[]; parent?: unknown };
}

/** What a chat's extension asks of the chat it runs in. */
export interface McpExtensionHooks {
  /** The list a chat with no list yet takes now; null: none, ever (a remote chat, a profile without servers). */
  list(cwd: string, sandboxOn: boolean): Promise<McpChatList | null>;
  /** A worker's failure, for the chat that started it. Absent in an ordinary chat. */
  tellParent?(note: McpNote): void;
  /** What this chat is called now, in a failure's row line and a worker's refusal: read when it's needed, since a
      chat's title comes after its first turn starts. */
  label(): string;
  /** Each copy's status as it changes. */
  onStatus?(status: McpServerStatus): void;
}

/** How long the first message waits for a list that changed since the chat opened to reach pi. */
const SWAP_WAIT_MS = 2_000;

const sameList = (a: McpChatList, b: McpChatList) => JSON.stringify(a) === JSON.stringify(b);

/** A chat's servers. One factory call per runtime, so each chat has its own copies. */
export function mcpExtension(hooks: McpExtensionHooks): { name: string; factory: (pi: PiExtensionAPI) => void } {
  return {
    name: "sova-mcp",
    factory: (pi: PiExtensionAPI) => {
      let sandbox: SandboxState = { on: false };
      let sessionId = "";
      let list: McpChatList = NO_MCP;
      let settled = false;
      const transports = new Set<SnapshotTransport>();
      const noted = new Set<string>();
      const toolWaiters = new Set<() => void>();

      pi.events?.on(SANDBOX_STATE_EVENT, (data: unknown) => {
        const next = data as { version?: unknown; on?: unknown; scope?: SandboxState["scope"] } | undefined;
        if (next?.version !== 1) return;
        const on = next.on === true;
        const changed = on !== sandbox.on;
        sandbox = { on, ...(next.scope ? { scope: next.scope } : {}) };
        // A copy runs under the state it started in; a change makes the next call start a new one.
        if (changed) for (const transport of transports) void transport.stopCopy();
      });

      const writeOnly = () => (sandbox.scope?.parent as { writeOnly?: unknown } | undefined)?.writeOnly === true;

      /** The call has failed already; this is the chat's note and the row's line, once until it works again. */
      const failed = (server: McpChatServer, how: McpNote["how"], reason: string) => {
        if (noted.has(server.name)) return;
        noted.add(server.name);
        const link: McpNote["link"] = server.owner.kind === "computer" ? { to: "settings", id: server.id } : { to: "project", projectId: server.owner.projectId, id: server.id };
        const clean = withoutSecrets(reason, secretValues(server.owner, server.name));
        const short = firstLines(clean);
        const note: McpNote = { server: server.name, how, ...(how === "failed" ? { reason: short } : {}), link };
        if (how !== "changed" && how !== "address-under-on") {
          const where: McpErrorLine["where"] = how === "sandbox" || how === "write-only" ? how : undefined;
          for (const line of clean.split("\n").filter(Boolean).slice(0, 6)) {
            try {
              addChatLine(server.owner, server.name, { line, chat: hooks.label(), ...(where ? { where } : {}) });
            } catch {
              // a line that can't be kept never fails the chat
            }
          }
        }
        // Write-only: the chat that started the worker reads it; a worker's own transcript has nobody reading.
        if (how === "write-only") hooks.tellParent?.({ ...note, worker: hooks.label() });
        else pi.appendEntry(MCP_NOTE_ENTRY, note);
      };

      const launchOf = (server: McpChatServer, cwd: string) => async (): Promise<Launch> => {
        // Every start checks the approval again, as the files stand now.
        const ready = readyToRun(server.owner, server.name);
        if (!ready.ok) throw new McpStartRefused(ready.how, ready.reason);
        const argv = [ready.entry.command!, ...(ready.entry.args ?? [])];
        const at = ready.cwd ?? cwd;
        if (!sandbox.on) return { argv, env: cleanMcpEnv(process.env, ready.entry.env), sandboxed: false, cwd: at, values: ready.values, dispose: async () => {} };
        const prepared = await prepareSessionCommand(
          { agentDir: agentRoot(), cwd: at, sessionId, ...(sandbox.scope?.worktreeRoots ? { worktreeRoots: sandbox.scope.worktreeRoots } : {}), ...(sandbox.scope?.parent ? { parent: sandbox.scope.parent as ParentScope } : {}) },
          argv,
          { env: ready.entry.env ?? {} },
        );
        if (!prepared.ok) throw new Error(`the sandbox can't run it: ${prepared.error}`);
        return { ...confinedLaunch(prepared.value, argv, ready.entry.env), sandboxed: true, cwd: at, values: ready.values };
      };

      const addressLaunch = (server: McpChatServer, authProvider: AddressLaunch["authProvider"], signedInTo: string | undefined) => (): AddressLaunch => {
        // It would be Sova's own process reaching out, past the sandbox's network limits.
        if (sandbox.on) throw new McpStartRefused("address-under-on", "address servers stay off while the sandbox is On");
        const ready = readyToRun(server.owner, server.name);
        if (!ready.ok) throw new McpStartRefused(ready.how, ready.reason);
        const { url, headers } = ready.entry;
        // A server moved since this chat opened: its sign-in belongs to the old address.
        const keepsAuth = authProvider && url === signedInTo;
        return { url: url!, headers: headers ?? {}, ...(keepsAuth ? { authProvider } : {}), values: addressValues(ready.entry, ready.values) };
      };

      const createTransport: McpTransportFactory = (entry, cwd, authProvider) => {
        // Only the chat's list runs: another extension's pi.registerMcpServer lands here too.
        const server = list.servers.find((s) => s.name === entry.name);
        if (!server) throw new Error(`MCP server "${entry.name}" isn't on this chat's list.`);
        const status: McpServerStatus = { name: entry.name, state: "idle", sandboxed: false, starts: 0 };
        const report = (patch: Partial<McpServerStatus>, how?: McpNote["how"]) => {
          Object.assign(status, patch);
          if (patch.state === "starting") status.starts++;
          if (patch.state === "running") noted.delete(entry.name);
          hooks.onStatus?.({ ...status });
          if (patch.state === "failed") {
            const inside = status.sandboxed || sandbox.on;
            failed(server, how ?? (inside ? (writeOnly() ? "write-only" : "sandbox") : "failed"), patch.error ?? "unknown error");
          }
        };
        const signedInTo = "url" in entry.config ? entry.config.url : undefined;
        const upstream = () => (server.kind === "address" ? new AddressServer(addressLaunch(server, authProvider, signedInTo)) : new StdioServer(launchOf(server, cwd), cwd));
        const transport = new SnapshotTransport(server.record, upstream, report, 60_000);
        transports.add(transport);
        transport.onClose(() => transports.delete(transport));
        return transport as unknown as McpTransport;
      };

      const inner = createMcpExtension({
        loadConfig: () => ({ autoEnableCodemode: false, errors: [], servers: [] }),
        createTransport,
        updateConfig: () => {},
        logPath: join(stateRoot(), "mcp.log"),
      });

      const toolsOf = new Map<string, Set<string>>();
      const listedTools = () => list.servers.flatMap((s) => [...(toolsOf.get(s.name) ?? [])]);

      const reach = (next: McpChatList) => {
        for (const s of list.servers) pi.unregisterMcpServer(s.name);
        list = next;
        for (const s of list.servers) if (!reservedName(s.name)) pi.registerMcpServer(s.name, mcpConfigOf(s));
      };

      // Before pi's own handlers below: what pi connects at session_start is what is registered by then.
      pi.on("session_start", async (_event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        pi.events?.emit(SANDBOX_DISCOVER_EVENT, { version: 1 });
        const branch = ctx.sessionManager.getBranch() as { type?: string; customType?: string; data?: unknown; message?: { role?: string } }[];
        const kept = branch.filter((e) => e.type === "custom" && e.customType === MCP_LIST_ENTRY).map((e) => normalizeChatList(e.data)).filter((l) => l !== null).pop();
        const begun = branch.some((e) => e.type === "message");
        settled = !!kept || begun;
        const next = kept ?? (begun ? NO_MCP : ((await hooks.list(ctx.cwd, sandbox.on).catch(() => null)) ?? NO_MCP));
        reach(next);
      });

      // Settled when the first message is sent: a server added since the chat opened counts.
      pi.on("before_agent_start", async (_event, ctx) => {
        // Another extension's setActiveTools from before a tool registered (strict mode's restore) doesn't drop it.
        const active = pi.getActiveTools();
        const lost = listedTools().filter((name) => !active.includes(name));
        if (lost.length) pi.setActiveTools([...active, ...lost]);
        if (settled) return;
        settled = true;
        const next = (await hooks.list(ctx.cwd, sandbox.on).catch(() => null)) ?? list;
        if (!sameList(next, list)) {
          const before = new Set(list.servers.map((s) => s.name));
          const expected = next.servers.filter((s) => !before.has(s.name)).length;
          let left = expected;
          const landed = new Promise<void>((resolve) => {
            const step = () => (--left <= 0 ? resolve() : undefined);
            if (expected) toolWaiters.add(step);
            else resolve();
          });
          reach(next);
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([landed, new Promise<void>((resolve) => (timer = setTimeout(resolve, SWAP_WAIT_MS)))]);
          clearTimeout(timer);
          toolWaiters.clear();
        }
        if (list.servers.length) pi.appendEntry(MCP_LIST_ENTRY, list);
      });

      // Workers take theirs from this chat's list (server/mcp/list.ts workerListOf).
      pi.events?.on(MCP_WORKERS_EVENT, (data: unknown) => {
        const ask = data as { version?: unknown; names?: string[]; reply?: (answer: { list: McpChatList } | { refused: string }) => void } | undefined;
        if (ask?.version === 1) ask.reply?.(workerListOf(list, ask.names ?? [], hooks.label()));
      });

      inner(tapped(pi, (name, tool) => {
        noteMcpTool(name, tool);
        toolsOf.set(tool.server, (toolsOf.get(tool.server) ?? new Set()).add(name));
      }, () => {
        for (const step of toolWaiters) step();
      }));
    },
  };
}

class McpStartRefused extends Error {
  constructor(readonly how: "changed" | "failed" | "address-under-on", reason: string) {
    super(reason);
  }
}

/** The event a chat's workers ask its list on (pi-config/extensions/subagents). */
export const MCP_WORKERS_EVENT = "sova:mcp-list";

/**
 * pi's extension with two things changed: `/mcp` stays out of a chat's composer (it would sign in and reconnect, and
 * those stay on the page), and each registered tool is told, by the server's name and the tool's.
 */
function tapped(pi: PiExtensionAPI, tool: (name: string, raw: McpToolName) => void, served: () => void): PiExtensionAPI {
  const label = /^(.+?)\/(.+)$/;
  let server = "";
  return new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "registerCommand") return (name: string, options: unknown) => (name === "mcp" ? undefined : (target.registerCommand as (n: string, o: unknown) => void)(name, options));
      if (key === "registerTool")
        return (definition: { name: string; label?: string }) => {
          const m = definition.label ? label.exec(definition.label) : null;
          if (m) tool(definition.name, { server: m[1]!, tool: m[2]! });
          (target.registerTool as (d: unknown) => void)(definition);
          if (m && m[1] !== server) {
            server = m[1]!;
            served();
          }
        };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** What the sandbox's backend sets for a confined command, which the server needs inside it. */
const BACKEND_ENV = /^(TMPDIR|GIT_CONFIG_SYSTEM|NODE_USE_ENV_PROXY|(https?|all|no)_proxy)$/i;

/**
 * A confined launch keeps to the clean environment too. The backend sets the sandbox's environment
 * inside, from its own allowlist (pi's per-call variables, the shell, the editor), so the rest is taken
 * out where the server starts. The command is the confined argv's tail on every backend.
 */
function confinedLaunch(prepared: PreparedSessionCommand, argv: readonly string[], own: Record<string, string> = {}): Omit<Launch, "sandboxed"> {
  const at = prepared.argv.length - argv.length;
  if (argv.some((part, i) => prepared.argv[at + i] !== part)) throw new Error("the sandbox changed the command");
  const unset = Object.keys(process.env).filter((key) => !ENV_ALLOW.test(key) && !BACKEND_ENV.test(key) && !(key in own));
  return {
    argv: [...prepared.argv.slice(0, at), "env", ...unset.flatMap((key) => ["-u", key]), ...argv],
    env: prepared.env,
    ...(prepared.fds ? { fds: prepared.fds } : {}),
    dispose: prepared.dispose,
  };
}

function firstLines(text: string | undefined): string {
  return (text ?? "unknown error").split("\n").slice(0, 3).join(" ");
}
