import { isCapabilityNeutral } from "../shared/profiles";
import { acquireChatHandle } from "./chat-handle";
import { resolveDefaultProfile } from "./default-profile";
import { modelDenial, readModelPolicy } from "./model-policy";
import type { ModePatch } from "./mode-state";
import { applyProfile } from "./session-profile-routes";

/**
 * A new chat with no profile named starts on this computer's default (§chat.profiles/default).
 * Off and a default with no session half need nothing: the older default files choosing it keeps
 * written are what a new chat opens on. A default with a session half is picked as on the empty
 * screen, so its chip, its When a Chat Starts part and its helpers are the chat's.
 *
 * An Overseer's start (and any start a person didn't make) never gets powers or tool changes the
 * profile isn't marked for: a default that isn't capability-neutral and lacks "Overseer may start"
 * (or still needs approval) gives such a chat only its modes, its model and effort and its helpers,
 * with no profile entry. The same holds when its One at a time is live elsewhere.
 */
export async function startOnDefault(path: string, cwd: string, byOverseer: boolean): Promise<{ ok: true; applied: "none" | "whole" | "models" } | { ok: false; error: string }> {
  const d = await resolveDefaultProfile(cwd).catch(() => null);
  const half = d?.row.session;
  if (!d || !half) return { ok: true, applied: "none" };
  const whole = !byOverseer || isCapabilityNeutral(half) || (half.overseerMayStart && half.approval !== "needed");
  if (whole && half.approval !== "needed") {
    const r = await applyProfile(path, { source: half.source, id: half.id }, byOverseer ? "overseer" : undefined);
    if (r.ok) return { ok: true, applied: "whole" };
    if (!r.running) return { ok: false, error: `the default profile wasn't applied: ${r.error}` };
  }
  // Its modes, model and effort, and helpers only.
  const failed: string[] = [];
  try {
    const chat = await acquireChatHandle(path);
    const mode: ModePatch = {};
    if (half.mode) mode.mode = half.mode as ModePatch["mode"];
    if (half.minorModes) mode.minorModes = [...half.minorModes];
    if (mode.mode || mode.minorModes) await chat.switchMode(mode).then(() => chat.pinMode()).catch((e) => failed.push(`modes (${String(e)})`));
    if (half.model && half.model !== chat.mirror.model?.ref) {
      const why = modelDenial(readModelPolicy(), half.model) ?? (await chat.findModel(half.model).then((f) => (f.ok ? null : f.error)));
      if (why) failed.push(`model (${why})`);
      else await chat.setModel(half.model).catch((e) => failed.push(`model (${String(e)})`));
    }
    if (half.thinking) await chat.setThinking(half.thinking).catch((e) => failed.push(`effort (${String(e)})`));
    if (d.row.library) await chat.switchSubagentProfile(d.row.library.id).catch((e) => failed.push(`helpers (${String(e)})`));
  } catch (err) {
    return { ok: false, error: `the default profile's models weren't applied: ${err instanceof Error ? err.message : String(err)}` };
  }
  return failed.length ? { ok: false, error: `the default profile's ${failed.join(", ")} weren't applied` } : { ok: true, applied: "models" };
}
