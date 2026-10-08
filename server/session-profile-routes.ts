import type { Hono } from "hono";
import { keyOf, THINKING_LEVELS, type ListedProfile, type Profile, type ProfilesListing } from "../shared/profiles";
import type { SessionSummary } from "../shared/protocol";
import { acquireChat, disposeHeldChat, heldChat, setSingletonCheck } from "./chat-manager";
import { modelDenial, readModelPolicy } from "./model-policy";
import { listModels } from "./models";
import { addProfile } from "./profiles-store";
import { subagentProfilesInfo } from "./subagent-profiles";
import { loadDefaults } from "./web-defaults";
import { getSessionInsight } from "./insights";
import { resolveSessionPath } from "./paths";
import { findProfile, profileSources, readHidden, setHidden } from "./profile-sources";
import { approve } from "./profile-trust";
import { projectRootOf } from "./project-root";
import { setPowersHost } from "./session-powers";
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
  const next = r.profile;
  const prev = chat.profileState?.data?.profile ?? null;
  // Everything the pick sets is checked here first, so a pick that can't apply writes nothing.
  if (next?.model) {
    const why = modelDenial(readModelPolicy(), next.model) ?? (await chat.harness.findModel(next.model).then((f) => (f.ok ? null : f.error)));
    if (why) return { ok: false, status: 400, error: `${next.label} can't be picked here: ${why}` };
  }
  if (next?.thinking && !(THINKING_LEVELS as readonly string[]).includes(next.thinking))
    return { ok: false, status: 400, error: `${next.label} can't be picked here: "${next.thinking}" isn't an effort level.` };
  // Switching back from a profile that set subagents pins the device default, since a pick can't be
  // cleared; a chat that never had a pick gets none.
  let subagents = next?.subagents;
  if (!subagents && prev?.subagents && chat.subagentPick !== undefined) subagents = subagentProfilesInfo().default;
  if (subagents) {
    const why = (next?.subagents ? subagentsUnusable(next.subagents) : null) ?? chat.subagentSwitchRefusal();
    if (why) return { ok: false, status: 400, error: `${next?.label ?? "Default"} can't be picked here: ${why}` };
  }
  // A profile without a model or effort, after one that set it: back to the new-session default
  // (read, never written), when that is usable.
  const defaults = loadDefaults();
  let model = next?.model;
  if (!model && prev?.model && defaults.model && !modelDenial(readModelPolicy(), defaults.model) && (await chat.harness.findModel(defaults.model)).ok) model = defaults.model;
  const thinking = next?.thinking ?? (prev?.thinking && defaults.thinking && (THINKING_LEVELS as readonly string[]).includes(defaults.thinking) ? defaults.thinking : undefined);
  try {
    chat.writeProfile({ v: 1, profile: next, ...(by ? { by } : {}) });
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  // Starts with: its mode (pinned), model, effort and subagent pick, before the reopen. None saves a default.
  const failed: string[] = [];
  const step = async (what: string, run: () => unknown) => {
    try {
      await run();
    } catch (err) {
      failed.push(`its ${what} wasn't (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  if (next?.mode) await step("mode", () => chat.switchMode({ mode: next.mode as "normal" | "delegate" }).then(() => chat.pinMode()));
  if (model && model !== chat.harness.model()?.ref) await step("model", () => chat.setModelRef(model));
  if (thinking) await step("effort", () => chat.setThinking(thinking));
  if (subagents) await step("subagent profile", () => chat.switchSubagentProfile(subagents));
  await disposeHeldChat(path, "Applying the profile.");
  if (failed.length) return { ok: false, status: 409, error: `${next?.label ?? "Default"} was picked, but ${failed.join(", and ")}.` };
  return { ok: true };
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
  let chat = heldChat(path);
  try {
    chat ??= await acquireChat(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  const thinking = chat.harness.thinking();
  try {
    const profile = addProfile({
      label,
      ...(chat.harness.model()?.ref ? { model: chat.harness.model()!.ref } : {}),
      ...((THINKING_LEVELS as readonly string[]).includes(thinking) ? { thinking: thinking as Profile["thinking"] } : {}),
      ...(chat.subagentPick ? { subagents: chat.subagentPick } : {}),
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
  const everRun = new Set<string>();
  for (const s of all) {
    const p = s.profile;
    if (!p?.singleton || p.custom) continue;
    const key = keyOf(p);
    everRun.add(key);
    if (!s.archived && !running[key]) running[key] = holderOf(s);
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
    everRun: [...everRun],
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

setPowersHost({
  sessions: () => listSessions(),
  async session(id) {
    const s = (await listSessions()).find((x) => x.id === id);
    return s ? ((await getSessionSummary(s.path)) ?? s) : null;
  },
  transcript: async (path) => rowsOf(await readBranch(path)),
  insight: (path) => getSessionInsight(path),
  held(path) {
    const chat = heldChat(path);
    return chat ? { streaming: chat.harness.isRunning(), queued: chat.queue.size } : null;
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
