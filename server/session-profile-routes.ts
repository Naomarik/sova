import type { Hono } from "hono";
import { keyOf, type ProfilesListing } from "../shared/profiles";
import type { SessionSummary } from "../shared/protocol";
import { acquireChat, disposeHeldChat, heldChat, setSingletonCheck } from "./chat-manager";
import { getSessionInsight } from "./insights";
import { resolveSessionPath } from "./paths";
import { findProfile, profileSources, readHidden, setHidden } from "./profile-sources";
import { approve } from "./profile-trust";
import { projectRootOf } from "./project-root";
import { setPowersHost } from "./session-powers";
import { resolveChoice, singletonHolder, SingletonRefusal, snapshotKey, type ProfileChoice } from "./session-profile";
import { getSessionSummary, listSessions } from "./sessions-index";
import { normalizeEntries, readActiveBranch } from "./transcript";

/**
 * Profiles over HTTP (§chat.profiles/applying, /projects, /trust, §app.settings-dialog/profiles),
 * the One at a time check the chat runtime runs at a first message, and the host the session
 * powers reach other sessions through (§chat.profiles/session-tools). Registered by server/index.ts.
 * Profile files are never written here: only a pick, an approval and hide/show.
 */

export type ApplyResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; error: string; running?: { id: string; path: string; title: string }; approval?: true };

const holderOf = (s: SessionSummary) => ({ id: s.id, path: s.path, title: s.title });

/** One pick at a time, so two picks of a One at a time profile can't both pass the check. */
let applying: Promise<unknown> = Promise.resolve();

/**
 * Write a session's profile and reopen its runtime (§chat.profiles/applying). `by`: who picked it
 * when it wasn't the user on the empty screen. A profile's mode and model are applied in the same
 * step. Refused once a message is on the branch, mid-turn, TUI-live, for a foreign writer, for a
 * special session, and for a One at a time profile live elsewhere.
 */
export function applyProfile(path: string, choice: ProfileChoice, by?: "overseer" | "start"): Promise<ApplyResult> {
  const run = applying.then(() => applyNow(path, choice, by));
  applying = run.catch(() => undefined);
  return run;
}

