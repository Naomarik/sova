// The live deps of the Transport agent (server/transport/agent.ts) and of Safe Transport
// (server/transport/safe-transport.ts): this server's routes, chats, workers, models, project
// doctor and mesh links, and the set transport-core registers with its hooks (transportHelpers).
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import type { Hono } from "hono";
import { acquireChatHandle, isSessionBusy } from "../chat-handle";
import { meshSelf } from "../mesh";
import { homesRoot } from "../chat-homes/root";
import { ClaudeLogins, credentialsMtime, loginEnabled, readAccountsState } from "../../pi-config/extensions/claude-code/accounts.ts";
import { agentRoot, stateRoot } from "../state-root";
import { type AgentCheck, type AgentDeps, type AgentState, afterArrival, isTransportAgent, needsAnswer, prepareDestination, type PrepareRequest, type ProjectRef } from "./agent";
import { bringHelpersToRest, busyOf, type HelperView, interruptWaiting, type SafeDeps } from "./safe-transport";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Where a user's own installs put programs the server's PATH may lack (version managers, toolchains,
    user gems: `*` is each version folder there). */
const USER_BINS = [".local/bin", ".local/share/mise/shims", ".cargo/bin", ".bun/bin", "go/bin", ".volta/bin", ".asdf/shims", ".local/share/gem/ruby/*/bin", ".gem/ruby/*/bin"];
const SYSTEM_BINS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

function expand(home: string, d: string): string[] {
  const i = d.indexOf("*");
  if (i < 0) return [join(home, d)];
  const parent = join(home, d.slice(0, i));
  try {
    return readdirSync(parent).map((v) => join(parent, v, d.slice(i + 2)));
  } catch {
    return [];
  }
}

/** How long a program's lookup is kept: the dialog's preview asks on every open. */
export const WHICH_TTL_MS = 60_000;
const whichMemo = new Map<string, { at: number; found: boolean }>();

/** The programs of `programs` the user's login shell finds (a PATH their profile sets), in one shell run, off the
    event loop: a profile with a version manager takes up to seconds. */
