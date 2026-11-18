import type { Context, Hono } from "hono";
import { BusyError } from "../chat-handle";
import { OrgError } from "../org-error";
import { OVERSEER_CARD_HEADER, OVERSEER_SENDER_HEADER, overseerCard, overseerSender } from "../overseer-sender";
import { expectVerbsTurn, mergeRun, openOnboardRun, readRuntime, RuntimeRefusal, startOnboard, startRuntimeTick } from "./runtime";
import { freshVerbsChat, openVerbsChat, overseerVerbsStart, readVerbsChat, type OverseerVerbsStart, type VerbsDeps } from "./verbs-chat";
import { operatorEnvelopeOf, type OperatorBy } from "./spaces";
import { FOLDED_PLAYBOOKS, ONBOARD_PLAYBOOK_ID, SETUP_MODE, SETUP_PLAYBOOK_ID } from "./onboard";
import { mergeSetup, openSetup, readSetup, SETUP_FROM, type SetupDeps, type SetupFrom, type SetupMergeDeps } from "./setup-chat";
import { notPage, pageOnlyRefusal } from "../page-only";
import { notPageNorProven } from "../mesh/click-proof";
import { realGit } from "../project-services/engine";
import { buildSid, engineOf, projectSid, readProject, runtimeSid } from "./spaces";
import { hostOf, isOrgHostOpen } from "../org-engine";
import type { Envelope } from "../org-envelope";

/**
 * The software registry's routes (§app/project-runtime): `GET /api/projects/:pid/runtime` (the registry, read
 * fresh), `POST …/runtime/merge {hash}` (Merge Branch on the proposed run) and `POST …/verbs/onboard {why?, model?}`
 * (the Project verbs playbook).
 */

const NO_STORE = { "Cache-Control": "no-store" };

const handle =
  (fn: (c: Context) => Promise<Response>) =>
  async (c: Context): Promise<Response> => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof RuntimeRefusal) return c.json({ error: err.message }, err.status);
      if (err instanceof OrgError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
      if (err instanceof BusyError) return c.json({ error: err.message }, 409);
      throw err;
    }
  };

