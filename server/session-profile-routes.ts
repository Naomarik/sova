import type { Hono } from "hono";
import { DEFAULT_PROFILE, keyOf, parseMine, THINKING_LEVELS, type ListedProfile, type Profile, type ProfileMine, type ProfilesListing } from "../shared/profiles";
import type { SessionSummary } from "../shared/protocol";
import { acquireChatHandle, chatHandle, type ChatHandle, closeChat, setOpeningChoice, setSingletonCheck } from "./chat-handle";
import { modelDenial, readModelPolicy } from "./model-policy";
import { parseModePatch, readMode, type ModePatch } from "./mode-state";
import { listModels } from "./models";
import { addProfile } from "./profiles-store";
import { subagentProfilesInfo } from "./subagent-profiles";
import { getSessionInsight } from "./insights";
import { resolveSessionPath } from "./paths";
import { findProfile, profileSources, readHidden, setHidden } from "./profile-sources";
import { approve } from "./profile-trust";
import { projectRootOf } from "./project-root";
import { type PowersHost, type PowersSend, type PowersSendResult, sendInviting, setPowersHost } from "./session-powers";
import { resolveChoice, singletonHolder, SingletonRefusal, snapshotKey, type ProfileChoice } from "./session-profile";
import { getSessionSummary, listSessions } from "./sessions-index";
import { rowsOf } from "./transcript";
import { readBranch } from "./harness/pi/reader";

/**
 * Profiles over HTTP (§chat.profiles/applying, /projects, /trust, §app.settings-dialog/profiles),
 * the One at a time check the chat runtime runs at a first message, and the host the session
 * powers reach other sessions through (§chat.profiles/session-tools). Registered by server/index.ts.
 * Profile files are written here only by Save Current As Profile, and only yours (profiles-store
 * addProfile); otherwise only a pick, an approval and hide/show.
 */

export type ApplyResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409; error: string; running?: { id: string; path: string; title: string }; approval?: true };

const holderOf = (s: SessionSummary) => ({ id: s.id, path: s.path, title: s.title });

/** One pick at a time, so two picks of a One at a time profile can't both pass the check. */
let applying: Promise<unknown> = Promise.resolve();

