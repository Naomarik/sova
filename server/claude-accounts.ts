import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
// The claude-code extension's own registry (node built-ins only): the file, each login's
// directory, this host's standing of each login and the order. See CLAUDE.md.
import {
  ClaudeLogins,
  DEFAULT_LOGIN_ID,
  LOCAL_DEVICE_ID,
  assignedHere,
  claudeJsonPath,
  clearStanding,
  credentialsMtime,
  ensureLoginDir,
  isLoginId,
  loginDir,
  newLoginId,
  planLabel,
  readAccounts,
  readAccountsState,
  readIdentityFile,
  readIdentityFromStatus,
  updateAccounts,
  type ClaudeAccountsFile,
  type ClaudeLoginIdentity,
} from "../pi-config/extensions/claude-code/accounts.ts";
import type { ClaudeLoginIdentity as WireIdentity } from "../shared/protocol";
import type { ClaudeAccountsInfo, ClaudeLoginFlowState, ClaudeLoginRow } from "../shared/protocol";
import { readPeers } from "./mesh/peers";
import { poolAgent } from "./claude-pool";
import type { PoolAgent } from "./claude-pool/agent";

// Settings → Accounts (§app.claude-logins): this host's Claude logins, their order, and adding
// one by driving Claude Code's own `claude auth login` for a new directory, with no terminal.
// Claude Code signs in, refreshes and signs out; this file never reads a token, and never sends
// the browser anything but identities, standings and the authorize URL.

/** Variables that would sign a spawn in with something else than the login's directory. */
const OVERRIDES = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];
const URL_TIMEOUT_MS = 20_000;
const FINISH_TIMEOUT_MS = 60_000;
const FLOW_TIMEOUT_MS = 10 * 60_000;
const LOGOUT_TIMEOUT_MS = 15_000;
const MAX_CODE = 2048;
const MAX_LABEL = 80;

export interface ClaudeAccountsOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  now?: () => number;
  /** Test seam: timeouts. */
  timeouts?: Partial<{ url: number; finish: number; flow: number; logout: number }>;
  /** The pool agent while the mesh is on (server/claude-pool); test seam. */
  pool?: () => PoolAgent | null;
}

interface Flow {
  id: string;
  dir: string;
  /** Signing an existing login in again: its id (the flow runs in a fresh directory, moved over on success). */
  target?: string;
  child: ChildProcess;
  state: ClaudeLoginFlowState;
  stdout: string;
  stderr: string;
  timer: ReturnType<typeof setTimeout>;
  exited: Promise<number | null>;
  /** Whoever waits on the next state change. */
  waiters: Set<() => void>;
}

/** An identity as the browser gets it: with the plan as people say it ("Max 20x"), never the raw billing type alone. */
export function wireIdentity(identity: ClaudeLoginIdentity | null): WireIdentity | null {
  if (!identity) return null;
  const label = planLabel(identity);
  return label ? { ...identity, planLabel: label } : { ...identity };
}

export type ServiceResult = { status: 200; body: ClaudeAccountsInfo | ClaudeLoginFlowState } | { status: 400 | 404 | 409; body: { error: string } };

export class ClaudeAccountsService {
  private readonly agentDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly executable: string;
  private readonly timeouts: { url: number; finish: number; flow: number; logout: number };
  private readonly logins: ClaudeLogins;
  private readonly pool: () => PoolAgent | null;
  private flow: Flow | null = null;

  constructor(options: ClaudeAccountsOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.env = options.env ?? process.env;
    this.executable = options.executable ?? "claude";
    this.timeouts = { url: URL_TIMEOUT_MS, finish: FINISH_TIMEOUT_MS, flow: FLOW_TIMEOUT_MS, logout: LOGOUT_TIMEOUT_MS, ...options.timeouts };
    this.logins = new ClaudeLogins({ agentDir: this.agentDir, env: this.env, ...(options.now ? { now: options.now } : {}) });
    this.pool = options.pool ?? poolAgent;
  }

  // -- reading -------------------------------------------------------------------------------

