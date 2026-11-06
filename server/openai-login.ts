import { join } from "node:path";
import type { Hono } from "hono";
import type { ProviderSignIn, SignInEvent, SignInMethod, SignInOutcome } from "../shared/harness";
import type { OpenAiAccountInfo, OpenAiLoginFlow } from "../shared/protocol";
import { defaultAuthPaths, readOpenAiSignIn, type AuthStatusPaths } from "./auth-status";
import { piProviderSignIn } from "./harness/pi/sign-in";
import { loginKindsPin } from "./sync/logins-merge";
import { meshEnabled, readMeshSettings } from "./mesh/index";
import { agentRoot } from "./state-root";

// Settings → Accounts' OpenAI sign-in (§app.openai-login): the ChatGPT subscription, pi's
// `openai-codex`, signed in through pi's own login code (the harness's ProviderSignIn), which stores
// it in pi's auth.json under pi's lock. One flow at a time, as server/claude-accounts.ts runs Claude's:
// a code first; when OpenAI refuses the code route, the browser route (open a link, paste back the
// address the page ends on). Cancel, or 15 minutes left alone, aborts pi's login, which frees
// localhost:1455 (the browser route's callback port, shared with the Codex CLI), and saves nothing.
// The browser gets the code, the links, the email and standings; never a token.

/** pi's provider id for the ChatGPT subscription. */
export const OPENAI_PROVIDER = "openai-codex";
const FLOW_TIMEOUT_MS = 15 * 60_000;
const SHOWN_TIMEOUT_MS = 20_000;
const FINISH_TIMEOUT_MS = 60_000;
const SETTLE_TIMEOUT_MS = 5_000;
const MAX_ADDRESS = 4096;

const REFUSED = "OpenAI didn't offer a sign-in code for this account. Sign in through the link instead.";
const FAILED = "OpenAI didn't complete the sign-in. Try again.";
const NOT_AN_ADDRESS = "That isn't the address the sign-in page ended on. Copy the whole address from the browser's address bar after signing in, and paste it here.";
const OTHER_SIGN_IN = "That address belongs to another sign-in. Use the address from the page this link opened.";
const LEFT_ALONE = "The sign-in was left alone for 15 minutes and ended. Nothing was saved.";

export interface OpenAiLoginOptions {
  signIn?: ProviderSignIn;
  paths?: () => AuthStatusPaths;
  now?: () => number;
  /** Test seam: timeouts. */
  timeouts?: Partial<{ flow: number; shown: number; finish: number; settle: number }>;
  /** The mesh is on and this device shares sign-ins (sign-out then reaches the devices that share them). */
  meshSharesLogins?: () => boolean;
  /** This device syncs API keys only. */
  apiKeysOnly?: () => boolean;
  /** After a sign-in or sign-out: the model menu and the usage reading follow it. Errors are ignored. */
  afterChange?: (change: "signed-in" | "signed-out") => void | Promise<void>;
}

interface Flow {
  state: OpenAiLoginFlow;
  abort: AbortController;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  /** The browser route's link, for checking a pasted address against it. */
  url?: string;
  refused?: string;
  /** pi waits for the pasted address. */
  pending?: { resolve: (text: string) => void; reject: (error: Error) => void };
  /** Settles when pi's login has returned (its callback server closed). */
  settled: Promise<void>;
  waiters: Set<() => void>;
}

const RUNNING: OpenAiLoginFlow["state"][] = ["starting", "code", "browser", "finishing"];
const running = (flow: Flow | null): flow is Flow => !!flow && RUNNING.includes(flow.state.state);

/** Long token-like runs out of a message before it is logged (pi's errors may quote a reply). */
const redact = (text: string) => text.replace(/[A-Za-z0-9_\-.+/=]{32,}/g, "…").slice(0, 300);

export type OpenAiResult =
  | { status: 200; body: OpenAiAccountInfo | OpenAiLoginFlow | null }
  | { status: 400 | 409; body: { error: string } };

/** A pasted address's `code` and `state`, read as an OAuth redirect: a URL, or its query alone. */
export function readAddress(text: string): { code?: string; state?: string } {
  const value = text.trim();
  let params: URLSearchParams | null = null;
  try {
    params = new URL(value).searchParams;
  } catch {
    if (value.includes("code=")) params = new URLSearchParams(value.replace(/^[^?]*\?/, ""));
  }
  if (!params) return {};
  return { ...(params.get("code") ? { code: params.get("code")! } : {}), ...(params.get("state") ? { state: params.get("state")! } : {}) };
}

function stateOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).searchParams.get("state") ?? undefined;
  } catch {
    return undefined;
  }
}

export class OpenAiLoginService {
  private readonly signIn: ProviderSignIn;
  private readonly paths: () => AuthStatusPaths;
  private readonly now: () => number;
  private readonly timeouts: { flow: number; shown: number; finish: number; settle: number };
  private readonly options: OpenAiLoginOptions;
  private flow: Flow | null = null;