/**
 * Write a session's profile and reopen its runtime (§chat.profiles/applying). `by`: who picked it
 * when it wasn't the user on the empty screen. A profile's mode, minor modes and model are applied
 * in the same step. Refused once a message is on the branch, mid-turn, TUI-live, for a foreign writer, for a
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
    chat = await acquireChatHandle(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  const next = r.profile;
  const prevData = chat.mirror.profile;
  const prev = prevData?.profile ?? null;
  // What My settings puts back: what the session had at its first profile pick, carried from one
  // profile to the next, and replayed (then dropped) when My settings is picked again.
  const remembered = prev ? parseMine(prevData?.mine) : undefined;
  const mine = next ? (prev ? remembered : mineOf(chat)) : undefined;
  const restore = !next ? remembered : undefined;
  // Everything the pick sets is checked here first, so a pick that can't apply writes nothing.
  if (next?.model) {
    const why = modelDenial(readModelPolicy(), next.model) ?? (await chat.findModel(next.model).then((f) => (f.ok ? null : f.error)));
    if (why) return { ok: false, status: 400, error: `${next.label} can't be picked here: ${why}` };
  }
  if (next?.thinking && !(THINKING_LEVELS as readonly string[]).includes(next.thinking))
    return { ok: false, status: 400, error: `${next.label} can't be picked here: "${next.thinking}" isn't an effort level.` };
  // Switching back from a profile that set subagents pins the remembered pick, else the device
  // default, since a pick can't be cleared; a chat that never had a pick gets none.
  let subagents = next?.subagents;
  const own = restore?.subagents && !subagentsUnusable(restore.subagents) ? restore.subagents : undefined;
  if (!subagents && own) subagents = own !== chat.mirror.subagentPick ? own : undefined;
  else if (!subagents && prev?.subagents && chat.mirror.subagentPick !== undefined) subagents = subagentProfilesInfo().default;
  if (subagents) {
    const why = (next?.subagents ? subagentsUnusable(next.subagents) : null) ?? (await chat.subagentSwitchRefusal());
    if (why) return { ok: false, status: 400, error: `${next?.label ?? DEFAULT_PROFILE.label} can't be picked here: ${why}` };
  }
  // A profile without a model or effort, after one that set it: back to what a new session opens on
  // (the new-session default when usable, else pi's own; read, never written), by a fresh reopen
  // below. My settings puts back the remembered ones instead, a model that can't be used now aside.
  let model = next?.model;
  let thinking = next?.thinking;
  const fresh = { model: !next?.model && !!prev?.model, thinking: !next?.thinking && !!prev?.thinking };
  if (restore?.model && restore.model !== chat.mirror.model?.ref) {
    const usable = !modelDenial(readModelPolicy(), restore.model) && (await chat.findModel(restore.model).then((f) => f.ok, () => false));
    if (usable) (model = restore.model), (fresh.model = false);
  } else if (restore?.model) fresh.model = false;
  // The effort after the model: a model switch re-clamps it.
  if (restore?.thinking && (THINKING_LEVELS as readonly string[]).includes(restore.thinking) && (model || restore.thinking !== chat.mirror.thinking))
    (thinking = restore.thinking as Profile["thinking"]), (fresh.thinking = false);
  else if (restore?.thinking === chat.mirror.thinking) fresh.thinking = false;
  // Its mode and minor modes, pinned together; a field it doesn't set, after a profile that set it,
  // goes back to mode.json's default (read, never written) and is pinned with the other. My settings
  // puts back the remembered pair when it differs from now.
  const modePatch: ModePatch = {};
  const back = restore ? parseModePatch({ mode: restore.mode, minorModes: restore.minorModes }) : null;
  if (back && !("error" in back)) {
    const now = chat.mirror.mode;
    const want = back.minorModes ?? [];
    if (back.mode !== now.mode || want.length !== now.minorModes.length || want.some((m) => !now.minorModes.includes(m))) {
      modePatch.mode = back.mode;
      modePatch.minorModes = [...want];
    }
  } else {
    if (next?.mode) modePatch.mode = next.mode as ModePatch["mode"];
    else if (prev?.mode) modePatch.mode = readMode().mode;
    if (next?.minorModes) modePatch.minorModes = [...next.minorModes];
    else if (prev?.minorModes) modePatch.minorModes = [...readMode().minorModes];
  }
  try {
    await chat.writeProfile({ v: 1, profile: next, ...(by ? { by } : {}), ...(mine ? { mine } : {}) });
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  // Starts with: its mode and minor modes (pinned), model, effort and subagent pick, before the reopen. None saves a default.
  const failed: string[] = [];
  const step = async (what: string, run: () => unknown) => {
    try {
      await run();
    } catch (err) {
      failed.push(`its ${what} wasn't (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  if (modePatch.mode || modePatch.minorModes) await step("mode", () => chat.switchMode(modePatch).then(() => chat.pinMode()));
  if (model && model !== chat.mirror.model?.ref) await step("model", () => chat.setModel(model));
  if (thinking) await step("effort", () => chat.setThinking(thinking));
  if (subagents) await step("subagent profile", () => chat.switchSubagentProfile(subagents));
  await closeChat(path, "Applying the profile.");
  if (fresh.model || fresh.thinking) {
    setOpeningChoice(path, { fresh });
    await step("model and effort reset", async () => {
      const reopened = await acquireChatHandle(path);
      await reopened.flushDeferredAppends();
    });
    await closeChat(path, "Applying the profile.");
  }
  if (failed.length) return { ok: false, status: 409, error: `${next?.label ?? DEFAULT_PROFILE.label} was picked, but ${failed.join(", and ")}.` };
  return { ok: true };
}

/** What a session has now, as My settings remembers it at its first profile pick. */
function mineOf(chat: Pick<ChatHandle, "mirror">): ProfileMine {
  const m = chat.mirror;
  const ref = m.model?.ref;
  const thinking = m.thinking;
  return {
    mode: m.mode.mode,
    minorModes: [...m.mode.minorModes],
    ...(ref ? { model: ref } : {}),
    ...((THINKING_LEVELS as readonly string[]).includes(thinking) ? { thinking } : {}),
    ...(m.subagentPick ? { subagents: m.subagentPick } : {}),
  };
}

/** Why a profile's subagent profile can't be picked on this device, or null. */
function subagentsUnusable(id: string, info = subagentProfilesInfo()): string | null {
  if (info.error) return `this device's subagent profiles can't be read (${info.error}).`;
  return info.profiles.some((p) => p.id === id) ? null : `Its subagent profile "${id}" isn't in this device's library.`;
}

/**
 * Why each profile that sets a model or subagents can't be used on this host now, by key: the
 * model policy's sentence, a model with no credentials here, a subagent profile this device lacks.
 */
async function unusableProfiles(profiles: readonly ListedProfile[], info = subagentProfilesInfo()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const policy = readModelPolicy();
  let available: Set<string> | null = null;
  if (profiles.some((p) => p.model)) available = await listModels().then((ms) => new Set(ms.map((m) => m.ref)), () => null);
  for (const p of profiles) {
    const why =
      (p.model ? (modelDenial(policy, p.model) ?? (available && !available.has(p.model) ? `No credentials here for ${p.model}.` : null)) : null) ??
      (p.subagents ? subagentsUnusable(p.subagents, info) : null);
    if (why) out[p.key] = why;
  }
  return out;
}