/** A raw body as the route's object ({} when it isn't one), for a route that read it as text (its click proof). */
function jsonObject(raw: string): Record<string, unknown> {
  try {
    const b = JSON.parse(raw) as unknown;
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

function operatorBy(c: Context): OperatorBy {
  const overseerId = overseerSender(c.req.header(OVERSEER_SENDER_HEADER));
  if (!overseerId) return { kind: "operator" };
  const card = overseerCard(c.req.header(OVERSEER_CARD_HEADER));
  return { kind: "operator", via: "overseer", overseerId, ...(card ? { card } : {}) };
}

const opt = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The live server's ways to start and archive the Setup chat (server/projects/setup-chat.ts). */
function liveSetupDeps(app: Hono<any>): SetupDeps {
  return {
    // A plain coding build on its own worktree, never a verb playbook run: the registry's playbook region stays the
    // Project verbs playbook's, so the two never block each other.
    startRun: async (pid, input, envelope?: Envelope) => (await import("../project-overseer")).startSetupSession(pid, { ...input, mode: { mode: SETUP_MODE.mode, minorModes: [...SETUP_MODE.minorModes] }, ...(envelope ? { envelope } : {}) }),
    // A plain chat in the folder, made without a first message, set to the Setup chat's mode and model, then sent it.
    startChat: async (cwd, text, title, model) => {
      const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
      const json = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
      if (res.status !== 201 || !json?.id || !json.path) throw new RuntimeRefusal(`The Setup chat didn't start: ${json?.error ?? `HTTP ${res.status}`}`, 409);
      (await import("../session-titles")).writeAutoTitle(json.id, title);
      const chat = await (await import("../chat-handle")).acquireChatHandle(json.path);
      await chat.switchMode({ mode: SETUP_MODE.mode, minorModes: [...SETUP_MODE.minorModes] });
      if (model) {
        await chat.setModel(model.model);
        if (model.thinking) await chat.setThinking(model.thinking);
      }
      await chat.deliverToAgent(text);
      return { id: json.id, path: json.path };
    },
    archive: async (path) => {
      const r = await (await import("../sessions-index")).archiveSession(path, true);
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "refused" };
    },
    working: async (path) => !!(await (await import("./playbook-review")).runLive(path))?.working,
    // Remove Worktree on the build, then its branch, which has no commit beyond the target (nothing is lost).
    removeEmpty: async (pid, sessionId, branch) => {
      const po = await import("../project-overseer");
      await po.removeCodingWorktree(pid, sessionId).catch(() => undefined);
      const root = readProject(pid).root;
      const { NO_BACKGROUND_CLEANUP } = await import("../git-no-background");
      await realGit([...NO_BACKGROUND_CLEANUP, "branch", "-D", branch], root).catch(() => undefined);
    },
  };
}

/** A plain chat in `cwd`, titled and set to `mode` and the model, then sent `text`: the Setup chat's and a carry-on
    Project verbs chat's way to start in an earlier run's folder. */
async function plainChat(app: Hono<any>, cwd: string, text: string, title: string, mode: import("../../shared/project-overseer").ProjectCodingMode, model?: { model: string; thinking?: string }): Promise<{ id: string; path: string }> {
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  const json = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
  if (res.status !== 201 || !json?.id || !json.path) throw new RuntimeRefusal(`The chat didn't start: ${json?.error ?? `HTTP ${res.status}`}`, 409);
  (await import("../session-titles")).writeAutoTitle(json.id, title);
  const chat = await (await import("../chat-handle")).acquireChatHandle(json.path);
  await chat.switchMode({ mode: mode.mode, minorModes: [...mode.minorModes] } as Parameters<typeof chat.switchMode>[0]);
  if (model) {
    await chat.setModel(model.model);
    if (model.thinking) await chat.setThinking(model.thinking);
  }
  await chat.deliverToAgent(text);
  return { id: json.id, path: json.path };
}

const objOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The live server's ways for the standing Project verbs chat (server/projects/verbs-chat.ts). */
function liveVerbsDeps(app: Hono<any>): VerbsDeps {
  const buildData = async (pid: string, run: string) => {
    const engine = engineOf(pid);
    if (!engine || !isOrgHostOpen(engine)) return null;
    const host = hostOf(engine);
    const sid = buildSid(pid, run);
    return { data: host.data(sid), configuration: host.configuration(sid) ?? [] };
  };
  return {
    prompt: async (pid, input) => (await import("./onboard")).onboardStart(pid, input),
    startRun: async (pid, input, envelope) => {
      const made = await startOnboard(pid, input, envelope);
      const { readBuild } = await import("../build-loadout");
      const target = made.sessionId ? readBuild(pid, made.sessionId)?.worktree?.target : undefined;
      return { sessionId: made.sessionId, path: made.path, ...(made.worktree ? { worktree: made.worktree } : {}), ...(target ? { target } : {}), ...(made.notPrompted ? { notPrompted: made.notPrompted } : {}), ...(made.held ? { held: made.held } : {}) };
    },
    // On the run's own mode (the host's coding default with align, pinned when it started).
    startChat: async (pid, run, cwd, text, title, model) => {
      const b = await buildData(pid, run);
      const m = objOf(b?.data?.mode);
      const { hostDefaultMode, playbookRunMode } = await import("../project-coding-mode");
      const mode = (m.mode === "normal" || m.mode === "delegate") && Array.isArray(m.minorModes) ? { mode: m.mode as "normal" | "delegate", minorModes: m.minorModes as string[] } : playbookRunMode(hostDefaultMode());
      return plainChat(app, cwd, text, title, mode, model);
    },
    archive: async (path) => {
      const r = await (await import("../sessions-index")).archiveSession(path, true);
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? "refused" };
    },
    live: async (path) => {
      const l = await (await import("./playbook-review")).runLive(path);
      return { working: !!l?.working, questions: l?.questions ?? 0 };
    },
    dirty: async (worktree) => {
      const r = await realGit(["status", "--porcelain", "--untracked-files=normal"], worktree);
      return r.code === 0 && r.stdout.trim().length > 0;
    },
    deliver: async (path, text) => void (await (await (await import("../chat-handle")).acquireChatHandle(path)).deliverToAgent(text)),
    removeEmpty: async (pid, sessionId, branch) => {
      const po = await import("../project-overseer");
      await po.removeCodingWorktree(pid, sessionId).catch(() => undefined);
      const { NO_BACKGROUND_CLEANUP } = await import("../git-no-background");
      await realGit([...NO_BACKGROUND_CLEANUP, "branch", "-D", branch], readProject(pid).root).catch(() => undefined);
    },
    buildGone: (pid, run) => {
      // Sync read of the engine already open (verbs-chat asks while it decides).
      const engine = engineOf(pid);
      if (!engine || !isOrgHostOpen(engine)) return false;
      const cfg = hostOf(engine).configuration(buildSid(pid, run));
      return !cfg || cfg.some((c) => c === "tree-removed" || c === "retired" || c === "not-started");
    },
    adoptable: async (pid) => {
      const engine = engineOf(pid);
      if (!engine || !isOrgHostOpen(engine)) return null;
      const host = hostOf(engine);
      const { isArchived } = await import("../archived-sessions");
      const open = openOnboardRun(host.sessions("build"), pid, isArchived);
      if (!open) return null;
      const { readBuild, withWorktreePath, buildSessionPath } = await import("../build-loadout");
      const path = buildSessionPath(open.sessionId);
      const row = readBuild(pid, open.sessionId);
      if (!path || !row) return null;
      const wt = await withWorktreePath(row, readProject(pid).root);
      return { sessionId: open.sessionId, path, run: open.sessionId, ...(wt ? { branch: wt.worktree.branch, worktree: wt.worktree.path, target: wt.worktree.target } : {}) };
    },
    expectTurn: (pid, run, by) => expectVerbsTurn(pid, run, by),
    overseerMay: (pid, envelope) => overseerMayStart(pid, envelope),
  };
}

