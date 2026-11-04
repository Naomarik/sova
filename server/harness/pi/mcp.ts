// MCP servers in Sova chats: the proof step (§app/mcp draft, tmp/mcp-proof.md). pi's own MCP extension
// (createMcpExtension) carries the tools through pi's pipeline; Sova holds its two seams:
// - `loadConfig`: Sova's approved set, every server `direct`, so pi's own reading of mcp.json and a
//   repository's .pi/mcp.json never happens;
// - `createTransport`: pi connects every server at session_start and declares what it lists. Sova hands
//   it a transport that answers the handshake and `tools/list` from the server's Check record and starts
//   the real server at the first call, so a late connect can't change the declared list and a chat that
//   never calls a server runs nothing for it (`SnapshotTransport`).
// Workers, hidden chats and special loadouts don't get this factory. No screen, route or trust store
// reads this yet: the approved set is a file the proof writes by hand.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMcpExtension,
  type LoadedMcpConfig,
  type McpServerEntry,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import { prepareSessionCommand, type PreparedSessionCommand } from "../../../pi-config/extensions/sandbox/session-policy.ts";
import { SANDBOX_DISCOVER_EVENT, SANDBOX_STATE_EVENT } from "../../../pi-config/extensions/sandbox/state.ts";
import { agentRoot, stateRoot } from "../../state-root";
import type { PiExtensionAPI, PiExtensionFactory } from "./extension-types";

type McpTransport = ReturnType<McpTransportFactory>;
type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: unknown };

/** What a Check recorded: the handshake's answer and the tools, in the server's own shape. */
export interface McpCheckRecord {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  instructions?: string;
  tools: { name: string; description?: string; inputSchema: Record<string, unknown>; [key: string]: unknown }[];
}

export interface ApprovedMcpServer {
  name: string;
  /** A command server. Address servers don't run in a chat yet: pi's HTTP transport isn't reachable from here. */
  command: string;
  args?: string[];
  /** Literal values only: nothing here is expanded or run. */
  env?: Record<string, string>;
  /** Seconds a request may take (pi's default, 60). */
  timeout?: number;
  record: McpCheckRecord;
}

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

/** The proof's approved set: `<state root>/mcp-approved.json`. */
export const mcpApprovedPath = () => join(stateRoot(), "mcp-approved.json");

/**
 * `sova`, in any case, is Sova's own: its tools reach a Claude Code chat under the MCP server `sova`, so
 * a server of that name would give a chat two tools that read alike, `mcp__sova__read` for pi's `read`
 * and `mcp__sova__mcp__sova__read` for the server's. The provider's prefix strip (`toPiToolName`) tells
 * them apart on the real CLI; a fold's plain text and the model can't.
 */
export function reservedMcpServerName(name: string): boolean {
  return name.toLowerCase() === "sova";
}

/** The approved set the proof reads. Everything refused is a line of `errors`, which pi reports once. */
function readApproved(): { servers: ApprovedMcpServer[]; errors: string[] } {
  const path = mcpApprovedPath();
  if (!existsSync(path)) return { servers: [], errors: [] };
  let parsed: { servers?: ApprovedMcpServer[] };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { servers: [], errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const servers: ApprovedMcpServer[] = [];
  const errors: string[] = [];
  for (const server of parsed.servers ?? []) {
    if (reservedMcpServerName(server.name)) errors.push(`MCP server "${server.name}" can't run: the name is Sova's own.`);
    else if (!server.command) errors.push(`MCP server "${server.name}" can't run in a chat: only command servers do so far.`);
    else if (!server.record) errors.push(`MCP server "${server.name}" has no Check record.`);
    else servers.push(server);
  }
  return { servers, errors };
}

/** The approved set as pi's config: every tool declared, nothing of pi's own config reading. */
export function mcpConfigOf(servers: readonly ApprovedMcpServer[], errors: readonly string[] = []): LoadedMcpConfig {
  return {
    autoEnableCodemode: false,
    errors: [...errors],
    servers: servers.map((server): McpServerEntry => ({
      name: server.name,
      source: mcpApprovedPath(),
      scope: "global",
      config: {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.timeout ? { timeout: server.timeout } : {}),
        exposure: "direct",
      },
    })),
  };
}

/** The basics a program needs. Everything else in Sova's environment stays out. */
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TEMP|TMP)$/;

export function cleanMcpEnv(source: NodeJS.ProcessEnv, own: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && ENV_ALLOW.test(key)) env[key] = value;
  return { ...env, ...own };
}