  constructor(options: OpenAiLoginOptions = {}) {
    this.options = options;
    this.signIn = options.signIn ?? piProviderSignIn(() => join(agentRoot(), "auth.json"));
    this.paths = options.paths ?? (() => defaultAuthPaths());
    this.now = options.now ?? Date.now;
    this.timeouts = { flow: FLOW_TIMEOUT_MS, shown: SHOWN_TIMEOUT_MS, finish: FINISH_TIMEOUT_MS, settle: SETTLE_TIMEOUT_MS, ...options.timeouts };
  }

  // -- reading -------------------------------------------------------------------------------

  async info(): Promise<OpenAiAccountInfo> {
    const facts = await readOpenAiSignIn(this.paths(), this.now());
    const apiKeysOnly = this.probe(this.options.apiKeysOnly ?? defaultApiKeysOnly);
    return {
      ...facts,
      meshSharesLogins: !apiKeysOnly && this.probe(this.options.meshSharesLogins ?? defaultMeshSharesLogins),
      apiKeysOnly,
      flow: this.flow?.state ?? null,
    };
  }

  flowState(): OpenAiLoginFlow | null {
    return this.flow?.state ?? null;
  }

  private probe(fn: () => boolean): boolean {
    try {
      return fn();
    } catch {
      return false;
    }
  }

  // -- the flow ------------------------------------------------------------------------------

  private setFlow(flow: Flow, state: OpenAiLoginFlow): void {
    if (this.flow !== flow) return;
    flow.state = state;
    for (const wake of [...flow.waiters]) wake();
  }

  private waitFor(flow: Flow, done: (state: OpenAiLoginFlow) => boolean, ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (done(flow.state) || this.flow !== flow) return resolve();
      const timer = setTimeout(finish, ms);
      function finish() { clearTimeout(timer); flow.waiters.delete(check); resolve(); }
      const check = () => { if (done(flow.state)) finish(); };
      flow.waiters.add(check);
    });
  }

  /** End a running flow: pi's login is aborted (its callback server closes) and nothing is saved. */
  private endFlow(flow: Flow, state: OpenAiLoginFlow): void {
    clearTimeout(flow.timer);
    this.setFlow(flow, state);
    flow.pending?.reject(new Error("Sign-in ended"));
    flow.pending = undefined;
    flow.abort.abort();
  }

  /** Start a sign-in; answer once there is a code or a link to show, or it failed. */
  async start(body?: unknown): Promise<OpenAiResult> {
    if (running(this.flow)) return { status: 409, body: { error: "A sign-in is already in progress; finish or cancel it first" } };
    const asked = (body as { method?: unknown } | null | undefined)?.method;
    if (asked !== undefined && asked !== "code" && asked !== "browser") return { status: 400, body: { error: 'method must be "code" or "browser"' } };
    const method: SignInMethod = asked ?? "code";
    let markSettled!: () => void;
    const flow: Flow = {
      state: { state: "starting" },
      abort: new AbortController(),
      deadline: this.now() + this.timeouts.flow,
      timer: setTimeout(() => this.endFlow(flow, { state: "expired" }), this.timeouts.flow),
      settled: new Promise((resolve) => { markSettled = resolve; }),
      waiters: new Set(),
    };
    this.flow = flow;
    void this.run(flow, method).finally(markSettled);
    await this.waitFor(flow, (s) => s.state !== "starting", this.timeouts.shown);
    if (flow.state.state === "starting") this.endFlow(flow, { state: "failed", error: "OpenAI didn't answer. Try again in a moment." });
    return { status: 200, body: flow.state };
  }

  private onEvent(flow: Flow, event: SignInEvent): void {
    if (this.flow !== flow || !running(flow)) return;
    if (event.type === "code") {
      const expiresAt = Math.min(flow.deadline, event.expiresInMs !== undefined ? this.now() + event.expiresInMs : flow.deadline);
      this.setFlow(flow, { state: "code", userCode: event.userCode, url: event.url, expiresAt });
    } else if (event.type === "url") {
      flow.url = event.url;
      this.setFlow(flow, { state: "browser", url: event.url, expiresAt: flow.deadline, ...(flow.refused ? { refused: flow.refused } : {}) });
    } else {
      this.setFlow(flow, { state: "finishing" });
    }
  }

  private askAddress(flow: Flow, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Sign-in ended"));
      const pending = { resolve, reject };
      flow.pending = pending;
      signal.addEventListener("abort", () => {
        if (flow.pending === pending) flow.pending = undefined;
        reject(new Error("Sign-in ended"));
        // OpenAI called back to this computer by itself (localhost:1455): pi finishes on its own.
        if (!flow.abort.signal.aborted && flow.state.state === "browser") this.setFlow(flow, { state: "finishing" });
      }, { once: true });
    });
  }

  private async run(flow: Flow, method: SignInMethod): Promise<void> {
    const outcome = await this.signIn.signIn(OPENAI_PROVIDER, method, {
      onEvent: (event) => this.onEvent(flow, event),
      askAddress: (signal) => this.askAddress(flow, signal),
    }, flow.abort.signal).catch((error: unknown): SignInOutcome => ({ ok: false, error: String((error as Error)?.message ?? error) }));
    if (this.flow !== flow || !running(flow)) return; // cancelled or timed out: already said
    if (outcome.ok) {
      clearTimeout(flow.timer);
      const facts = await readOpenAiSignIn(this.paths(), this.now()).catch(() => null);
      this.setFlow(flow, { state: "done", ...(facts?.email ? { email: facts.email } : {}) });
      this.changed("signed-in");
      return;
    }
    if (outcome.refused && method === "code") {
      flow.refused = REFUSED;
      return this.run(flow, "browser");
    }
    console.error(`[openai-login] sign-in failed: ${redact(outcome.error)}`);
    clearTimeout(flow.timer);
    this.setFlow(flow, { state: "failed", error: FAILED });
  }

  private changed(change: "signed-in" | "signed-out"): void {
    try {
      void Promise.resolve(this.options.afterChange?.(change)).catch(() => {});
    } catch {
      /* the model menu and usage catch up on their own */
    }
  }

  /** The browser route: the address the page ended on. Answers once pi finished, or the address was refused. */
  async answer(body: unknown): Promise<OpenAiResult> {
    const text = (body as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim() || text.length > MAX_ADDRESS || /[\x00-\x1f\x7f]/.test(text.trim())) {
      return { status: 400, body: { error: "Expected { text } as the one address the sign-in page ended on" } };
    }
    const flow = this.flow;
    if (!flow || flow.state.state !== "browser" || !flow.pending) return { status: 409, body: { error: "No sign-in is waiting for an address" } };
    const browser = flow.state;
    const read = readAddress(text);
    const expected = stateOf(flow.url);
    const refusal = !read.code ? NOT_AN_ADDRESS : read.state && expected && read.state !== expected ? OTHER_SIGN_IN : null;
    if (refusal) {
      this.setFlow(flow, { ...browser, error: refusal });
      return { status: 200, body: flow.state };
    }
    const pending = flow.pending;
    flow.pending = undefined;
    this.setFlow(flow, { state: "finishing" });
    pending.resolve(text.trim());
    await this.waitFor(flow, (s) => s.state !== "finishing", this.timeouts.finish);
    return { status: 200, body: flow.state };
  }

  /** Cancel a running flow (waiting until pi's login returned, so localhost:1455 is free), or clear a finished one. */
  async cancel(): Promise<OpenAiResult> {
    const flow = this.flow;
    if (running(flow)) {
      this.endFlow(flow, { state: "failed", error: "Cancelled" });
      await Promise.race([flow.settled, new Promise((resolve) => setTimeout(resolve, this.timeouts.settle))]);
    }
    if (this.flow === flow) this.flow = null;
    return { status: 200, body: await this.info() };
  }

  /** Sign out: pi's logout removes the sign-in from its auth.json. */
  async signOut(): Promise<OpenAiResult> {
    if (running(this.flow)) return { status: 409, body: { error: "A sign-in is in progress; finish or cancel it first" } };
    try {
      await this.signIn.signOut(OPENAI_PROVIDER);
    } catch (error) {
      console.error(`[openai-login] sign-out failed: ${redact(String((error as Error)?.message ?? error))}`);
      return { status: 409, body: { error: "Couldn't sign out. Try again." } };
    }
    this.changed("signed-out");
    return { status: 200, body: await this.info() };
  }

  /** Waits until pi's login has returned (tests). */
  settled(): Promise<void> {
    return this.flow?.settled ?? Promise.resolve();
  }

  /** Stop a running flow on shutdown, leaving nothing behind. */
  dispose(): void {
    if (running(this.flow)) this.endFlow(this.flow, { state: "failed", error: "Sova is shutting down" });
  }
}