function loginShellFinds(programs: string[], env: NodeJS.ProcessEnv, home: string): Promise<Set<string>> {
  const shell = env.SHELL && /\/(ba|z)sh$/.test(env.SHELL) ? env.SHELL : "/bin/bash";
  return new Promise((done) => {
    let out = "";
    const child = spawn(shell, ["-lc", 'for p in "$@"; do command -v -- "$p" >/dev/null 2>&1 && printf "%s\\n" "$p"; done', "sova-which", ...programs], {
      env: { ...env, HOME: home },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    const end = () => {
      clearTimeout(timer);
      done(new Set(out.split("\n").filter((p) => programs.includes(p))));
    };
    child.on("close", end);
    child.on("error", end);
  });
}

/** Which of `programs` are reachable for the user's commands here: on this server's PATH, in one of the user's
    usual install folders, or found by the user's login shell (one run for all the rest). Each answer is kept
    WHICH_TTL_MS. Only plain program names are looked up. */
export async function whichPrograms(programs: string[], env: NodeJS.ProcessEnv = process.env, home = homedir(), now = Date.now()): Promise<Set<string>> {
  const found = new Set<string>();
  const ask: string[] = [];
  const dirs = [...(env.PATH ?? "").split(delimiter), ...USER_BINS.flatMap((d) => expand(home, d)), ...SYSTEM_BINS].filter(Boolean);
  for (const p of new Set(programs)) {
    if (!/^[\w.+-]+$/.test(p)) continue;
    const hit = whichMemo.get(p);
    if (hit && now - hit.at < WHICH_TTL_MS) {
      if (hit.found) found.add(p);
    } else if (dirs.some((d) => existsSync(join(d, p)))) {
      whichMemo.set(p, { at: now, found: true });
      found.add(p);
    } else ask.push(p);
  }
  if (ask.length) {
    const shell = await loginShellFinds(ask, env, home);
    for (const p of ask) {
      whichMemo.set(p, { at: now, found: shell.has(p) });
      if (shell.has(p)) found.add(p);
    }
  }
  return found;
}

/** Whether this device has a Claude login Claude Code can run on now: one in this device's order that is enabled,
    not limited or needing sign-in, not leaving, and signed in (credentials there, or in the macOS keychain). */
export function claudeLoginUsable(agentDir: string): boolean {
  try {
    const logins = new ClaudeLogins({ agentDir });
    const accounts = logins.accounts();
    const state = readAccountsState(agentDir);
    return logins
      .order(accounts)
      .some((id) => loginEnabled(accounts, logins.device, id) && logins.readinessOf(id, state).state === "ready" && !logins.leaving(id) && credentialsMtime(logins.dirOf(id)) !== undefined);
  } catch {
    return false;
  }
}

/** The Transport agent's live deps; `app` makes its chat through the same route a page's New Session does. */
export function liveAgentDeps(app: Pick<Hono, "request">, onAgent?: (tid: string, a: AgentState) => void): AgentDeps {
  return {
    stateRoot,
    home: () => homedir(),
    protectedRoots: () => [stateRoot(), agentRoot(), homesRoot()],
    device: () => meshSelf().label || hostname(),
    which: (ps) => whichPrograms(ps),
    git: async (args, cwd) => {
      const { realGit } = await import("../project-services/engine");
      const r = await realGit(args, cwd);
      return { code: r.code, stdout: r.stdout };
    },
    doctor: async (folder): Promise<AgentCheck[] | null> => {
      const { projectEngine } = await import("../project-services/routes");
      const r = await projectEngine().run("doctor", { project: folder }, { kind: "system", id: "transport-agent" });
      return (r as { checks?: AgentCheck[] }).checks ?? null;
    },
    claudeUsable: () => claudeLoginUsable(agentRoot()),
    offeredModels: async () => {
      try {
        return (await (await import("../models")).listModels()).map((m) => m.ref);
      } catch {
        return null;
      }
    },
    startChat: async ({ cwd, title, prompt, model, thinking }) => {
      const { statingOwnNumber } = await import("../wire-gate");
      const res = await statingOwnNumber(app)("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, link: true }) });
      const json = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
      if (res.status !== 201 || !json?.id || !json.path) throw new Error(`The Transport agent's chat didn't start: ${json?.error ?? `HTTP ${res.status}`}`);
      (await import("../session-titles")).writeAutoTitle(json.id, title);
      const chat = await acquireChatHandle(json.path);
      // Normal mode with align, so it can ask the user what it may not decide alone.
      await chat.switchMode({ mode: "normal", minorModes: ["align"] } as Parameters<typeof chat.switchMode>[0]);
      await chat.setModel(model);
      await chat.setThinking(thinking);
      await chat.deliverToAgent(prompt);
      return { id: json.id, path: json.path };
    },
    link: async (agentSessionId, sourcePeer, sourceChatId) => {
      const { meshLinks } = await import("../mesh/links");
      const v = await meshLinks.create({ members: [{ session: agentSessionId }, { host: sourcePeer, session: sourceChatId }] });
      return { linkId: v.link.id };
    },
    endLink: async (linkId) => {
      const { meshLinks } = await import("../mesh/links");
      await meshLinks.end(linkId);
    },
    tell: async (path, text) => {
      const chat = await acquireChatHandle(path);
      await chat.deliverToAgent(text);
    },
    busy: (path) => isSessionBusy(path),
    ...(onAgent ? { onAgent } : {}),
    sleep,
    now: () => Date.now(),
  };
}

/** Safe Transport's live deps: the chat's workers from the registry, their teams from its file. */
export function liveSafeDeps(): SafeDeps {
  return {
    helpers: async (chatId): Promise<HelperView[]> => {
      const { workersWorkingOf } = await import("../chat-host");
      const live = workersWorkingOf(chatId);
      if (!live.length) return [];
      const { pathOfId } = await import("../session-prompt");
      const path = await pathOfId(chatId);
      const teams = path ? (await (await import("../insights")).sessionFacts(path)).teams : [];
      const seat = new Map<string, { teamId: string; role: string; duty?: "coordinator" | "monitor" }>();
      for (const t of teams) for (const m of t.members) if (!m.ejectedAt) seat.set(m.workerId, { teamId: t.id, role: m.role, ...(m.duty ? { duty: m.duty } : {}) });
      return live.map((w) => {
        // A seat is the lead's team roster's: a helper's own helper (ids are per parent) has none, so it is told itself.
        const s = w.parent === chatId ? seat.get(w.workerId) : undefined;
        return { workerId: w.workerId, chatId: w.chatId, name: s?.role ?? w.workerId, working: w.working, ...(s ? { teamId: s.teamId, ...(s.duty ? { duty: s.duty } : {}) } : {}) };
      });
    },
    tell: async (helperChatId, text, key) => (await import("../chat-host")).steerWorkerChat(helperChatId, text, key),
    abort: async (helperChatId) => (await import("../chat-host")).abortWorkerChat(helperChatId),
    sleep,
  };
}

/** What transport-core registers with its hooks (setPrepareDestination, setBringHelpersToRest,
    setAfterArrival, setNeedsAnswer, setPreviewExtras), bound to this server's live deps. `onAgent`:
    its updateTransport(tid, {ext: {agent}}), so the transport's view shows its agent. */
export function transportHelpers(app: Pick<Hono, "request">, onAgent?: (tid: string, a: AgentState) => void) {
  const agentDeps = liveAgentDeps(app, onAgent);
  const safeDeps = liveSafeDeps();
  return {
    prepareDestination: (req: PrepareRequest, opts: { signal?: AbortSignal } = {}) => prepareDestination(req, agentDeps, opts),
    afterArrival: (req: Parameters<typeof afterArrival>[0]) => afterArrival(req, agentDeps).catch((err: unknown) => {
      console.log(`[transport-agent] after arrival of ${req.tid}: ${err instanceof Error ? err.message : String(err)}`);
      return [] as string[];
    }),
    needsAnswer: (project: ProjectRef, opts: { chatModel?: string } = {}) => needsAnswer(project, agentDeps, opts),
    bringHelpersToRest: (chatId: string, mode: "safe" | "interrupt", onProgress: (working: number) => void, opts: { signal?: AbortSignal } = {}) => bringHelpersToRest(chatId, mode, onProgress, safeDeps, opts),
    interruptWaiting,
    /** The dialog's Busy helpers: those of the chat working now. */
    busyHelpers: async (chatId: string) => busyOf(await safeDeps.helpers(chatId)).map((h) => ({ id: h.chatId, name: h.name })),
    isTransportAgent: (sessionId: string) => isTransportAgent(stateRoot(), sessionId),
  };
}
