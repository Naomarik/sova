// A chat's mid-chat switch to another profile (§chat.profiles/switch): the joined profile, resolved here
// into what the chat takes (its model and effort, its helper pick), then handed to the chat, which checks
// it, applies it whole between turns or holds it to the reply's end. One function for the mode menu's
// picker, the usage-limit row and the Overseer's sova_set_session.
import type { Hono } from "hono";
import type { ChatProfileState, ProfileSwitchResult, ProfileSwitchTarget } from "../shared/profile-switch";
import { acquireChatHandle, chatHandle } from "./chat-handle";
import { getSessionSummary } from "./sessions-index";
import { resolveSessionPath } from "./paths";
import { QUEUE_CHAT_MODE_REFUSAL } from "../shared/merge-queue";
import { findJoined } from "./joined-profiles";
import { resolveDefaultProfile } from "./default-profile";

export type SwitchAnswer = ({ ok: true } & ProfileSwitchResult) | { ok: false; status: 400 | 404 | 409; error: string; name?: string };

const OFF_TARGET: ProfileSwitchTarget = { id: "off", key: "sova:default", name: "Off", subagents: "off", helpers: 0 };

/**
 * The switch a joined profile makes, for a chat in `cwd`: its This chat model and effort (absent: the chat
 * keeps its own) and its helpers (none of its own: this computer's default profile's), or why it can't be used.
 */
export async function switchTargetOf(idOrKey: string, cwd: string): Promise<ProfileSwitchTarget | { status: 400 | 404; error: string; name?: string }> {
  if (idOrKey === "off" || idOrKey === "sova:default") return OFF_TARGET;
  const row = await findJoined(idOrKey, cwd);
  if (!row) return { status: 404, error: `Unknown profile: ${idOrKey}` };
  if (row.kind === "off") return OFF_TARGET;
  const name = row.name;
  if (row.approval === "needed") return { status: 400, error: "Approve it in Settings first.", name };
  if (row.linkMissing) return { status: 400, error: row.linkMissing, name };
  // A profile with no helpers gives the chat this computer's default profile's helpers, pinned ("off" when the
  // default is Off or links none), as a pick on the empty screen does (§chat.profiles/applying).
  const helpersOf = row.libraryId ? row : (await resolveDefaultProfile(cwd)).row;
  const subagents = row.libraryId ?? helpersOf.library?.id ?? "off";
  const { session: starts } = row;
  const model = starts?.model ?? undefined;
  const thinking = starts?.thinking;
  return {
    id: row.id,
    key: row.key,
    name,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    subagents,
    helpers: subagents === "off" ? 0 : helpersOf.helperRoles,
  };
}

/** Switch the chat at `path` to the joined profile `idOrKey`, all at once; nothing is written on a refusal. */
export async function switchChatProfile(path: string, idOrKey: unknown): Promise<SwitchAnswer> {
  if (typeof idOrKey !== "string" || !idOrKey) return { ok: false, status: 400, error: "Name a profile to switch to." };
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  // An org session (a project's coding session) switches like any chat; Sova's special sessions are refused here and by the chat.
  if (s.overseer || s.projectOverseer || s.baton || s.workerSession) return { ok: false, status: 409, error: "This chat can't switch profiles." };
  if (s.queueChat) return { ok: false, status: 409, error: QUEUE_CHAT_MODE_REFUSAL };
  if (s.live) return { ok: false, status: 409, error: `It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.` };
  const target = await switchTargetOf(idOrKey, s.cwd);
  if ("error" in target) return { ok: false, ...target };
  let chat;
  try {
    chat = await acquireChatHandle(path);
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err), name: target.name };
  }
  const r = await chat.switchProfile(target);
  return r.ok ? r : { ...r, name: target.name };
}

/**
 * Which joined profile the chat at `path` is on, by key (its switch's hidden entry, else the profile it
 * started with, else its helper pick's library profile, else Off), or null when it can't be opened.
 */
export async function chatProfileKey(path: string): Promise<string | null> {
  let chat;
  try {
    chat = chatHandle(path) ?? (await acquireChatHandle(path));
  } catch {
    return null;
  }
  const s = await chat.chatProfileState();
  return s.current.key ?? s.current.id;
}

/** Cancel Switch: drop the chat's waiting switch. */
export async function cancelChatProfileSwitch(path: string): Promise<{ cancelled: boolean; state: ChatProfileState } | null> {
  const chat = chatHandle(path);
  return chat ? chat.cancelProfileSwitch() : null;
}

/** POST and DELETE /api/sessions/profile-switch?path=<session> (the state itself comes on the chat's `chat_profile` message). */
export function registerProfileSwitchRoutes(app: Hono): void {
  app.post("/api/sessions/profile-switch", async (c) => {
    const path = resolveSessionPath(c.req.query("path"));
    if (!path) return c.json({ error: "Invalid session path" }, 400);
    const body = (await c.req.json().catch(() => null)) as { profile?: unknown } | null;
    const r = await switchChatProfile(path, body?.profile);
    if (r.ok) return c.json({ applies: r.applies, state: r.state });
    return c.json({ error: r.error, ...(r.name ? { name: r.name } : {}) }, r.status);
  });
  app.delete("/api/sessions/profile-switch", async (c) => {
    const path = resolveSessionPath(c.req.query("path"));
    if (!path) return c.json({ error: "Invalid session path" }, 400);
    const r = await cancelChatProfileSwitch(path);
    return r ? c.json(r) : c.json({ error: "That chat isn't open here." }, 404);
  });
}