  private deviceLabel(device: string): string {
    if (device === LOCAL_DEVICE_ID) return "This device";
    const peers = readPeers(join(this.agentDir, "sova", "peers.json"));
    return peers.ok && peers.config.self.id === device ? peers.config.self.label : device;
  }

  private row(id: string, accounts: ClaudeAccountsFile): ClaudeLoginRow {
    const record = accounts.logins.find((l) => l.id === id);
    const state = readAccountsState(this.agentDir);
    const readiness = this.logins.readinessOf(id, state);
    const standing: ClaudeLoginRow["standing"] =
      readiness.state === "limited" ? { state: "limited", until: readiness.until, ...(readiness.window ? { window: readiness.window } : {}) }
      : readiness.state === "auth" ? { state: "auth", ...(readiness.message ? { message: readiness.message } : {}) }
      : { state: "ready" };
    return {
      id,
      ...(record?.label ? { label: record.label } : {}),
      identity: wireIdentity(this.logins.identityOf(id, accounts)),
      enabled: id === DEFAULT_LOGIN_ID ? (accounts.devices[this.logins.device] ?? accounts.devices[LOCAL_DEVICE_ID])?.defaultEnabled !== false : record?.enabled === true,
      standing,
      signedIn: credentialsMtime(this.logins.dirOf(id)) !== undefined,
      ...(record ? { addedAt: record.addedAt } : {}),
    };
  }

  info(): ClaudeAccountsInfo {
    const read = readAccounts(this.agentDir);
    const accounts = read.value;
    const device = this.logins.device;
    return {
      device: { id: device, label: this.deviceLabel(device) },
      logins: this.logins.order(accounts).map((id) => this.row(id, accounts)),
      elsewhere: accounts.logins
        .filter((l) => !assignedHere(l.device, device))
        .map((l) => ({ id: l.id, device: l.device, ...(l.label ? { label: l.label } : {}), identity: wireIdentity(l.identity) })),
      ...(read.state === "malformed" ? { error: `${read.file}: ${read.errors.join("; ")}` } : {}),
      flow: this.flow?.state ?? null,
      ...(this.pool() ? { pool: this.pool()!.view() } : {}),
    };
  }

  /** A login of the pool (mesh on) that this device does not hold: changed through the pool document. */
  private inPoolOnly(id: string): boolean {
    const pool = this.pool();
    return !!pool && !!pool.doc().logins[id] && !this.logins.order().includes(id);
  }

  /** The login this host's next new chat runs on: the first usable one in its order (nothing is touched). */
  inUse(): string {
    return this.logins.selectId();
  }

  /** A login's directory (Claude Code's own for `default`). */
  dirOf(id: string): string {
    return this.logins.dirOf(id);
  }

  // -- changing ------------------------------------------------------------------------------

  /** Change the registry for this device; a device entry kept under `local` moves to the mesh id. */
  private change(fn: (accounts: ClaudeAccountsFile, device: string) => void): ServiceResult {
    const device = this.logins.device;
    try {
      updateAccounts(this.agentDir, (accounts) => {
        if (device !== LOCAL_DEVICE_ID && accounts.devices[LOCAL_DEVICE_ID] && !accounts.devices[device]) {
          accounts.devices[device] = accounts.devices[LOCAL_DEVICE_ID]!;
          delete accounts.devices[LOCAL_DEVICE_ID];
        }
        fn(accounts, device);
      });
    } catch (error) {
      return { status: 409, body: { error: (error as Error).message } };
    }
    return { status: 200, body: this.info() };
  }

  setOrder(body: unknown): ServiceResult {
    const order = (body as { order?: unknown } | null)?.order;
    if (!Array.isArray(order) || order.some((id) => typeof id !== "string")) return { status: 400, body: { error: "Expected { order: string[] }" } };
    const current = this.logins.order();
    if (order.length !== current.length || new Set(order).size !== order.length || order.some((id) => !current.includes(id))) {
      return { status: 400, body: { error: "The order must list exactly this device's logins, each once" } };
    }
    return this.change((accounts, device) => {
      accounts.devices[device] = { ...accounts.devices[device], order: [...(order as string[])] };
    });
  }