/** The project act's own refusals of an overseer's start that a delivered message keeps (its power, the brake, the
    unattended overseer while the software is registered and current), read without acting. */
function overseerMayStart(pid: string, envelope: Envelope): string | null {
  const engine = engineOf(pid);
  if (!engine || !isOrgHostOpen(engine)) return null;
  const host = hostOf(engine);
  const cfg = host.configuration(runtimeSid(pid)) ?? [];
  const standing = (["unregistered", "conforming", "registered", "stale", "failed"] as const).find((s) => cfg.includes(s));
  const r = host.explain(projectSid(pid), "verbs/onboard", { sessionId: "delivered", title: "", prompt: "", ...(standing ? { runtimeStanding: standing } : {}) }, envelope);
  // Only the power, the brake and the unattended rule: a delivered message starts no session, so no cap counts it.
  if (!r) return null;
  return r.code === "power-off" || r.code === "brake" || r.code === "operator" || r.sentence === NOTHING_TO_DO ? r.sentence : null;
}

/** The unattended overseer's refusal while the software is registered and current (proj.cljc nothing-to-do). */
const NOTHING_TO_DO = "The project's software is registered and current: the playbook has nothing to do.";

let verbsDepsLive: VerbsDeps | null = null;
/** The live ways for the standing Project verbs chat (the routes registered them); null before. */
export const verbsDeps = (): VerbsDeps => {
  if (!verbsDepsLive) throw new OrgError("The Project verbs chat isn't available on this server yet.", 409);
  return verbsDepsLive;
};