async function applyNow(path: string, choice: ProfileChoice, by?: "overseer" | "start"): Promise<ApplyResult> {
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  if (s.overseer || s.projectOverseer || s.baton || s.org || s.workerSession) return { ok: false, status: 409, error: "This session can't take a profile." };
  if (s.live) return { ok: false, status: 409, error: `It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.` };
  const r = await resolveChoice(choice, s.cwd);
  if (!r.ok) return { ok: false, status: r.approval ? 409 : 400, error: r.error, ...(r.approval ? { approval: true as const } : {}) };
  if (r.profile?.singleton) {
    const holder = singletonHolder(snapshotKey(r.profile), await listSessions(), path);
    if (holder) return { ok: false, status: 409, error: new SingletonRefusal(r.profile.label, holderOf(holder)).message, running: holderOf(holder) };
  }
  let chat;
  try {
    chat = await acquireChat(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    chat.writeProfile({ v: 1, profile: r.profile, ...(by ? { by } : {}) });
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  // Starts with: its mode (pinned) and its model, before the reopen.
  if (r.profile?.mode) {
    await chat
      .switchMode({ mode: r.profile.mode as "normal" | "delegate" })
      .then(() => chat.pinMode())
      .catch((err) => console.warn(`[profiles] mode not applied: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (r.profile?.model) await chat.setModelRef(r.profile.model).catch((err) => console.warn(`[profiles] model not applied: ${err instanceof Error ? err.message : String(err)}`));
  await disposeHeldChat(path, "Applying the profile.");
  return { ok: true };
}

/** GET /api/profiles?cwd=: every profile a session in `cwd` can use (§chat.profiles/projects). */
export async function profilesListing(cwd?: string | null): Promise<ProfilesListing> {
  const [src, all] = await Promise.all([profileSources(cwd), listSessions()]);
  const running: ProfilesListing["running"] = {};
  const everRun = new Set<string>();
  for (const s of all) {
    const p = s.profile;
    if (!p?.singleton || p.custom) continue;
    const key = keyOf(p);
    everRun.add(key);
    if (!s.archived && !running[key]) running[key] = holderOf(s);
  }
  return {
    builtins: src.builtins,
    yours: src.yours,
    yoursFile: src.yoursFile,
    project: src.project,
    problems: src.problems,
    hidden: readHidden(),
    running,
    everRun: [...everRun],
    ...(src.yoursError ? { error: src.yoursError } : {}),
  };
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function registerProfileRoutes(app: Hono): void {
  app.get("/api/profiles", async (c) => c.json(await profilesListing(c.req.query("cwd"))));
  // Approve a project profile's powers (§chat.profiles/trust): the ones the file has now, and only
  // when they are the ones the client was shown.
  app.post("/api/profiles/approve", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; id?: unknown; grant?: unknown; overseerMayStart?: unknown } | null;
    const cwd = str(body?.cwd);
    const id = str(body?.id);
    if (!cwd || !id || !Array.isArray(body?.grant) || typeof body?.overseerMayStart !== "boolean")
      return c.json({ error: "Expected {cwd, id, grant, overseerMayStart}" }, 400);
    const p = await findProfile({ source: "project", id }, cwd);
    if (!p) return c.json({ error: `No profile "${id}" in this folder's project.` }, 404);
    try {
      approve(p, { grant: body.grant as never, overseerMayStart: body.overseerMayStart });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
    return c.json(await profilesListing(cwd));
  });
  // Hide From Picker / Show In Picker, by identity.
  app.post("/api/profiles/hidden", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown; hidden?: unknown; cwd?: unknown } | null;
    const key = str(body?.key);
    if (!key || typeof body?.hidden !== "boolean") return c.json({ error: "Expected {key, hidden}" }, 400);
    try {
      setHidden(key, body.hidden);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.json(await profilesListing(str(body.cwd)));
  });
  app.post("/api/sessions/profile", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; profile?: unknown } | null;
    const path = resolveSessionPath(typeof body?.path === "string" ? body.path : null);
    if (!path) return c.json({ error: "Invalid or missing path" }, 400);
    const r = await applyProfile(path, (body?.profile ?? null) as ProfileChoice);
    return r.ok ? c.json({ ok: true }) : c.json({ error: r.error, ...(r.running ? { running: r.running } : {}), ...(r.approval ? { approval: true } : {}) }, r.status);
  });
}

// The first message of a One at a time session (chat-manager's check).
setSingletonCheck(async (key, path) => {
  const holder = singletonHolder(key, await listSessions(), path);
  return holder ? holderOf(holder) : null;
});

setPowersHost({
  sessions: () => listSessions(),
  async session(id) {
    const s = (await listSessions()).find((x) => x.id === id);
    return s ? ((await getSessionSummary(s.path)) ?? s) : null;
  },
  transcript: async (path) => normalizeEntries(await readActiveBranch(path)),
  insight: (path) => getSessionInsight(path),
  held(path) {
    const chat = heldChat(path);
    return chat ? { streaming: chat.session.isStreaming, queued: chat.queue.size } : null;
  },
  projectRoot: (cwd) => projectRootOf(cwd),
  async send(path, text, delivery, from) {
    const s = await getSessionSummary(path);
    if (!s) return { ok: false, error: "That session no longer exists." };
    if (s.live) return { ok: false, error: `"${s.title}" is open in a terminal (pid ${s.live.pid}), so it is read-only.` };
    let chat;
    try {
      chat = await acquireChat(path);
    } catch (err) {
      return { ok: false, error: `"${s.title}" can't take messages now: ${err instanceof Error ? err.message : String(err)}` };
    }
    // A pristine One at a time session's first message: the same check as its composer's.
    const single = chat.profileState?.data?.profile;
    if (single?.singleton && chat.pristine && singletonHolder(snapshotKey(single), await listSessions(), path))
      return { ok: false, error: `${single.label} is set to One at a time and runs in another session, so "${s.title}" takes no first message.` };
    try {
      chat.assertModelAllowed();
      const r = chat.acceptPrompt(text, undefined, "server", undefined, { ...(delivery ? { delivery } : {}), sentBySession: from });
      void r.turn.catch((err) => chat.reportTurnFailure(err));
      return { ok: true, queued: r.queued, kind: r.queued ? (delivery ?? "followUp") : "prompt" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
