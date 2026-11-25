// The live deps of the Transport agent (server/transport/agent.ts) and of Safe Transport
// (server/transport/safe-transport.ts): this server's routes, chats, workers, models, project
// doctor and mesh links, and the set transport-core registers with its hooks (transportHelpers).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import type { Hono } from "hono";
import { acquireChatHandle, isSessionBusy, onAgentSettled } from "../chat-handle";
import { meshSelf } from "../mesh";
import { homesRoot } from "../chat-homes/root";
import { ClaudeLogins, credentialsMtime, loginEnabled, readAccountsState } from "../../pi-config/extensions/claude-code/accounts.ts";
import { inheritedEnv } from "../project-services/env-allow";
import { hostVars as hostVarsOf, hostVarsFile } from "../project-services/store";
import { agentRoot, stateRoot } from "../state-root";
import { canonicalize, loadPolicyFile, loadProjectTightening, policyFilePath } from "../../pi-config/extensions/sandbox/policy.ts";
import { CONTRACT_FILE, parseDefinition } from "../../shared/project-contract";
import { backendFor } from "../../pi-config/extensions/sandbox/backend.ts";
import { type AgentCheck, type AgentDeps, type AgentState, afterArrival, agentTurnEnded, allowDownloads, askAdmin, askDownloads, askOutsideFile, bringOutsideFile, copyLogs, isTransportAgent, markAdminDone, markAgent, needsAnswer, placedOutsideFile, prepareDestination, type PrepareRequest, type ProjectRef, settingUpNames, startCopy } from "./agent";
import type { CopyDeps } from "./arrival-copy";
import type { AgentScope } from "./agent-scope";
import { remoteReachable } from "./git-snapshot";
import type { SetupDef } from "./setup-def";
import { bringHelpersToRest, busyOf, type HelperView, interruptWaiting, type SafeDeps } from "./safe-transport";

/** The agent's last fix from its chat's entries (routes.ts reads them). */
export { lastFixOf } from "./agent";

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

/** The `mise` program for the user's commands here: on this server's PATH or in the user's usual install folders. */
function miseBinary(env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  const dirs = [...(env.PATH ?? "").split(delimiter), ...USER_BINS.flatMap((d) => expand(home, d)), ...SYSTEM_BINS].filter(Boolean);
  for (const d of dirs) if (existsSync(join(d, "mise"))) return join(d, "mise");
  return null;
}

/** Whether `tool`, pinned in the project's mise file at `folder`, is installed at that version: `mise where`, which
    installs nothing and runs none of the project's commands (the folder's config trusted for this one read). It runs in
    the environment the project's services get (env-allow.ts: the XDG homes and mise's own settings), so it reads the
    toolchain they will use. */