/**
 * Save Current As Profile: the session's model, effort and its own subagent pick (none when it
 * follows the device default) as a new capability-neutral profile in yours. The session itself
 * doesn't change. Answers with the session's listing, the new profile in it.
 */
export async function saveCurrentProfile(path: string, label: string): Promise<{ ok: true; profile: Profile; listing: ProfilesListing } | { ok: false; status: 400 | 404 | 409; error: string }> {
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  let chat = chatHandle(path);
  try {
    chat ??= await acquireChatHandle(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  const thinking = chat.mirror.thinking;
  const ref = chat.mirror.model?.ref;
  const pick = chat.mirror.subagentPick;
  try {
    const profile = addProfile({
      label,
      ...(ref ? { model: ref } : {}),
      ...((THINKING_LEVELS as readonly string[]).includes(thinking) ? { thinking: thinking as Profile["thinking"] } : {}),
      ...(pick ? { subagents: pick } : {}),
    });
    return { ok: true, profile, listing: await profilesListing(s.cwd) };
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
}

/** GET /api/profiles?cwd=: every profile a session in `cwd` can use (§chat.profiles/projects). */
export async function profilesListing(cwd?: string | null): Promise<ProfilesListing> {
  const [src, all] = await Promise.all([profileSources(cwd), listSessions()]);
  const running: ProfilesListing["running"] = {};
  for (const s of all) {
    const p = s.profile;
    if (!p?.singleton || p.custom || s.archived) continue;
    const key = keyOf(p);
    if (!running[key]) running[key] = holderOf(s);
  }
  const info = subagentProfilesInfo();
  const unusable = await unusableProfiles([...src.builtins, ...src.yours, ...src.project.profiles], info);
  return {
    builtins: src.builtins,
    yours: src.yours,
    yoursFile: src.yoursFile,
    project: src.project,
    problems: src.problems,
    hidden: readHidden(),
    running,
    unusable,
    subagents: info.profiles.map((p) => ({ id: p.id, name: p.name, footprint: p.footprint })),
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
  // Save Current As Profile: this session's model, effort and subagent pick as a new profile of yours.
  app.post("/api/profiles/save-current", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; label?: unknown } | null;
    const path = resolveSessionPath(typeof body?.path === "string" ? body.path : null);
    const label = str(body?.label);
    if (!path || !label) return c.json({ error: "Expected {path, label}" }, 400);
    const r = await saveCurrentProfile(path, label);
    return r.ok ? c.json(r.listing) : c.json({ error: r.error }, r.status);
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

/** A session message handed to its target by this server (a chat here, or a chat process's
    `@powers.send` action): the target's own checks, then its send, marked as the sender's. */
async function sendToSession({ path, text, delivery, from }: PowersSend): Promise<PowersSendResult> {
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, error: "That session no longer exists." };
  if (s.live) return { ok: false, error: `"${s.title}" is open in a terminal (pid ${s.live.pid}), so it is read-only.` };
  let chat;
  try {
    chat = await acquireChatHandle(path);
  } catch (err) {
    return { ok: false, error: `"${s.title}" can't take messages now: ${err instanceof Error ? err.message : String(err)}` };
  }
  // A pristine One at a time session's first message: the same check as its composer's.
  const single = chat.mirror.profile?.profile;
  if (single?.singleton && chat.mirror.pristine && singletonHolder(snapshotKey(single), await listSessions(), path))
    return { ok: false, error: `${single.label} is set to One at a time and runs in another session, so "${s.title}" takes no first message.` };
  try {
    const r = await chat.send({ text, origin: "server", checkModel: true, ...(delivery ? { delivery } : {}), sentBySession: from });
    return { ok: true, queued: r.queued, kind: r.queued ? (delivery ?? "followUp") : "prompt" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Session powers as this server answers them: the tools of a chat it hosts, and the asks and
    `@powers.send` action of a chat in a process of its own (chat-handle.ts answerChatAsk). */
export const powersHost: PowersHost = {
  sessions: () => listSessions(),
  async session(id) {
    const s = (await listSessions()).find((x) => x.id === id);
    return s ? ((await getSessionSummary(s.path)) ?? s) : null;
  },
  transcript: async (path) => rowsOf(await readBranch(path)),
  insight: (path) => getSessionInsight(path),
  held(path) {
    const chat = chatHandle(path);
    return chat ? { streaming: chat.mirror.running, queued: chat.mirror.queue.web } : null;
  },
  projectRoot: (cwd) => projectRootOf(cwd),
  send: (a) => sendInviting(a, sendToSession),
};
setPowersHost(powersHost);