/**
 * An Overseer's `sova_project_verbs onboard` (§app.project-runtime/onboard, §app.project-overseer/tools): with the
 * project's Project verbs chat open and idle, the playbook's turn and why are its next message, never archiving it;
 * refused while it works, waits on the user's answers or holds a proposal not merged; with none open, a new chat.
 */
export async function overseerOnboard(pid: string, why: string, envelope: Envelope): Promise<{ text: string; details: Record<string, unknown> }> {
  return overseerOnboardAnswer(await overseerVerbsStart(pid, why, verbsDeps(), envelope));
}

/** What sova_project_verbs onboard answers, as the model reads it. */
export function overseerOnboardAnswer(made: OverseerVerbsStart): { text: string; details: Record<string, unknown> } {
  if (made.held) return { text: `Held: the Project verbs playbook waits until ${new Date(made.held.until).toISOString()} so the operator can cancel it; it goes ahead then unless cancelled.`, details: { held: made.held.id } };
  const where = made.worktree ? ` on the branch ${made.worktree.branch}` : "";
  if (made.delivered)
    return {
      text: `Sent the Project verbs playbook's turn to the project's open Project verbs chat (session ${made.sessionId})${where} as its next message. It proposes on its branch; the operator merges it, never you.`,
      details: { onboard: { sessionId: made.sessionId, delivered: true, ...(made.worktree ? { branch: made.worktree.branch } : {}) } },
    };
  return {
    text: `Started the Project verbs playbook (coding session ${made.sessionId})${where}. It proposes a definition on its branch; the operator merges it.${made.notPrompted ? ` ${made.notPrompted}` : ""}`,
    details: { onboard: { sessionId: made.sessionId, ...(made.worktree ? { branch: made.worktree.branch } : {}) } },
  };
}

/** Merge Branch on the Setup proposal: the queue's Land on a served project, else the build's worktree merged. */
const liveSetupMerge: SetupMergeDeps = {
  land: async (pid, root, sessionId, commit) => (await import("../project-overseer")).landThroughQueue(pid, root, sessionId, commit),
  merge: async (pid, sessionId) => void (await (await import("../project-overseer")).mergeCodingWorktree(pid, sessionId)),
};

/** Merge Branch on the Setup proposal is the user's own click on their page: never a chat, an Overseer or a script. */
export const SETUP_MERGE_WORDS = {
  overseer: "Only the user merges the Setup chat's proposal. Ask them to press Merge Branch or Land on its card. Nothing was merged.",
  local: "Only the user merges the Setup chat's proposal, from their own page on this computer. Nothing was merged.",
  chat: "Only the user merges the Setup chat's proposal: a chat never does. Ask them to press Merge Branch or Land on its card. Nothing was merged.",
  script: "Only the user merges the Setup chat's proposal, from their own page. Nothing was merged.",
  extension: "Only the user merges the Setup chat's proposal: an extension never does. Nothing was merged.",
} as const;

/** Start Fresh on the Project verbs chat: the user's own press on their page only. */
export const VERBS_FRESH_WORDS = {
  overseer: "Only the user starts the Project verbs chat fresh, from Start Fresh in its head. Nothing was archived or started.",
  local: "Only the user starts the Project verbs chat fresh, from their own page on this computer. Nothing was archived or started.",
  chat: "Only the user starts the Project verbs chat fresh: a chat never does. Nothing was archived or started.",
  script: "Only the user starts the Project verbs chat fresh, from their own page. Nothing was archived or started.",
  extension: "Only the user starts the Project verbs chat fresh: an extension never does. Nothing was archived or started.",
} as const;

/** Merge Branch on a proposed run (and its Land once the queue serves it): the operator's own page only. */
export const RUN_MERGE_WORDS = {
  overseer: "Only the user merges a proposed branch. Ask them to press Merge Branch or Land. Nothing was merged.",
  local: "Only the user merges a proposed branch, from their own page on this computer. Nothing was merged.",
  chat: "Only the user merges a proposed branch: a chat never does. Ask them to press Merge Branch or Land. Nothing was merged.",
  script: "Only the user merges a proposed branch, from their own page. Nothing was merged.",
  extension: "Only the user merges a proposed branch: an extension never does. Nothing was merged.",
} as const;

