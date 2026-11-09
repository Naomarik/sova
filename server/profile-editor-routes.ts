import type { Context, Hono } from "hono";
import { OFF_ID, OFF_KEY, type DefaultProfileInfo, type ProfileSaveRequest } from "../shared/profiles";
import { acquireChatHandle, chatHandle, type ChatHandle } from "./chat-handle";
import { chooseDefaultProfile, DefaultRefusal, resolveDefaultProfile } from "./default-profile";
import type { DelegateSources } from "./delegate";
import { joinedProfiles, pickJoined } from "./joined-profiles";
import { saveDefaultMemoryType } from "./memory/settings";
import { resolveSessionPath } from "./paths";
import { deleteMine, duplicateMine, saveCurrentAsProfile, saveMine, updateFromChat, type ChatNow, type EditorAnswer } from "./profile-editor";
import { profilesListing } from "./session-profile-routes";
import { getSessionSummary } from "./sessions-index";

/**
 * Settings → Profiles' writes and the mode menu's Make Default / Update (§chat.profiles/joined,
 * /default, §app.settings-dialog/profile-editor, §chat.subagent-profiles/menu). Each answers the
 * fresh listing for the body's `cwd` (plus `savedKey`), or `{error, field?, partial?}`. Registered
 * by server/app.ts beside the library's routes, which keep working for older clients.
 */

type Body = Record<string, unknown>;
const body = async (c: Context): Promise<Body> => {
  const b: unknown = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Body) : {};
};
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

async function answer(c: Context, r: EditorAnswer, cwd: string | undefined) {
  if (!r.ok) return c.json({ error: r.error, ...(r.field ? { field: r.field } : {}), ...(r.partial ? { partial: true, ...(await profilesListing(cwd)) } : {}) }, r.status);
  return c.json({ ...(await profilesListing(cwd)), ...(r.savedKey ? { savedKey: r.savedKey } : {}), ...(r.warnings ? { warnings: r.warnings } : {}) });
}

/** A session's chat, held or opened; a refusal as the route's answer. */
async function chatOf(c: Context, raw: unknown): Promise<{ chat: ChatHandle; cwd: string } | Response> {
  const path = resolveSessionPath(typeof raw === "string" ? raw : null);
  if (!path) return c.json({ error: "Invalid or missing path" }, 400);
  const s = await getSessionSummary(path);
  if (!s) return c.json({ error: "Session file not found" }, 404);
  try {
    return { chat: chatHandle(path) ?? (await acquireChatHandle(path)), cwd: s.cwd };
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
  }
}

/** What the chat uses now: model, effort, its modes (Create: its last normal or Delegate choice), and the library profile its helpers resolve to. */
async function chatNow(chat: ChatHandle): Promise<ChatNow & { memoryType?: string; strict: boolean }> {
  const m = chat.mirror;
  const result = await chat.modeResult().catch(() => null);
  const major = m.mode.mode === "create" ? result?.saveMode : m.mode.mode;
  const helpers = (await chat.subagentProfileInfo()).current.id ?? undefined;
  const memory = (result as { memory?: { type?: string } } | null)?.memory?.type;
  return {
    ...(m.model?.ref ? { model: m.model.ref } : {}),
    ...(m.thinking ? { thinking: m.thinking } : {}),
    ...(major === "normal" || major === "delegate" ? { mode: major } : {}),
    minorModes: [...m.mode.minorModes],
    ...(helpers ? { helpers } : {}),
    ...(memory ? { memoryType: memory } : {}),
    strict: m.mode.strict,
  };
}

/** The joined key the chat is on now (the switch's record, else its first pick, else Off). */
async function chatKey(chat: ChatHandle): Promise<string> {
  try {
    const cur = (await chat.chatProfileState()).current;
    return cur.key ?? cur.id ?? OFF_KEY;
  } catch {
    return OFF_KEY;
  }
}

/** Save Current As Profile for a session's chat (the route's work, without HTTP). */
export async function saveCurrentFor(path: string, label: unknown, sources: DelegateSources, cwd?: string): Promise<EditorAnswer> {
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  let chat: ChatHandle;
  try {
    chat = chatHandle(path) ?? (await acquireChatHandle(path));
  } catch (err) {
    return { ok: false, status: 409, error: err instanceof Error ? err.message : String(err) };
  }
  return saveCurrentAsProfile(label, await chatNow(chat), { sources, cwd: cwd ?? s.cwd });
}