  patch(id: string, body: unknown): ServiceResult {
    const b = (body ?? {}) as { enabled?: unknown; label?: unknown };
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") return { status: 400, body: { error: "enabled must be true or false" } };
    if (b.label !== undefined && b.label !== null && (typeof b.label !== "string" || b.label.length > MAX_LABEL)) return { status: 400, body: { error: `label must be a string of at most ${MAX_LABEL}` } };
    if (this.inPoolOnly(id)) {
      const pool = this.pool()!;
      if (typeof b.enabled === "boolean") pool.setEnabled(id, b.enabled);
      if (b.label !== undefined) pool.setLabel(id, typeof b.label === "string" && b.label.trim() ? b.label.trim() : null);
      return { status: 200, body: this.info() };
    }
    if (!this.logins.order().includes(id)) return { status: 404, body: { error: "No such login on this device" } };
    if (id === DEFAULT_LOGIN_ID && b.label !== undefined) return { status: 400, body: { error: "The default login takes no label" } };
    if (id !== DEFAULT_LOGIN_ID) {
      const pool = this.pool();
      if (pool?.doc().logins[id]) {
        if (typeof b.enabled === "boolean") pool.setEnabled(id, b.enabled);
        if (b.label !== undefined) pool.setLabel(id, typeof b.label === "string" && b.label.trim() ? b.label.trim() : null);
      }
    }
    return this.change((accounts, device) => {
      if (id === DEFAULT_LOGIN_ID) {
        if (typeof b.enabled === "boolean") accounts.devices[device] = { order: this.logins.order(accounts), ...accounts.devices[device], defaultEnabled: b.enabled };
        return;
      }
      const login = accounts.logins.find((l) => l.id === id)!;
      if (typeof b.enabled === "boolean") login.enabled = b.enabled;
      if (b.label !== undefined) {
        const label = typeof b.label === "string" ? b.label.trim() : "";
        if (label) login.label = label;
        else delete login.label;
      }
    });
  }

  clear(id: string): ServiceResult {
    if (this.inPoolOnly(id)) {
      this.pool()!.clearStanding(id);
      return { status: 200, body: this.info() };
    }
    if (!this.logins.order().includes(id)) return { status: 404, body: { error: "No such login on this device" } };
    try {
      if (id !== DEFAULT_LOGIN_ID) this.pool()?.clearStanding(id);
      clearStanding(this.agentDir, id);
    } catch (error) {
      return { status: 409, body: { error: (error as Error).message } };
    }
    return { status: 200, body: this.info() };
  }

  /** `claude auth logout` in its directory (bounded; its failure does not stop the removal), then the directory and the record. */
  async remove(id: string): Promise<ServiceResult> {
    if (id === DEFAULT_LOGIN_ID) return { status: 400, body: { error: "The default login cannot be removed" } };
    const pool = this.pool();
    const here = isLoginId(id) && readAccounts(this.agentDir).value.logins.some((l) => l.id === id);
    // In the pool: removed everywhere. The device that has it deletes its copy (after stopping
    // every process on it), as plain files; a copy here is signed out and deleted right now.
    if (pool && isLoginId(id) && pool.doc().logins[id]) {
      pool.remove(id);
      if (!here) return { status: 200, body: this.info() };
    }
    if (!here) return { status: 404, body: { error: "No such login" } };
    const dir = loginDir(this.agentDir, id);
    if (existsSync(join(dir, ".credentials.json"))) await this.run(["auth", "logout"], dir, this.timeouts.logout);
    const result = this.change((accounts) => {
      accounts.logins = accounts.logins.filter((l) => l.id !== id);
      for (const entry of Object.values(accounts.devices)) entry.order = entry.order.filter((x) => x !== id);
    });
    if (result.status !== 200) return result;
    rmSync(dir, { recursive: true, force: true });
    try { clearStanding(this.agentDir, id); } catch { /* nothing recorded */ }
    return { status: 200, body: this.info() };
  }