abstract class Events {
  private messages = new Set<(message: JsonRpc) => void>();
  private errors = new Set<(error: Error) => void>();
  private closes = new Set<() => void>();
  private closeSent = false;
  onMessage(listener: (message: JsonRpc) => void) {
    this.messages.add(listener);
    return () => void this.messages.delete(listener);
  }
  onError(listener: (error: Error) => void) {
    this.errors.add(listener);
    return () => void this.errors.delete(listener);
  }
  onClose(listener: () => void) {
    this.closes.add(listener);
    return () => void this.closes.delete(listener);
  }
  protected emitMessage(message: JsonRpc) {
    for (const listener of [...this.messages]) listener(message);
  }
  protected emitError(error: Error) {
    for (const listener of [...this.errors]) listener(error);
  }
  protected emitClose() {
    if (this.closeSent) return;
    this.closeSent = true;
    for (const listener of [...this.closes]) listener();
  }
}

interface Launch {
  argv: string[];
  env: Record<string, string>;
  fds?: { fd: number; data: string }[];
  sandboxed: boolean;
  dispose(): Promise<void>;
}

const STDERR_TAIL = 2_000;
const STOP_GRACE_MS = 500;
const live = new Set<number>();
let exitHook = false;

/** One server process on newline-delimited JSON-RPC. pi's own transport can't hand a confined launch its fds. */
export class StdioServer extends Events {
  private child: ChildProcess | undefined;
  private buffer = Buffer.alloc(0);
  private ended = false;
  stderr = "";
  constructor(private readonly launch: () => Promise<Launch>, private readonly cwd: string) {
    super();
  }
  get pid() {
    return this.child?.pid;
  }
  sandboxed = false;
  private disposeLaunch: (() => Promise<void>) | undefined;

  async start(): Promise<void> {
    const launch = await this.launch();
    this.sandboxed = launch.sandboxed;
    this.disposeLaunch = launch.dispose;
    const fds = launch.fds ?? [];
    const stdio: ("pipe" | "ignore")[] = ["pipe", "pipe", "pipe"];
    for (const f of fds) {
      while (stdio.length <= f.fd) stdio.push("ignore");
      stdio[f.fd] = "pipe";
    }
    const child = spawn(launch.argv[0]!, launch.argv.slice(1), { cwd: this.cwd, env: launch.env, stdio, detached: process.platform !== "win32" });
    this.child = child;
    for (const f of fds) (child.stdio[f.fd] as NodeJS.WritableStream | undefined)?.end(f.data);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    }).catch(async (error) => {
      await this.disposeLaunch?.();
      throw error;
    });
    const pid = child.pid;
    if (pid !== undefined) {
      live.add(pid);
      if (!exitHook) {
        exitHook = true;
        process.once("exit", () => {
          for (const group of live) try { process.kill(-group, "SIGTERM"); } catch { /* gone */ }
        });
      }
    }
    child.stdout!.on("data", (chunk: Buffer) => this.read(chunk));
    child.stderr!.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL); });
    child.stdin!.on("error", () => {});
    child.on("close", () => {
      if (pid !== undefined) live.delete(pid);
      void this.disposeLaunch?.();
      this.child = undefined;
      this.emitClose();
    });
  }

  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      try {
        this.emitMessage(JSON.parse(line) as JsonRpc);
      } catch (error) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  async send(message: JsonRpc): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new Error("the server isn't running");
    await new Promise<void>((resolve, reject) => stdin.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve())));
  }

  /** Stdin first, as the spec asks, then the whole process group: wrappers like npx leave the server behind. */
  async close(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const child = this.child;
    if (!child?.pid) return;
    const pid = child.pid;
    await new Promise<void>((resolve) => {
      const kill = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { /* gone */ } };
      const term = setTimeout(() => kill("SIGTERM"), STOP_GRACE_MS);
      const hard = setTimeout(() => kill("SIGKILL"), STOP_GRACE_MS * 4);
      child.once("close", () => {
        clearTimeout(term);
        clearTimeout(hard);
        kill("SIGTERM");
        resolve();
      });
      child.stdin?.end();
    });
  }
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
  private upstream: StdioServer | undefined;
  private starting: Promise<StdioServer> | undefined;
  private initializeParams: unknown;
  private pending = new Set<string | number>();
  private closed = false;

  constructor(
    private readonly record: McpCheckRecord,
    private readonly start_: () => StdioServer,
    private readonly status: (patch: Partial<McpServerStatus>) => void,
    private readonly requestTimeoutMs: number,
  ) {
    super();
  }

  async start(): Promise<void> {}

  private reply(id: JsonRpc["id"], result: unknown) {
    queueMicrotask(() => this.emitMessage({ jsonrpc: "2.0", id, result }));
  }
  private fail(id: JsonRpc["id"], message: string) {
    queueMicrotask(() => this.emitMessage({ jsonrpc: "2.0", id, error: { code: SERVER_ERROR, message } }));
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
      this.pending.delete(id);
      this.fail(id, error instanceof Error ? error.message : String(error));
    }
  }

  private running(): Promise<StdioServer> {
    if (this.upstream) return Promise.resolve(this.upstream);
    this.starting ??= this.open().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async open(): Promise<StdioServer> {
    const server = this.start_();
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
      this.emitMessage(message);
    });
    server.onError((error) => this.emitError(error));
    server.onClose(() => {
      const wasUp = up;
      this.upstream = undefined;
      if (this.closed) return;
      const reason = describe(wasUp ? "the server exited" : "the server exited while starting");
      this.status({ state: wasUp ? "exited" : "failed", pid: undefined, error: reason });
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
      this.status({ state: "failed", pid: undefined, error: message });
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
    await this.upstream?.close();
    this.upstream = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stopCopy();
    this.emitClose();
  }
}

