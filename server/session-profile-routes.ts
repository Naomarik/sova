import { yourClickRefusal } from "./page-only";
import type { Hono } from "hono";
import { QUEUE_CHAT_MODE_REFUSAL } from "../shared/merge-queue";
import { DEFAULT_PROFILE, keyOf, OFF_ID, OFF_KEY, THINKING_LEVELS, type JoinedProfile, type ListedProfile, type ProfilesListing } from "../shared/profiles";
import type { SessionSummary } from "../shared/protocol";
import { acquireChatHandle, chatHandle, type ChatHandle, closeChat, setOpeningChoice, setSingletonCheck } from "./chat-handle";
import { modelDenial, readModelPolicy } from "./model-policy";
import { parseModePatch, readMode, type ModePatch } from "./mode-state";
import { listModels, modelNames } from "./models";
import { profileModelCount, subagentProfilesInfo } from "./subagent-profiles";
import { getSessionInsight } from "./insights";
import { helperProfileOf, loadSubagentProfiles } from "../pi-config/extensions/subagents/subagent-profiles.ts";
import { readConnectedAccounts } from "../pi-config/extensions/subagents/builtin-profiles.ts";
import { chatProfileKey, switchChatProfile } from "./profile-switch";
import { isNoDefault, newChatStarts, resolveDefaultProfile, startsBase } from "./default-profile";
import { buildJoined, joinedProfiles, pickJoined } from "./joined-profiles";
import { agentRoot } from "./state-root";
import { resolveSessionPath } from "./paths";
import { findProfile, profileRefusedWhy, profileSources, readHidden, setHidden } from "./profile-sources";
import { approve } from "./profile-trust";
import { projectRootOf } from "./project-root";
import { type PowersHost, type PowersSend, type PowersSendResult, sendInviting, setPowersHost } from "./session-powers";
import { resolveChoice, singletonHolder, SingletonRefusal, snapshotKey, type ProfileChoice } from "./session-profile";
import { getSessionSummary, listedSession, listSessions } from "./sessions-index";
import { rowsOf } from "./transcript";
import { readBranch } from "./harness/pi/reader";
import { noteDefaultNotApplied } from "./default-start-notes";

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
  // A pick that took is what the chat is on now: a new chat's note that it missed the default is spent.
  const run = applying.then(() => applyNow(path, choice, by)).then((r) => {
    // Every open pane hears it, also after a pick that doesn't reopen the chat (helpers alone).
    if (r.ok && noteDefaultNotApplied(path, null)) chatHandle(path)?.resendProfile();
    return r;
  });
  applying = run.catch(() => undefined);
  return run;
}

/** An older build's Off, or no profile at all: both mean this computer's default now. */
const namesDefault = (choice: ProfileChoice): boolean =>
  choice === null || choice === OFF_ID || choice === OFF_KEY || choice === DEFAULT_PROFILE.id ||
  (!!choice && typeof choice === "object" && (choice as { source?: unknown }).source === "sova" && (choice as { id?: unknown }).id === DEFAULT_PROFILE.id);

/** The choice the default row is picked by: its session half, else its helpers alone. */
const choiceOfRow = (row: JoinedProfile): ProfileChoice =>
  row.session ? { source: row.session.source, id: row.session.id } : `library:${row.libraryId ?? row.id}`;
/* A project row's session half resolves in the session's own project (resolveChoice looks there first). */