export function miseToolResolves(tool: string, folder: string, env: NodeJS.ProcessEnv = inheritedEnv(process.env)): Promise<boolean> {
  const mise = miseBinary(env);
  if (!mise || !/^[A-Za-z0-9][\w.+-]{0,63}$/.test(tool)) return Promise.resolve(false);
  return new Promise((done) => {
    const child = spawn(mise, ["where", tool], { cwd: folder, env: { ...env, MISE_TRUSTED_CONFIG_PATHS: folder }, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("close", (code) => (clearTimeout(timer), done(code === 0)));
    child.on("error", () => (clearTimeout(timer), done(false)));
  });
}

/** The sites the sandbox's network reaches for a chat in `folder` with no list allowed: the policy file's allowlist,
    tightened by the project's own file. Null when the policy can't be read. */
export function sandboxNetworkBase(folder: string): string[] | null {
  try {
    const loaded = loadPolicyFile(policyFilePath(agentRoot()));
    if (!loaded.ok) return null;
    return [...loadProjectTightening(canonicalize(folder), loaded.value).policy.proxy.allow];
  } catch {
    return null;
  }
}

/** The sandbox's hidden list on this device (absolute): its backend's own defaults (~/.ssh, ~/.aws, ~/.gnupg, browser
    profiles, credential files…) and the policy file's `hidden`. A file there never travels (outside-file.ts). */
export function sandboxHiddenPaths(home = homedir()): string[] {
  const out: string[] = [];
  try {
    out.push(...backendFor().platformDefaults({ home, agentDir: agentRoot() }).hidden);
  } catch {
    // no backend here: the policy file's own list still holds
  }
  try {
    const loaded = loadPolicyFile(policyFilePath(agentRoot()));
    if (loaded.ok) out.push(...((loaded.value as { hidden?: string[] }).hidden ?? []).map((h) => (h === "~" || h.startsWith("~/") ? join(home, h.slice(2)) : h)));
  } catch {
    // unreadable: the backend's defaults hold
  }
  // Never empty: the lines every backend hides, should none be readable here.
  for (const h of [".ssh", ".gnupg", ".aws", ".docker", ".kube", ".azure", ".password-store", ".netrc", ".git-credentials", ".npmrc", ".pypirc"]) out.push(join(home, h));
  return [...new Set(out)];
}

/** The project's definition at a checkout, as the arrived copy needs it; null when there is none (or it isn't valid). */
function definitionAt(tree: string): { open: { endpoint: string; path: string } | null } | null {
  const file = join(tree, CONTRACT_FILE);
  if (!existsSync(file)) return null;
  try {
    const def = parseDefinition(readFileSync(file, "utf8"));
    return { open: def.open ? { endpoint: def.open.endpoint, path: def.open.path } : null };
  } catch {
    return null;
  }
}

/** The arrived chat's running copy, through this server's project services, as your Move's click: up waits until each
    service is ready (the engine's own readiness), logs read a service's journal or a step's hook unit. */
export const liveCopyDeps: CopyDeps = {
  copyUp: async (tree, services) => {
    const { projectEngine } = await import("../project-services/routes");
    const r = await projectEngine().run("up", { checkout: tree, ...(services?.length ? { services } : {}) }, { kind: "operator", notPage: true });
    return {
      ok: r.ok,
      instance: r.instance,
      services: r.services.map((x) => ({ name: x.name, scope: x.scope, state: x.state, ports: x.ports, ...(x.detail ? { detail: x.detail } : {}) })),
      steps: r.steps.map((x) => ({ id: x.id, kind: x.kind, result: x.result, ...(x.detail ? { detail: x.detail } : {}) })),
      ...(r.error ? { error: { code: r.error.code, message: r.error.message, ...(r.error.step ? { step: r.error.step } : {}), ...(r.error.service ? { service: r.error.service } : {}) } } : {}),
    };
  },
  copyDef: definitionAt,
  entryAnswers: async (port, path) => (await (await import("../project-services/conform")).entryAnswers(port, path)).status,
  logs: async (instance, what, lines) => {
    const { projectEngine } = await import("../project-services/routes");
    const engine = projectEngine();
    if (what.step) return (await engine.driver.logs(engine.hookUnitOf(instance, what.step), lines)).map((l) => l.text);
    const r = await engine.run("logs", { instance, ...(what.service ? { services: [what.service] } : {}), lines }, { kind: "operator", notPage: true });
    if (!r.ok) return [`(the log couldn't be read: ${r.error?.message ?? "failed"})`];
    return (r.lines ?? []).map((l) => `${l.service}: ${l.text}`);
  },
  copyStatus: async (instance) => {
    const { projectEngine } = await import("../project-services/routes");
    const r = await projectEngine().run("status", { instance }, { kind: "operator", notPage: true });
    return r.ok ? r.services.map((x) => ({ name: x.name, scope: x.scope, state: x.state })) : null;
  },
  copyDown: async (instance, services) => {
    const { projectEngine } = await import("../project-services/routes");
    const r = await projectEngine().run("down", { instance, services }, { kind: "operator", notPage: true });
    if (!r.ok) throw new Error(r.error?.message ?? "down failed");
  },
};

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
/** Whether Sova's sandbox confines a chat to `scope` here: the backend probes that very policy (the launch a confined
    tool call makes, its command `true`), its proxy included; null when it does, else why not. Partial enforcement is
    refused unless the policy file accepts it, as for an unattended worker. */
export async function confineProbe(scope: AgentScope): Promise<string | null> {
  const { prepareSessionCommand } = await import("../../pi-config/extensions/sandbox/session-policy.ts");
  const r = await prepareSessionCommand({ agentDir: agentRoot(), cwd: scope.workspaceRoot, sessionId: `transport-probe-${process.pid}-${Date.now()}`, parent: scope }, ["true"]);
  if (!r.ok) return r.error;
  await r.value.dispose();
  return null;
}

/** What routes.ts adds to the live deps: the running copy's view for the card, and the read of a file on the device a
    transport came from (its peer call, your click proven over it). */
export type AgentWireExtras = Pick<AgentDeps, "onCopy" | "fetchOutside" | "lastFixAt">;

export function liveAgentDeps(app: Pick<Hono, "request">, onAgent?: (tid: string, a: AgentState) => void, onBlocked?: (tid: string, reason: string) => void, extras: AgentWireExtras = {}): AgentDeps {
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
    reachable: (url) => remoteReachable(url),
    toolResolves: (tool, folder) => miseToolResolves(tool, folder),
    configHome: () => process.env.XDG_CONFIG_HOME,
    networkBase: (folder) => sandboxNetworkBase(folder),
    doctor: async (folder): Promise<AgentCheck[] | null> => {
      const { projectEngine } = await import("../project-services/routes");
      const r = await projectEngine().run("doctor", { project: folder }, { kind: "system", id: "transport-agent" });
      return (r as { checks?: AgentCheck[] }).checks ?? null;
    },
    hostValues: (folder) => {
      try {
        return new Set(Object.keys(hostVarsOf(folder)));
      } catch {
        return new Set<string>();
      }
    },
    agentHidden: async () => {
      const { listProjects } = await import("../projects/spaces");
      let roots: string[] = [];
      try {
        roots = listProjects().map((p) => p.root);
      } catch {
        roots = [];
      }
      return [hostVarsFile(), join(stateRoot(), "transport"), homesRoot(), `${homesRoot()}.incoming`, ...roots];
    },
    confine: confineProbe,
    claudeUsable: () => claudeLoginUsable(agentRoot()),
    offeredModels: async () => {
      try {
        return (await (await import("../models")).listModels()).map((m) => m.ref);
      } catch {
        return null;
      }
    },
    startChat: async ({ cwd, title, prompt, model, thinking, tid, scope }) => {
      const { statingOwnNumber } = await import("../wire-gate");
      const res = await statingOwnNumber(app)("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, link: true }) });
      const json = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
      if (res.status !== 201 || !json?.id || !json.path) throw new Error(`The Transport agent's chat didn't start: ${json?.error ?? `HTTP ${res.status}`}`);
      (await import("../session-titles")).writeAutoTitle(json.id, title);
      // Its scope before its first open: the open's flags read it (agent-scope.ts agentLaunchFlags), so no tool call
      // of it ever runs unconfined.
      markAgent(stateRoot(), json.id, tid, Date.now(), scope);
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
    reopen: async (path) => {
      const { closeChat } = await import("../chat-handle");
      await closeChat(path, "The chat's worktrees arrived: reopening with them in reach.");
    },
    ...(onAgent ? { onAgent } : {}),
    ...(onBlocked ? { onBlocked } : {}),
    copy: liveCopyDeps,
    hiddenPaths: () => sandboxHiddenPaths(),
    ...extras,
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
export function transportHelpers(app: Pick<Hono, "request">, onAgent?: (tid: string, a: AgentState) => void, onBlocked?: (tid: string, reason: string) => void, extras: AgentWireExtras = {}) {
  const agentDeps = liveAgentDeps(app, onAgent, onBlocked, extras);
  const safeDeps = liveSafeDeps();
  // Every turn of an arrived Transport agent's chat that ends reads its setup checks again (a message you typed into
  // it included); off the event, since listeners run inside it.
  onAgentSettled((path) =>
    setTimeout(() => void agentTurnEnded(agentDeps, path)?.catch((err: unknown) => console.log(`[transport-agent] the checks after a turn of ${path}: ${err instanceof Error ? err.message : String(err)}`)), 0),
  );
  return {
    prepareDestination: (req: PrepareRequest, opts: { signal?: AbortSignal } = {}) => prepareDestination(req, agentDeps, opts),
    /** Resolves with what the agent sets up (short names) as soon as it has it; its turn goes on by itself. */
    afterArrival: (req: Parameters<typeof afterArrival>[0]) =>
      new Promise<string[]>((ok) => {
        afterArrival(req, agentDeps, { onStarted: (checks) => ok(settingUpNames(checks)) }).then(
          () => ok([]),
          (err: unknown) => {
            console.log(`[transport-agent] after arrival of ${req.tid}: ${err instanceof Error ? err.message : String(err)}`);
            ok([]);
          },
        );
      }),
    needsAnswer: (project: ProjectRef, opts: { chatModel?: string; setup?: SetupDef | null } = {}) => needsAnswer(project, agentDeps, opts),
    bringHelpersToRest: (chatId: string, mode: "safe" | "interrupt", onProgress: (working: number) => void, opts: { signal?: AbortSignal } = {}) => bringHelpersToRest(chatId, mode, onProgress, safeDeps, opts),
    interruptWaiting,
    /** The dialog's Busy helpers: those of the chat working now. */
    busyHelpers: async (chatId: string) => busyOf(await safeDeps.helpers(chatId)).map((h) => ({ id: h.chatId, name: h.name })),
    isTransportAgent: (sessionId: string) => isTransportAgent(stateRoot(), sessionId),
    /** transport_setup's run: the agent's asks, put on its card, and the arrived running copy (agent.ts). */
    setupRun: (sessionId: string, params: Record<string, unknown>) =>
      params.op === "downloads"
        ? askDownloads(agentDeps, sessionId, params)
        : params.op === "admin"
          ? askAdmin(agentDeps, sessionId, params)
          : params.op === "outside_file"
            ? askOutsideFile(agentDeps, sessionId, params)
            : params.op === "start_copy"
              ? startCopy(agentDeps, sessionId)
              : params.op === "copy_logs"
                ? copyLogs(agentDeps, sessionId, params)
                : { ok: false as const, error: "op must be downloads, admin, outside_file, start_copy or copy_logs." },
    /** Your Allow, Done, Bring From and I Placed It Myself on the card, here where the agent works (routes.ts, only on your click). */
    allowDownloads: (tid: string, plan: unknown) => allowDownloads(agentDeps, tid, plan),
    adminDone: (tid: string, step: unknown) => markAdminDone(agentDeps, tid, step),
    bringFile: (tid: string, file: unknown) => bringOutsideFile(agentDeps, tid, file),
    placedFile: (tid: string, file: unknown) => placedOutsideFile(agentDeps, tid, file),
    /** This device's sandbox hidden list: the device a transport came from reads no file there. */
    hiddenPaths: () => sandboxHiddenPaths(),
  };
}
