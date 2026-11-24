import { isCapabilityNeutral } from "../shared/profiles";
import { acquireChatHandle } from "./chat-handle";
import { resolveDefaultProfile } from "./default-profile";
import { modelDenial, readModelPolicy } from "./model-policy";
import type { ModePatch } from "./mode-state";
import { applyProfile } from "./session-profile-routes";

/**
 * A new chat with no profile named starts on this computer's default (§chat.profiles/default).
 * A default with no session half records its helpers as the chat's pick. A default with a session
 * half is picked as on the empty screen, so its chip, its When a Chat Starts part and its helpers
 * are the chat's.
 *
 * An Overseer's start (and any start a person didn't make) never gets powers or tool changes the
 * profile isn't marked for: a default that isn't capability-neutral and lacks "Overseer may start"
 * (or still needs approval) gives such a chat only its modes, its model and effort and its helpers,
 * with no profile entry. The same holds when its One at a time is live elsewhere.
 *
 * `helpers`: the subagent pick the start named, already on file: it stays the chat's pick whatever
 * the default's helpers are.
 */
export async function startOnDefault(path: string, cwd: string, byOverseer: boolean, helpers?: string): Promise<{ ok: true; applied: "none" | "whole" | "models" } | { ok: false; error: string }> {
  const d = await resolveDefaultProfile(cwd).catch(() => null);
  const half = d?.row.session;
  if (!d) return { ok: true, applied: "none" };
  if (!half) {
    // Helpers alone: the chat records them as its pick, so it opens on that profile's card (§chat.profiles/default).
    const id = d.row.library?.id ?? d.row.libraryId;
    if (!id || helpers !== undefined) return { ok: true, applied: "none" };
    const why = await acquireChatHandle(path).then((chat) => chat.switchSubagentProfile(id)).then(() => null, (e) => String(e));
    return why ? { ok: false, error: `the default profile's helpers weren't applied: ${why}` } : { ok: true, applied: "models" };
  }
  // A default nobody chose (the built-in one the accounts here give) gives a new chat its helpers alone, as a
  // starter that holds only helpers did: the chat keeps the model new chats open on until a default is chosen.
  if (d.fromAccounts) {
    const id = d.row.library?.id ?? d.row.libraryId;
    if (!id || helpers !== undefined) return { ok: true, applied: "none" };
    const why = await acquireChatHandle(path).then((chat) => chat.switchSubagentProfile(id)).then(() => null, (e) => String(e));
    return why ? { ok: false, error: `the default profile's helpers weren't applied: ${why}` } : { ok: true, applied: "models" };
  }
  const whole = !byOverseer || isCapabilityNeutral(half) || (half.overseerMayStart && half.approval !== "needed");
  if (whole && half.approval !== "needed") {
    const r = await applyProfile(path, { source: half.source, id: half.id }, byOverseer ? "overseer" : undefined);
    if (r.ok || !r.running) {
      // Also after a partly applied default, which may have moved the helpers before it failed.
      const repin = helpers === undefined ? null : await acquireChatHandle(path).then((chat) => chat.switchSubagentProfile(helpers)).then(() => null, (e) => String(e));
      if (!r.ok) return { ok: false, error: `the default profile wasn't applied: ${r.error}` };
      return repin ? { ok: false, error: `the named helpers weren't kept: ${repin}` } : { ok: true, applied: "whole" };
    }
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
    if (d.row.library && helpers === undefined) await chat.switchSubagentProfile(d.row.library.id).catch((e) => failed.push(`helpers (${String(e)})`));
  } catch (err) {
    return { ok: false, error: `the default profile's models weren't applied: ${err instanceof Error ? err.message : String(err)}` };
  }
  return failed.length ? { ok: false, error: `the default profile's ${failed.join(", ")} weren't applied` } : { ok: true, applied: "models" };
}