async function applyNow(path: string, choice: ProfileChoice, by?: "overseer" | "start"): Promise<ApplyResult> {
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  if (s.overseer || s.projectOverseer || s.baton || s.org || s.workerSession) return { ok: false, status: 409, error: "This session can't take a profile." };
  // The merge queue's own chats are marked by their Sova profile (queueChatRole): another pick would unmark them,
  // lift their mode lock and put them back in every list. The server's own start applies to a session not yet marked.
  if (s.queueChat) return { ok: false, status: 409, error: QUEUE_CHAT_MODE_REFUSAL };
  if (s.live) return { ok: false, status: 409, error: `It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.` };
  // The user's pick of no profile (an older page's Off card, a board that changes nothing) is this computer's
  // default. A server start that names none (a run's new chat) keeps no profile of its own, as always.
  if (!by && namesDefault(choice)) {
    // One nobody chose (the built-in one the accounts give) gives its helpers alone, as a new chat gets them.
    const d = await resolveDefaultProfile(s.cwd);
    // No default at all (nothing chosen, no account connected): a pick of no profile, which sets nothing.
    choice = isNoDefault(d.row) ? null : d.fromAccounts && (d.row.libraryId ?? d.row.library?.id) ? `library:${d.row.libraryId ?? d.row.library!.id}` : choiceOfRow(d.row);
  }
  // A joined key ("sova:claude", "user:night", "project:<root>#id"): the row it names, a built-in profile's
  // place taken by one of yours included.
  if (typeof choice === "string" && /^(sova|user|project):/.test(choice)) {
    const row = pickJoined(await joinedProfiles(s.cwd), choice);
    if (!row) return { ok: false, status: 400, error: `No profile "${choice}" for this folder. It may have been deleted, or it belongs to another project.` };
    choice = choiceOfRow(row);
  }
  // A library profile no session profile links (§chat.profiles/joined) is picked by its helpers alone.
  let libraryPick = libraryPickOf(choice);
  // A board made from no card is named after the profile the chat is on.
  const board = !!choice && typeof choice === "object" && Array.isArray((choice as { remove?: unknown }).remove) && !(choice as { from?: unknown }).from;
  const inEffect = board ? await acquireChatHandle(path).then(async (c) => (await c.chatProfileState()).current.name, () => undefined) : undefined;
  let r = await resolveChoice(libraryPick ? null : choice, s.cwd, inEffect);
  if (!r.ok && typeof choice === "string" && !r.approval) {
    const row = (await joinedProfiles(s.cwd)).find((x) => x.kind === "library" && x.id === choice);
    if (row) (libraryPick = { id: row.id, name: row.name }), (r = { ok: true, profile: null });
  }
  if (!r.ok) return { ok: false, status: r.approval ? 409 : 400, error: r.error, ...(r.approval ? { approval: true as const } : {}) };
  const none = !by && !libraryPick && !r.profile ? await resolveDefaultProfile(s.cwd) : null;
  if (none && !isNoDefault(none.row)) {
    // A board that sets nothing: the default, as above (with no default at all, nothing).
    const d = none;
    const row = d.row;
    if (row.session && !d.fromAccounts) r = await resolveChoice(choiceOfRow(row), s.cwd);
    else libraryPick = { id: row.libraryId ?? row.id, name: row.name };
    if (!r.ok) return { ok: false, status: 400, error: r.error };
  }
  if (libraryPick) {
    const why = subagentsUnusable(libraryPick.id);
    if (why) return { ok: false, status: 400, error: `${libraryPick.name} can't be picked here: ${why}` };
  }
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
  const prevData = chat.mirror.profile;
  const prev = prevData?.profile ?? null;
  // Helpers alone, on a chat that started on no profile: only the helpers move, as a mid-chat switch moves them,
  // with no reopen; the chat's line names the profile. Picking it again changes nothing.
  if (libraryPick && !prev) {
    const switched = await switchChatProfile(path, `library:${libraryPick.id}`);
    return switched.ok ? { ok: true } : { ok: false, status: switched.status, error: `${libraryPick.name} can't be picked here: ${switched.error}` };
  }
  const next = r.profile;
  // Everything the pick sets is checked here first, so a pick that can't apply writes nothing.
  if (next?.model) {
    const why = modelDenial(readModelPolicy(), next.model) ?? (await chat.findModel(next.model).then((f) => (f.ok ? null : f.error)));
    if (why) return { ok: false, status: 400, error: `${next.label} can't be picked here: ${why}` };
  }
  if (next?.thinking && !(THINKING_LEVELS as readonly string[]).includes(next.thinking))
    return { ok: false, status: 400, error: `${next.label} can't be picked here: "${next.thinking}" isn't an effort level.` };
  // A library profile picked alone pins its own helpers. Switching from a profile that set subagents to one that
  // sets none pins this computer's default profile's helpers, since a pick can't be cleared; a chat that never had
  // a pick gets none (it follows the default).
  let subagents = next?.subagents === OFF_ID ? undefined : next?.subagents;
  if (libraryPick) subagents = libraryPick.id;
  else if (!subagents && prev?.subagents && chat.mirror.subagentPick !== undefined) subagents = (await resolveDefaultProfile(s.cwd)).row.library?.id;
  if (subagents && subagents === chat.mirror.subagentPick) subagents = undefined;
  if (subagents) {
    const why = (next?.subagents ? subagentsUnusable(next.subagents) : null) ?? (await chat.subagentSwitchRefusal());
    if (why) return { ok: false, status: 400, error: `${next?.label ?? libraryPick?.name ?? "This profile"} can't be picked here: ${why}` };
  }
  // A profile without a model or effort, after one that set it: back to what a new session opens on
  // (the new-session default when usable, else pi's own; read, never written), by a fresh reopen below.
  const model = next?.model;
  const thinking = next?.thinking;
  const fresh = { model: !next?.model && !!prev?.model, thinking: !next?.thinking && !!prev?.thinking };
  // Its mode and minor modes, pinned together; a field it doesn't set, after a profile that set it,
  // goes back to mode.json's default (read, never written) and is pinned with the other.
  const modePatch: ModePatch = {};
  if (next?.mode) modePatch.mode = next.mode as ModePatch["mode"];
  else if (prev?.mode) modePatch.mode = readMode().mode;
  if (next?.minorModes) modePatch.minorModes = [...next.minorModes];
  else if (prev?.minorModes) modePatch.minorModes = [...readMode().minorModes];
  const now = chat.mirror.mode;
  const modeSame = (modePatch.mode === undefined || modePatch.mode === now.mode) &&
    (modePatch.minorModes === undefined || (modePatch.minorModes.length === now.minorModes.length && modePatch.minorModes.every((m) => now.minorModes.includes(m))));
  // The profile it is on already, as it stands: nothing to write, nothing to reopen.
  const sameProfile = !!next && !!prev && JSON.stringify(next) === JSON.stringify(prev);
  if (sameProfile && !subagents && modeSame && (!model || model === chat.mirror.model?.ref) && (!thinking || thinking === chat.mirror.thinking) && !fresh.model && !fresh.thinking)
    return { ok: true };
  try {
    await chat.writeProfile({ v: 1, profile: next, ...(by ? { by } : {}) });
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
  if ((modePatch.mode || modePatch.minorModes) && !modeSame) await step("mode", () => chat.switchMode(modePatch).then(() => chat.pinMode()));
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
  if (failed.length) return { ok: false, status: 409, error: `${next?.label ?? libraryPick?.name ?? "The profile"} was picked, but ${failed.join(", and ")}.` };
  return { ok: true };
}

/** A library-only pick: `{source: "library", id}` or the joined key "library:<id>". */
function libraryPickOf(choice: ProfileChoice): { id: string; name: string } | undefined {
  const id =
    typeof choice === "string" && choice.startsWith("library:") ? choice.slice("library:".length)
    : choice && typeof choice === "object" && (choice as { source?: unknown }).source === "library" && typeof (choice as { id?: unknown }).id === "string" ? (choice as { id: string }).id
    : undefined;
  if (!id) return undefined;
  return { id, name: subagentProfilesInfo().profiles.find((p) => p.id === id)?.name ?? id };
}

/** Why a profile's subagent profile can't be picked on this device, or null: a library profile or a built-in one (or the profile of yours that takes its place). */
function subagentsUnusable(id: string, info = subagentProfilesInfo()): string | null {
  if (info.error) return `this device's subagent profiles can't be read (${info.error}).`;
  if (id === OFF_ID) return null;
  return helperProfileOf(id, info.settings.profiles) ? null : `Its subagent profile "${id}" isn't in this device's library.`;
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

/** The joined key of the profile the chat at `path` is on, or undefined (none, or a chat that shows no picker). */
async function thisChatKey(path: string | undefined): Promise<string | undefined> {
  const file = path ? resolveSessionPath(path) : null;
  if (!file) return undefined;
  const s = await getSessionSummary(file).catch(() => null);
  if (!s || s.overseer || s.projectOverseer || s.baton || s.workerSession || s.queueChat) return undefined;
  const key = await chatProfileKey(file).catch(() => null);
  return key && key !== OFF_KEY ? key : undefined;
}

/** GET /api/profiles?cwd=: every profile a session in `cwd` can use (§chat.profiles/projects). */
export async function profilesListing(cwd?: string | null, path?: string): Promise<ProfilesListing> {
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
  // The one list (§chat.profiles/joined) and this computer's default (§chat.profiles/default).
  const library = loadSubagentProfiles(agentRoot());
  const joined = buildJoined({ sources: src, library, hidden: readHidden(), running, unusable, names: await modelNames(), connected: readConnectedAccounts(agentRoot()) });
  const def = await resolveDefaultProfile(cwd, joined);
  for (const r of joined) if (r.key === def.row.key) r.isDefault = true;
  const { id: _id, name: _name, ...template } = info.template;
  const base = startsBase();
  return {
    builtins: src.builtins,
    yours: src.yours,
    yoursFile: src.yoursFile,
    project: src.project,
    problems: src.problems,
    hidden: readHidden(),
    running,
    unusable,
    subagents: info.profiles.map((p) => ({ id: p.id, name: p.name, footprint: p.footprint, models: profileModelCount(info, p.id) })),
    joined,
    defaultProfile: def.info,
    library: { file: library.file, ...(library.state === "malformed" ? { error: library.errors.join("; ") } : {}) },
    template,
    // What a field a profile leaves unset starts as, and what a new chat started now starts with.
    startsBase: base,
    newChats: newChatStarts(def, base),
    // The row that chat is on: a "library:<id>" key with no row of its own is the row carrying that helper half.
    ...(await thisChatKey(path).then((k) => (k ? { thisChat: pickJoined(joined, k)?.key ?? k } : {}))),
    ...(src.yoursError ? { error: src.yoursError } : {}),
  };
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export function registerProfileRoutes(app: Hono): void {
  app.get("/api/profiles", async (c) => c.json(await profilesListing(c.req.query("cwd"), c.req.query("path"))));
  // Approve a project profile's powers (§chat.profiles/trust): the ones the file has now, and only
  // when they are the ones the client was shown.
  app.post("/api/profiles/approve", async (c) => {
    const notYou = yourClickRefusal(c, "profile");
    if (notYou) return notYou;
    const body = (await c.req.json().catch(() => null)) as { cwd?: unknown; id?: unknown; grant?: unknown; overseerMayStart?: unknown } | null;
    const cwd = str(body?.cwd);
    const id = str(body?.id);
    if (!cwd || !id || !Array.isArray(body?.grant) || typeof body?.overseerMayStart !== "boolean")
      return c.json({ error: "Expected {cwd, id, grant, overseerMayStart}" }, 400);
    const p = await findProfile({ source: "project", id }, cwd);
    if (!p) return c.json({ error: (await profileRefusedWhy(id, cwd)) ?? `No profile "${id}" in this folder's project.` }, 404);
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
    const s = await listedSession(id);
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
