import type { Hono } from "hono";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
// The claude-code extension's login standing (node built-ins only). See CLAUDE.md.
import { defaultClaudeDir, loginDir, readAccountsState, readiness } from "../pi-config/extensions/claude-code/accounts.ts";
import { heldChat } from "./chat-manager";
import { chatClaudeLogin, loginName } from "./claude-login-state";
import { briefOverseer, countStarted, freeRunSlots, OVERSEER_SENDER_HEADER, overseerSender, promptSession } from "./overseer";
import { listPlaybooks, listProjectPlaybooks, readProjectPlaybook } from "./playbooks";
import { findProfile } from "./profile-sources";
import { projectRootOf } from "./project-root";
import { DEFAULT_TICK_MS, ScheduleKeeper, scheduleKeeper, scheduleRunsFile, schedulesFile, setScheduleKeeper, type LoginNow } from "./schedules";
import { readSeen } from "./seen";
import { writeAutoTitle } from "./session-titles";
import { listSessions } from "./sessions-index";
import { readActiveBranch } from "./transcript";

/**
 * The playbook schedules' keeper, wired to the real server (§chat/schedules), and their routes.
 *
 * `SOVA_SCHEDULE_TICK_MS` (default 30 s) and `SOVA_SCHEDULE_SPEED` (default 1: the keeper's clock
 * runs that many times faster than the real one, from start) exist for hermetic runs, so an
 * `every 30m` fires in seconds. Never set on a real server.
 */

const DISCOVER_MS = 5 * 60_000;

type AppRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

/** This host's Claude logins as the keeper reads them: each one's standing now. */
function loginsNow(): LoginNow[] {
  const agentDir = getAgentDir();
  const state = readAccountsState(agentDir);
  const out: LoginNow[] = [];
  for (const [id, standing] of Object.entries(state.logins)) {
    // `default` is Claude Code's own login: its directory is not under the logins folder.
    const r = readiness(standing, id === "default" ? defaultClaudeDir(process.env, agentDir) : loginDir(agentDir, id));
    out.push({
      id,
      name: loginName(id),
      state: r.state,
      ...(r.state === "limited" ? { since: standing.at, until: r.until } : {}),
    });
  }
  return out;
}

/** The session's branch ends in a failed turn: when, and the Claude login it ran on (only a recorded one). */
async function lastTurn(path: string): Promise<{ failed: boolean; at: number; login?: string } | null> {
  const branch = (await readActiveBranch(path)) as { type?: string; timestamp?: string; message?: { role?: string; stopReason?: string } }[];
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type !== "message") continue;
    if (e.message?.role !== "assistant" || e.message.stopReason !== "error") return { failed: false, at: 0 };
    const login = chatClaudeLogin(branch as never);
    return { failed: true, at: Date.parse(e.timestamp ?? "") || 0, ...(login?.recorded ? { login: login.id } : {}) };
  }
  return null;
}

/** Start the keeper: a tick every 30 s, and discovery in the projects of listed sessions every few minutes. */
export function startScheduleKeeper(request: AppRequest): ScheduleKeeper {
  const tickMs = Number(process.env.SOVA_SCHEDULE_TICK_MS) || DEFAULT_TICK_MS;
  const speed = Math.max(1, Number(process.env.SOVA_SCHEDULE_SPEED) || 1);
  const t0 = Date.now();
  const keeper = new ScheduleKeeper({
    file: schedulesFile(),
    logFile: scheduleRunsFile(),
    now: () => t0 + (Date.now() - t0) * speed,
    realNow: () => Date.now(),
    lateAfterMs: Math.max(60_000, 2 * tickMs * speed),
    readPlaybook: readProjectPlaybook,
    findProfile: (id, root) => findProfile(id, root),
    sessions: () => listSessions(),
    busy(path) {
      const chat = heldChat(path);
      return !!chat && (chat.session.isStreaming || chat.queue.size > 0 || chat.session.agent.hasQueuedMessages());
    },
    freeSlots: freeRunSlots,
    started: countStarted,
    async wake(path, text) {
      const r = await promptSession(path, text);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    },
    async create(root, profile, text, title) {
      // The start a profile gets from the list (§chat.profiles/applying): created in the project's
      // root with the profile, then its first message; unapproved and One at a time refuse there.
      const res = await request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: root, profile, prompt: text }) });
      const json = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
      if (res.status !== 201 || !json?.id || !json.path) return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
      writeAutoTitle(json.id, title);
      return { ok: true, id: json.id, path: json.path };
    },
    seenAt: (id) => readSeen()[id] ?? 0,
    logins: loginsNow,
    loginName: (id) => loginName(id),
    lastTurn,
    brief: (text) => void briefOverseer(text).catch(() => {}),
  });
  setScheduleKeeper(keeper);
  const tick = () => void keeper.tick().catch((err) => console.warn("[schedules] tick failed:", err instanceof Error ? err.message : String(err)));
  const discover = async () => {
    const cwds = new Set((await listSessions()).filter((s) => !s.archived).map((s) => s.cwd));
    const roots: string[] = [];
    for (const cwd of cwds) {
      const root = await projectRootOf(cwd).catch(() => null);
      if (root && !roots.includes(root)) roots.push(root);
    }
    await keeper.discover(roots, listProjectPlaybooks);
  };
  const find = () => void discover().catch((err) => console.warn("[schedules] discovery failed:", err instanceof Error ? err.message : String(err)));
  setTimeout(find, 3000).unref();
  setInterval(find, DISCOVER_MS).unref();
  // The first tick after the server is up, so a fire missed while it was down goes out (or is skipped) once.
  setTimeout(tick, 5000).unref();
  setInterval(tick, tickMs).unref();
  return keeper;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function registerScheduleRoutes(app: Hono): void {
  // The catalog, with each project schedule's state (§chat.schedules/where-shown).
  app.get("/api/playbooks", async (c) => {
    const cwd = c.req.query("cwd");
    const catalog = await listPlaybooks(cwd);
    const keeper = scheduleKeeper();
    if (!keeper || catalog.project.state !== "ok" || !cwd) return c.json(catalog);
    return c.json(await keeper.decorate(catalog, await projectRootOf(cwd)));
  });
  app.get("/api/schedules", async (c) => c.json({ schedules: (await scheduleKeeper()?.list()) ?? [] }, 200, { "Cache-Control": "no-store" }));
  // Approve: the user's click only, never the Overseer (§chat.schedules/approval).
  app.post("/api/schedules/approve", async (c) => {
    if (overseerSender(c.req.header(OVERSEER_SENDER_HEADER))) return c.json({ error: "Only the user approves a schedule, in Sova." }, 403);
    const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; playbook?: unknown; pin?: unknown } | null;
    const cwd = str(body?.cwd);
    const playbook = str(body?.playbook);
    const pin = str(body?.pin);
    if (!cwd || !playbook || !pin) return c.json({ error: "Expected {cwd, playbook, pin}" }, 400);
    const root = await projectRootOf(cwd);
    const keeper = scheduleKeeper();
    if (!root || !keeper) return c.json({ error: `${cwd} is not a local project.` }, 404);
    const r = await keeper.approve(root, playbook, pin);
    return r.ok ? c.json(r.schedule) : c.json({ error: r.error }, r.status);
  });
  app.post("/api/schedules/revoke", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    const id = str(body?.id);
    if (!id) return c.json({ error: "Expected {id}" }, 400);
    const r = (await scheduleKeeper()?.revoke(id)) ?? { ok: false as const, status: 404 as const, error: `No schedule ${id}.` };
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error }, r.status);
  });
}