export function registerRuntimeRoutes(app: Hono<any>): void {
  startRuntimeTick();
  verbsDepsLive = liveVerbsDeps(app);

  // The Setup chat (§app.project-setup/chat, /start): its state, and Set Up with a Chat / Change Setup / Start Fresh.
  app.get("/api/projects/:pid/setup", handle(async (c) => c.json(await readSetup(c.req.param("pid") ?? ""), 200, NO_STORE)));
  app.post(
    "/api/projects/:pid/setup",
    handle(async (c) => {
      const pid = c.req.param("pid") ?? "";
      const b = await body(c);
      if (b.from !== undefined && !(SETUP_FROM as readonly unknown[]).includes(b.from)) return c.json({ error: `from is one of ${SETUP_FROM.join(", ")}.` }, 400);
      const input = { ...(b.fresh === true ? { fresh: true } : {}), ...(b.from ? { from: b.from as SetupFrom } : {}), ...(opt(b.why) ? { why: opt(b.why) } : {}), ...(opt(b.model) ? { model: opt(b.model) } : {}), ...(opt(b.thinking) ? { thinking: opt(b.thinking) } : {}) };
      const made = await openSetup(pid, input, liveSetupDeps(app), operatorEnvelopeOf(pid, operatorBy(c)));
      return c.json(made, made.reopened ? 200 : 201, NO_STORE);
    }),
  );
  // Merge Branch / Land on the Setup proposal (§app.project-setup/proposal): the operator's own page only.
  app.post(
    "/api/projects/:pid/setup/merge",
    handle(async (c) => {
      const refused = pageOnlyRefusal(c, SETUP_MERGE_WORDS);
      if (refused) return c.json({ error: refused }, 403);
      const pid = c.req.param("pid") ?? "";
      const b = await body(c);
      const hash = opt(b.hash);
      if (!hash) return c.json({ error: "Give the hash you were shown (hash)." }, 400);
      const out = await mergeSetup(pid, hash, opt(b.commit), liveSetupMerge);
      return c.json({ ...out, setup: await readSetup(pid) }, 200, NO_STORE);
    }),
  );

  app.get("/api/projects/:pid/runtime", handle(async (c) => c.json(await readRuntime(c.req.param("pid") ?? ""), 200, NO_STORE)));

  // Merge Branch on a proposed run (§app.project-runtime/merge): a refused merge says why (409).
  app.post(
    "/api/projects/:pid/runtime/merge",
    handle(async (c) => {
      // Merge Branch lands the branch (a Land once the queue serves it): the operator's own page only, whatever it proposes
      // (§app.access/your-click). A script, a chat's shell, an in-process call: refused before anything is read.
      // A Setup proposal keeps the Setup route's rule (this machine's page only); any other proposal also takes a proven
      // click from another of the user's computers (server/mesh/click-proof.ts), as Land does.
      const isSetup = !!(await import("./playbook-review")).playbookReviewOf(c.req.param("pid") ?? "")?.setup;
      const raw = await c.req.text().catch(() => "");
      if (isSetup) {
        const notYou = pageOnlyRefusal(c, SETUP_MERGE_WORDS);
        if (notYou) return c.json({ error: notYou }, 403);
      } else if (await notPageNorProven(c, raw)) return c.json({ error: RUN_MERGE_WORDS[notPage(c) ?? "script"] }, 403);
      const b = jsonObject(raw);
      const hash = opt(b.hash);
      if (!hash) return c.json({ error: "Give the hash you were shown (hash)." }, 400);
      // Needs you's Merge Branch on a Setup proposal: the Setup route's own rules (the user's click only).
      const pid0 = c.req.param("pid") ?? "";
      if ((await import("./playbook-review")).playbookReviewOf(pid0)?.setup) {
        const refused = pageOnlyRefusal(c, SETUP_MERGE_WORDS);
        if (refused) return c.json({ error: refused }, 403);
        const done = await mergeSetup(pid0, hash, opt(b.commit), liveSetupMerge);
        return c.json({ ...(await readRuntime(pid0)), ...(done.queued ? { queued: true } : {}) }, 200, NO_STORE);
      }
      const out = await mergeRun(c.req.param("pid") ?? "", hash, opt(b.commit));
      if (out.refused) return c.json({ error: `The merge was refused: ${out.refused}`, runtime: out.view }, 409, NO_STORE);
      return c.json(out.view, 200, NO_STORE);
    }),
  );

  app.post(
    "/api/projects/:pid/verbs/onboard",
    handle(async (c) => {
      const pid = c.req.param("pid") ?? "";
      const b = await body(c);
      const input = { ...(opt(b.why) ? { why: opt(b.why) } : {}), ...(opt(b.model) ? { model: opt(b.model) } : {}), ...(opt(b.thinking) ? { thinking: opt(b.thinking) } : {}), ...(opt(b.playbook) ? { playbook: opt(b.playbook) } : {}) };
      // The setup playbooks folded into the Setup chat (and its own) open the Setup chat: never a second one.
      const pbId = opt(b.playbook);
      if (pbId && (pbId === SETUP_PLAYBOOK_ID || FOLDED_PLAYBOOKS.includes(pbId))) {
        const opened = await openSetup(pid, { ...(input.why ? { why: input.why } : {}), ...(input.model ? { model: input.model } : {}), ...(input.thinking ? { thinking: input.thinking } : {}) }, liveSetupDeps(app), operatorEnvelopeOf(pid, operatorBy(c)));
        return c.json({ sessionId: opened.sessionId, path: opened.path, ...(opened.worktree ? { worktree: opened.worktree } : {}), reopened: opened.reopened }, opened.reopened ? 200 : 201);
      }
      // Another verb playbook a project lists runs as before; the Project verbs playbook is the project's standing chat:
      // a press opens it when it is open (sending nothing), else starts one (§app.project-runtime/onboard).
      if (pbId && pbId !== ONBOARD_PLAYBOOK_ID) {
        const made = await startOnboard(pid, input, operatorEnvelopeOf(pid, operatorBy(c)));
        return c.json({ sessionId: made.sessionId, path: made.path, ...(made.worktree ? { worktree: made.worktree } : {}), ...(made.notPrompted ? { notPrompted: made.notPrompted } : {}) }, 201);
      }
      const opened = await openVerbsChat(pid, input, verbsDeps(), operatorEnvelopeOf(pid, operatorBy(c)));
      return c.json(opened, opened.reopened ? 200 : 201, NO_STORE);
    }),
  );

  // The standing Project verbs chat (§app.project-runtime/onboard): as its head reads it, and Start Fresh.
  app.get("/api/projects/:pid/verbs/chat", handle(async (c) => c.json(await readVerbsChat(c.req.param("pid") ?? "", verbsDeps()), 200, NO_STORE)));
  app.post(
    "/api/projects/:pid/verbs/chat/fresh",
    handle(async (c) => {
      // Start Fresh is the operator's own press on their page: never an overseer's, a chat's or a script's.
      const refused = pageOnlyRefusal(c, VERBS_FRESH_WORDS);
      if (refused) return c.json({ error: refused }, 403);
      const pid = c.req.param("pid") ?? "";
      const b = await body(c);
      const made = await freshVerbsChat(pid, { ...(opt(b.model) ? { model: opt(b.model) } : {}), ...(opt(b.thinking) ? { thinking: opt(b.thinking) } : {}) }, verbsDeps(), operatorEnvelopeOf(pid, operatorBy(c)));
      return c.json(made, 201, NO_STORE);
    }),
  );
}