/**
 * Make {name} the Default from a chat's mode menu: this chat's profile becomes this computer's
 * default, and as Save as default did, the chat's strict flag and memory type are saved for new
 * chats. Throws DefaultRefusal (409) or an Error with the sentence.
 */
export async function makeChatDefault(path: string): Promise<DefaultProfileInfo> {
  const s = await getSessionSummary(path);
  if (!s) throw new Error("Session file not found");
  // A chat that takes no profile (the Overseer, a project overseer, a baton, an organization's,
  // a worker's, the merge queue's) has none to make the default; it would read as Off.
  if (s.overseer || s.projectOverseer || s.baton || s.org || s.workerSession || s.queueChat) throw new DefaultRefusal("This chat has no profile to make the default.");
  const chat = chatHandle(path) ?? (await acquireChatHandle(path));
  const key = await chatKey(chat);
  const now = await chatNow(chat);
  const rows = await joinedProfiles(s.cwd);
  const row = pickJoined(rows, key === OFF_ID ? OFF_KEY : key);
  if (!row) throw new DefaultRefusal("This chat's profile isn't here anymore.");
  const info = chooseDefaultProfile(row, rows, { strict: now.strict });
  if (now.memoryType) saveDefaultMemoryType(now.memoryType as Parameters<typeof saveDefaultMemoryType>[0]);
  return info;
}

export function registerProfileEditorRoutes(app: Hono, sources: DelegateSources): void {
  app.post("/api/profiles/mine", async (c) => {
    const b = await body(c);
    const cwd = str(b.cwd);
    return answer(c, await saveMine(b as unknown as ProfileSaveRequest, { sources, cwd }), cwd);
  });
  app.post("/api/profiles/mine/duplicate", async (c) => {
    const b = await body(c);
    const cwd = str(b.cwd);
    return answer(c, await duplicateMine(b.key, { sources, cwd }), cwd);
  });
  app.post("/api/profiles/mine/delete", async (c) => {
    const b = await body(c);
    const cwd = str(b.cwd);
    return answer(c, await deleteMine(b.key, { sources, cwd }), cwd);
  });
  // Make Default: {key} from Settings → Profiles, or {path} from a chat's mode menu (this chat's
  // profile, and as Save as default did, its strict flag and memory type for new chats).
  app.put("/api/profiles/default", async (c) => {
    const b = await body(c);
    const cwd = str(b.cwd);
    const key = str(b.key);
    try {
      if (b.path !== undefined) {
        const path = resolveSessionPath(typeof b.path === "string" ? b.path : null);
        if (!path) return c.json({ error: "Invalid or missing path" }, 400);
        await makeChatDefault(path);
        return c.json(await profilesListing(cwd ?? (await getSessionSummary(path))?.cwd));
      }
      if (!key) return c.json({ error: "Expected {key} or {path}" }, 400);
      const rows = await joinedProfiles(cwd);
      const row = pickJoined(rows, key === OFF_ID ? OFF_KEY : key);
      if (!row) return c.json({ error: "That profile isn't here anymore." }, 404);
      chooseDefaultProfile(row, rows);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, err instanceof DefaultRefusal ? 409 : 400);
    }
    return c.json(await profilesListing(cwd));
  });
  // Save Current As Profile, both halves (§chat.profiles/picker, §chat.subagent-profiles/menu).
  app.post("/api/profiles/save-current", async (c) => {
    const b = await body(c);
    const path = resolveSessionPath(typeof b.path === "string" ? b.path : null);
    const label = b.label ?? b.name;
    if (!path || typeof label !== "string") return c.json({ error: "Expected {path, label}" }, 400);
    const cwd = str(b.cwd) ?? (await getSessionSummary(path))?.cwd;
    return answer(c, await saveCurrentFor(path, label, sources, cwd), cwd);
  });
  // Update {name}: this chat's model, effort and modes into its own profile (never its helpers).
  app.post("/api/profiles/update-from-chat", async (c) => {
    const b = await body(c);
    const got = await chatOf(c, b.path);
    if (got instanceof Response) return got;
    const cwd = str(b.cwd) ?? got.cwd;
    return answer(c, await updateFromChat(await chatKey(got.chat), await chatNow(got.chat), { sources, cwd }), cwd);
  });
}

export { resolveDefaultProfile };
