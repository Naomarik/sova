// The live deps of the Transport agent (server/transport/agent.ts) and of Safe Transport
// (server/transport/safe-transport.ts): this server's routes, chats, workers, models, project
// doctor and mesh links. Imported lazily, so the two rule modules stay testable on their own.
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { delimiter, join } from "node:path";
import type { Hono } from "hono";
import { acquireChatHandle, isSessionBusy } from "../chat-handle";
import { meshSelf } from "../mesh";
import { homesRoot } from "../chat-homes/root";
import { agentRoot, stateRoot } from "../state-root";
import type { AgentCheck, AgentDeps, AgentState } from "./agent";
import type { HelperView, SafeDeps } from "./safe-transport";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Where a user's own installs put programs the server's PATH may lack (version managers, toolchains). */
const USER_BINS = [".local/bin", ".local/share/mise/shims", ".cargo/bin", ".bun/bin", "go/bin", ".volta/bin", ".asdf/shims"];
const SYSTEM_BINS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/** Whether `program` is on this server's PATH or in one of the user's usual install folders. */
export function whichProgram(program: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  const dirs = [...(env.PATH ?? "").split(delimiter), ...USER_BINS.map((d) => join(home, d)), ...SYSTEM_BINS].filter(Boolean);
  return dirs.some((d) => existsSync(join(d, program)));
}

/** The Transport agent's live deps; `app` makes its chat through the same route a page's New Session does. */
export function liveAgentDeps(app: Pick<Hono, "request">, onAgent?: (tid: string, a: AgentState) => void): AgentDeps {
  return {
    stateRoot,
    home: () => homedir(),
    protectedRoots: () => [stateRoot(), agentRoot(), homesRoot()],
    device: () => meshSelf().label || hostname(),
    which: (p) => whichProgram(p),
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