  private childEnv(dir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env, CLAUDE_CONFIG_DIR: dir, BROWSER: "true" };
    for (const name of OVERRIDES) delete env[name];
    return env;
  }

  private run(args: string[], dir: string, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(this.executable, args, { env: this.childEnv(dir), stdio: ["ignore", "ignore", "ignore"], shell: false });
      } catch {
        return resolve(null);
      }
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, timeoutMs);
      child.once("error", () => { clearTimeout(timer); resolve(null); });
      child.once("close", (code) => { clearTimeout(timer); resolve(code); });
    });
  }

  // -- the add-login flow ----------------------------------------------------------------------

  private setFlow(flow: Flow, state: ClaudeLoginFlowState): void {
    if (this.flow !== flow) return;
    flow.state = state;
    for (const wake of [...flow.waiters]) wake();
  }

  private waitFor(flow: Flow, done: (state: ClaudeLoginFlowState) => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (done(flow.state) || this.flow !== flow) return resolve();
      const timer = setTimeout(finish, ms);
      function finish() { clearTimeout(timer); flow.waiters.delete(check); resolve(); }
      const check = () => { if (done(flow.state)) finish(); };
      flow.waiters.add(check);
    });
  }

  private endFlow(flow: Flow, state: ClaudeLoginFlowState, keepDir = false): void {
    clearTimeout(flow.timer);
    if (flow.child.exitCode === null && !flow.child.killed) flow.child.kill("SIGKILL");
    if (!keepDir) rmSync(flow.dir, { recursive: true, force: true });
    this.setFlow(flow, state);
  }

  /** Start `claude auth login` for a new directory, and answer once its URL is out (or it failed). */
  async startFlow(body?: unknown): Promise<ServiceResult> {
    const running = this.flow && ["starting", "waiting", "finishing"].includes(this.flow.state.state);
    if (running) return { status: 409, body: { error: "A sign-in is already in progress; finish or cancel it first" } };
    if (readAccounts(this.agentDir).state === "malformed") return { status: 409, body: { error: "The Claude accounts file is malformed; fix it before adding a login" } };
    // Sign an existing login in again (§app.claude-logins/stuck): one of the pool, or one here.
    const target = (body as { login?: unknown } | null | undefined)?.login;
    if (target !== undefined) {
      const known = isLoginId(target) && (!!this.pool()?.doc().logins[target] || readAccounts(this.agentDir).value.logins.some((l) => l.id === target));
      if (!known) return { status: 404, body: { error: "No such login" } };
    }
    const id = newLoginId();
    let dir: string;
    try {
      dir = ensureLoginDir(this.agentDir, id, this.logins.defaultDir);
    } catch (error) {
      return { status: 409, body: { error: `Could not create the login's directory: ${(error as Error).message}` } };
    }
    let child: ChildProcess;
    try {
      child = spawn(this.executable, ["auth", "login", "--claudeai"], { env: this.childEnv(dir), stdio: ["pipe", "pipe", "pipe"], shell: false });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      return { status: 409, body: { error: `Could not run the Claude Code CLI: ${(error as Error).message}` } };
    }
    const flow: Flow = {
      id, dir, child, state: { state: "starting" }, stdout: "", stderr: "",
      ...(typeof target === "string" ? { target } : {}),
      timer: setTimeout(() => this.endFlow(flow, { state: "failed", error: "The sign-in was left alone for 10 minutes and was cancelled" }), this.timeouts.flow),
      exited: new Promise((resolve) => { child.once("close", (code) => resolve(code)); child.once("error", () => resolve(null)); }),
      waiters: new Set(),
    };
    this.flow = flow;
    child.stdin?.on("error", () => { /* the process is gone; close reports it */ });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (flow.stdout.length < 16_384) flow.stdout += chunk.toString();
      const url = /visit: (https:\/\/\S+)/.exec(flow.stdout)?.[1];
      if (url && flow.state.state === "starting") this.setFlow(flow, { state: "waiting", url });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (flow.stderr.length < 16_384) flow.stderr += chunk.toString();
      // A code in the wrong shape: the CLI says so and keeps waiting for another.
      if (/Invalid code/i.test(chunk.toString()) && (flow.state.state === "finishing" || flow.state.state === "waiting")) {
        const url = /visit: (https:\/\/\S+)/.exec(flow.stdout)?.[1] ?? "";
        this.setFlow(flow, { state: "waiting", url, error: "Claude Code did not accept that code. Copy the whole code the page shows and try again." });
      }
    });
    child.once("error", (error) => this.endFlow(flow, { state: "failed", error: `Could not run the Claude Code CLI: ${error.message}` }));
    child.once("close", (code) => { void this.flowExited(flow, code); });
    await this.waitFor(flow, (s) => s.state !== "starting", this.timeouts.url);
    if (flow.state.state === "starting") this.endFlow(flow, { state: "failed", error: "Claude Code did not print a sign-in URL" });
    return { status: 200, body: flow.state };
  }

  /** Send the code the page showed; answer once the CLI finished (or refused it). */
  async submitCode(body: unknown): Promise<ServiceResult> {
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !code.trim() || code.length > MAX_CODE || /[\x00-\x1f\x7f]/.test(code.trim())) {
      return { status: 400, body: { error: "Expected { code } as the one line the sign-in page shows" } };
    }
    const flow = this.flow;
    if (!flow || flow.state.state !== "waiting") return { status: 409, body: { error: "No sign-in is waiting for a code" } };
    const url = flow.state.url;
    this.setFlow(flow, { state: "finishing" });
    if (!flow.child.stdin?.write(`${code.trim()}\n`) && flow.child.stdin?.destroyed) {
      this.endFlow(flow, { state: "failed", error: "The Claude Code CLI is no longer running" });
      return { status: 200, body: flow.state };
    }
    await this.waitFor(flow, (s) => s.state !== "finishing", this.timeouts.finish);
    if ((flow.state as ClaudeLoginFlowState).state === "finishing") this.setFlow(flow, { state: "waiting", url, error: "Claude Code has not finished signing in yet; wait a moment, or cancel and try again" });
    return { status: 200, body: flow.state };
  }

  cancelFlow(): ServiceResult {
    const flow = this.flow;
    if (flow && ["starting", "waiting", "finishing"].includes(flow.state.state)) this.endFlow(flow, { state: "failed", error: "Cancelled" });
    this.flow = null;
    return { status: 200, body: this.info() };
  }

  private async flowExited(flow: Flow, code: number | null): Promise<void> {
    if (this.flow !== flow || flow.state.state === "failed" || flow.state.state === "done") return;
    clearTimeout(flow.timer);
    const signedIn = credentialsMtime(flow.dir) !== undefined;
    if (code !== 0 || !signedIn) {
      const reason = /Login failed: ([^\n]+)/.exec(flow.stderr)?.[1]?.trim() ?? (code === 0 ? "Claude Code wrote no credentials" : `Claude Code exited (${code ?? "killed"})`);
      this.endFlow(flow, { state: "failed", error: reason.slice(0, 300) });
      return;
    }
    const identity: ClaudeLoginIdentity | null = readIdentityFile(claudeJsonPath(flow.dir, false)) ?? readIdentityFromStatus(flow.dir, this.executable);
    if (flow.target) { this.signedInAgain(flow, flow.target, identity); return; }
    const existing = readAccounts(this.agentDir).value;
    const sharedAccount = !!identity?.accountUuid && (
      existing.logins.some((l) => l.identity?.accountUuid === identity.accountUuid)
      || this.logins.identityOf(DEFAULT_LOGIN_ID, existing)?.accountUuid === identity.accountUuid
    );
    const result = this.change((accounts, device) => {
      accounts.logins.push({ id: flow.id, addedAt: Date.now(), enabled: true, device, identity });
      const order = accounts.devices[device]?.order ?? this.logins.order(accounts).filter((x) => x !== flow.id);
      accounts.devices[device] = { ...accounts.devices[device], order: [...order.filter((x) => x !== flow.id), flow.id] };
    });
    if (result.status !== 200) {
      this.endFlow(flow, { state: "failed", error: (result.body as { error: string }).error });
      return;
    }
    this.pool()?.addedHere(flow.id, { identity, addedAt: Date.now() });
    const row = this.row(flow.id, readAccounts(this.agentDir).value);
    this.endFlow(flow, { state: "done", login: row, sharedAccount }, true);
  }

  /**
   * An existing login signed in again here: its fresh credentials replace whatever copy this
   * device had, and this device holds it now. In the pool, a device that still has an old copy
   * (the one it was stuck on) deletes it when it comes back.
   */
  private signedInAgain(flow: Flow, target: string, identity: ClaudeLoginIdentity | null): void {
    try {
      const dir = ensureLoginDir(this.agentDir, target, this.logins.defaultDir);
      for (const name of [".credentials.json", ".claude.json"]) {
        if (existsSync(join(flow.dir, name))) renameSync(join(flow.dir, name), join(dir, name));
      }
    } catch (error) {
      this.endFlow(flow, { state: "failed", error: `Could not store the new sign-in: ${(error as Error).message}` });
      return;
    }
    const pooled = this.pool()?.doc().logins[target];
    const result = this.change((accounts, device) => {
      const login = accounts.logins.find((l) => l.id === target);
      if (login) {
        login.device = device;
        if (identity) login.identity = identity;
      } else {
        accounts.logins.push({ id: target, addedAt: pooled?.addedAt ?? Date.now(), enabled: true, device, identity: identity ?? pooled?.identity ?? null, ...(pooled?.label.value ? { label: pooled.label.value } : {}) });
      }
    });
    if (result.status !== 200) {
      this.endFlow(flow, { state: "failed", error: (result.body as { error: string }).error });
      return;
    }
    try { clearStanding(this.agentDir, target); } catch { /* nothing recorded */ }
    this.pool()?.addedHere(target, { identity, addedAt: pooled?.addedAt ?? Date.now() });
    const row = this.row(target, readAccounts(this.agentDir).value);
    this.endFlow(flow, { state: "done", login: row, sharedAccount: false });
  }

  /** Stop a running flow on shutdown, leaving nothing behind. */
  dispose(): void {
    if (this.flow && ["starting", "waiting", "finishing"].includes(this.flow.state.state)) this.endFlow(this.flow, { state: "failed", error: "Sova is shutting down" });
  }
}