interface SandboxState {
  on: boolean;
}

export interface McpExtensionHooks {
  /** Each copy's status as it changes: what a chat's note and a row's error lines read. */
  onStatus?(status: McpServerStatus): void;
}

/** A chat's servers. One factory call per runtime, so each chat has its own copies. */
export function mcpExtension(hooks: McpExtensionHooks = {}): PiExtensionFactory {
  return {
    name: "sova-mcp",
    factory: (pi: PiExtensionAPI) => {
      let sandbox: SandboxState = { on: false };
      let sessionId = "";
      let notify: (message: string) => void = () => {};
      const transports = new Set<SnapshotTransport>();
      let approved = new Map<string, ApprovedMcpServer>();

      pi.events?.on(SANDBOX_STATE_EVENT, (data: unknown) => {
        const next = data as { version?: unknown; on?: unknown } | undefined;
        if (next?.version !== 1) return;
        const on = next.on === true;
        const changed = on !== sandbox.on;
        sandbox = { on };
        // A copy runs under the state it started in; a change makes the next call start a new one.
        if (changed) for (const transport of transports) void transport.stopCopy();
      });

      const launchOf = (server: ApprovedMcpServer, cwd: string) => async (): Promise<Launch> => {
        const argv = [server.command, ...(server.args ?? [])];
        const env = cleanMcpEnv(process.env, server.env);
        if (!sandbox.on) return { argv, env, sandboxed: false, dispose: async () => {} };
        const prepared = await prepareSessionCommand({ agentDir: agentRoot(), cwd, sessionId }, argv, { env: server.env ?? {} });
        if (!prepared.ok) throw new Error(`the sandbox can't run it: ${prepared.error}`);
        return { ...confinedLaunch(prepared.value, argv, server.env), sandboxed: true };
      };

      const createTransport: McpTransportFactory = (entry, cwd) => {
        // Only the approved set runs: another extension's pi.registerMcpServer lands here too.
        const server = entry.scope === "global" ? approved.get(entry.name) : undefined;
        if (!server) throw new Error(`MCP server "${entry.name}" isn't approved in Sova.`);
        const status: McpServerStatus = { name: entry.name, state: "idle", sandboxed: false, starts: 0 };
        const report = (patch: Partial<McpServerStatus>) => {
          // One failed start reaches here twice, from the process's exit and from the start's own failure.
          const newly = patch.state === "failed" && status.state !== "failed";
          Object.assign(status, patch);
          if (patch.state === "starting") status.starts++;
          hooks.onStatus?.({ ...status });
          if (newly) notify(`MCP server "${entry.name}" failed: ${firstLines(patch.error)}`);
        };
        const transport = new SnapshotTransport(
          server.record,
          () => new StdioServer(launchOf(server, cwd), cwd),
          report,
          (server.timeout ?? 60) * 1000,
        );
        transports.add(transport);
        transport.onClose(() => transports.delete(transport));
        return transport as unknown as McpTransport;
      };

      createMcpExtension({
        loadConfig: () => {
          const { servers, errors } = readApproved();
          approved = new Map(servers.map((server) => [server.name, server]));
          return mcpConfigOf(servers, errors);
        },
        createTransport,
        updateConfig: () => {},
        logPath: join(stateRoot(), "mcp.log"),
      })(hideMcpCommand(pi));

      pi.on("session_start", (_event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        notify = (message) => ctx.ui.notify(message, "warning");
        pi.events?.emit(SANDBOX_DISCOVER_EVENT, { version: 1 });
      });
    },
  };
}

/** `/mcp` would sign in and reconnect from the composer, and those stay on the page. */
function hideMcpCommand(pi: PiExtensionAPI): PiExtensionAPI {
  return new Proxy(pi, {
    get(target, key, receiver) {
      if (key === "registerCommand") return (name: string, options: unknown) => (name === "mcp" ? undefined : (target.registerCommand as (n: string, o: unknown) => void)(name, options));
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
