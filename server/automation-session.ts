import { basename } from "node:path";
import type { Automation } from "../shared/automations";
import { PROFILE_MINOR_MODES, type ProfileMinorMode, type SnapshotProfile } from "../shared/profiles";
import type { ChatModePatch } from "../shared/chat-runtime";
import { acquireChatHandle } from "./chat-handle";
import { inlineChoice } from "./session-profile";
import { applyProfile } from "./session-profile-routes";
import { promptSession } from "./session-prompt";
import { writeAutoTitle } from "./session-titles";

/**
 * An automation's own session (§chat.schedules/automation-file): its permissions as the profile
 * snapshot a new session gets, and its settings (model, effort, mode, minor modes with memory)
 * applied before every run, where they differ. The automation's approval covers its permissions,
 * so the snapshot is given whole (inlineChoice), never looked up as a profile.
 */

/** The snapshot an automation's new session is made with: identity `project:<root>#<id>`. */
export function automationSnapshot(root: string, a: Automation): SnapshotProfile {
  const p = a.permissions;
  const s = a.settings;
  const minors = s.minorModes?.filter((m): m is ProfileMinorMode => (PROFILE_MINOR_MODES as readonly string[]).includes(m));
  return {
    id: a.id,
    label: a.label,
    icon: "branch",
    description: `Runs the automation ${a.label}.`,
    remove: [...p.remove],
    grant: [...p.grant],
    singleton: p.oneAtATime,
    limits: { ...p.limits },
    overseerMayStart: p.overseerMayStart,
    ...(s.mode ? { mode: s.mode } : {}),
    ...(minors ? { minorModes: minors } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.thinking ? { thinking: s.thinking } : {}),
    source: "project",
    project: root,
    projectName: basename(root),
  };
}

export type SendResult = { ok: true } | { ok: false; error: string };

/** Set the session's model, effort, mode and minor modes (memory with its type) to the automation's, where
    they differ; what the file leaves out stays as the session has it. A memory size the file names is ignored:
    every chat's size is Settings → Memory's for its type (§chat.memory/choice). */
export async function configureAutomationSession(path: string, a: Automation): Promise<SendResult> {
  const s = a.settings;
  if (!s.model && !s.thinking && !s.mode && !s.minorModes && !s.memory) return { ok: true };
  try {
    const chat = await acquireChatHandle(path);
    if (s.model && chat.mirror.model?.ref !== s.model) await chat.setModel(s.model);
    if (s.thinking && chat.mirror.thinking !== s.thinking) await chat.setThinking(s.thinking);
    const now = chat.mirror.mode;
    const wantMinors = s.minorModes ? [...s.minorModes].sort().join(",") : null;
    const modeDiffers = (s.mode && now.mode !== s.mode) || (wantMinors !== null && [...now.minorModes].sort().join(",") !== wantMinors);
    const mem = s.memory ? chat.mirror.memory : null;
    const memoryDiffers = !!s.memory && !!mem && mem.type !== s.memory.type;
    if (modeDiffers || memoryDiffers) {
      await chat.switchMode({
        ...(s.mode ? { mode: s.mode } : {}),
        ...(s.minorModes ? { minorModes: s.minorModes as ChatModePatch["minorModes"] } : {}),
        ...(memoryDiffers && s.memory ? { memory: { type: s.memory.type } } : {}),
      });
      await chat.pinMode();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type AppRequest = (path: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * A new session for an automation: made in the project's root (the list's own create), given the
 * automation's snapshot and settings, titled, then sent its first message.
 */
export async function createAutomationSession(request: AppRequest, root: string, a: Automation, text: string, title: string): Promise<{ ok: true; id: string; path: string } | { ok: false; error: string }> {
  const res = await request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: root }) });
  const made = (await res.json().catch(() => null)) as { id?: string; path?: string; error?: string } | null;
  if (res.status !== 201 || !made?.id || !made.path) return { ok: false, error: made?.error ?? `HTTP ${res.status}` };
  const applied = await applyProfile(made.path, inlineChoice(automationSnapshot(root, a)), "start");
  if (!applied.ok) return { ok: false, error: `Created the session, but its permissions were not set: ${applied.error}` };
  const configured = await configureAutomationSession(made.path, a);
  if (!configured.ok) console.warn(`[schedules] ${a.id}: settings not applied to its new session: ${configured.error}`);
  writeAutoTitle(made.id, title);
  const sent = await promptSession(made.path, text);
  if (!sent.ok) return { ok: false, error: `Created the session, but its first message was refused: ${sent.error}` };
  return { ok: true, id: made.id, path: made.path };
}