/** This device syncs API keys only (SOVA_SYNC_LOGIN_KINDS, else the mesh setting). */
function defaultApiKeysOnly(): boolean {
  return (loginKindsPin() ?? readMeshSettings().loginKinds ?? "all") === "api-keys";
}

/** The mesh is on and shares sign-ins. */
export function defaultMeshSharesLogins(): boolean {
  return meshEnabled() && readMeshSettings().sync.logins;
}

async function json(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** The routes, under Settings (an area left out of the command catalogue). */
export function registerOpenAiLoginRoutes(app: Hono, service = new OpenAiLoginService()): OpenAiLoginService {
  const send = (c: any, r: OpenAiResult) => c.json(r.body, r.status, { "Cache-Control": "no-store" });
  app.get("/api/settings/accounts/openai", async (c) => c.json(await service.info(), 200, { "Cache-Control": "no-store" }));
  app.post("/api/settings/accounts/openai/login", async (c) => send(c, await service.start(await json(c))));
  app.get("/api/settings/accounts/openai/login", (c) => c.json(service.flowState(), 200, { "Cache-Control": "no-store" }));
  app.post("/api/settings/accounts/openai/login/answer", async (c) => send(c, await service.answer(await json(c))));
  app.delete("/api/settings/accounts/openai/login", async (c) => send(c, await service.cancel()));
  app.delete("/api/settings/accounts/openai", async (c) => send(c, await service.signOut()));
  return service;
}