/** The environment a server-side `claude` spawn runs with: this host's first usable login. */
export function claudeLoginEnv(): Record<string, string> {
  try {
    return new ClaudeLogins({ agentDir: getAgentDir() }).select().env;
  } catch {
    return {};
  }
}

async function json(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function registerClaudeAccountRoutes(app: Hono, service = new ClaudeAccountsService()): ClaudeAccountsService {
  const send = (c: any, r: ServiceResult) => c.json(r.body, r.status, { "Cache-Control": "no-store" });
  app.get("/api/claude/accounts", (c) => c.json(service.info(), 200, { "Cache-Control": "no-store" }));
  app.post("/api/claude/accounts/flow", async (c) => send(c, await service.startFlow(await json(c))));
  app.post("/api/claude/accounts/flow/code", async (c) => send(c, await service.submitCode(await json(c))));
  app.delete("/api/claude/accounts/flow", (c) => send(c, service.cancelFlow()));
  app.put("/api/claude/accounts/order", async (c) => send(c, service.setOrder(await json(c))));
  app.patch("/api/claude/accounts/:id", async (c) => send(c, service.patch(c.req.param("id"), await json(c))));
  app.post("/api/claude/accounts/:id/clear", (c) => send(c, service.clear(c.req.param("id"))));
  app.delete("/api/claude/accounts/:id", async (c) => send(c, await service.remove(c.req.param("id"))));
  return service;
}
