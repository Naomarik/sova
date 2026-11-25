import { isCapabilityNeutral } from "../shared/profiles";
import { acquireChatHandle } from "./chat-handle";
import { resolveDefaultProfile } from "./default-profile";
import { modelDenial, readModelPolicy } from "./model-policy";
import type { ModePatch } from "./mode-state";
import { noteDefaultNotApplied } from "./default-start-notes";
import { applyProfile } from "./session-profile-routes";

/**
 * A new chat with no profile named starts on this computer's default (§chat.profiles/default).
 * A default with no session half needs nothing: the chat follows the default's helpers and is named by
 * them. A default with a session half (chosen, or the built-in one the connected accounts give) is
 * picked as on the empty screen, so its chip, its When a Chat Starts part, its model and its helpers
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
  const r = await startOn(path, cwd, byOverseer, helpers);
  // Kept for the new chat's empty screen (server/default-start-notes.ts): the chat socket's `profile` message says it.
  noteDefaultNotApplied(path, r.ok ? null : { profile: r.profile, reason: r.reason });
  return r.ok ? r : { ok: false, error: r.error };
}

/** A refusal's words without the "{name} can't be picked here: " the line already says. */
export const ownReason = (error: string, profile: string): string => {
  const lead = `${profile} can't be picked here: `;
  return error.startsWith(lead) ? error.slice(lead.length) : error;
};

type Started = { ok: true; applied: "none" | "whole" | "models" } | { ok: false; error: string; profile: string; reason: string };

async function startOn(path: string, cwd: string, byOverseer: boolean, helpers?: string): Promise<Started> {
  const d = await resolveDefaultProfile(cwd).catch(() => null);
  const half = d?.row.session;
  // Helpers alone (a library profile, or a seeded starter shown as Claude, which keeps its own models): nothing to
  // write. The chat follows the default's helpers, and its card is the checked one, named by them
  // (§chat.profiles/default). A built-in profile the accounts give, though nobody chose it, is picked whole, as a
  // chosen default is: the new chat is on it from its first message, its own model included. Existing chats never
  // change model.
  // No default at all (nothing chosen, nothing connected) has no session half either: the chat keeps the model new
  // chats open on, with no helper profile.
  if (!d || !half) return { ok: true, applied: "none" };
  const profile = d.row.name;
  const whole = !byOverseer || isCapabilityNeutral(half) || (half.overseerMayStart && half.approval !== "needed");
  if (whole && half.approval !== "needed") {
    const r = await applyProfile(path, { source: half.source, id: half.id }, byOverseer ? "overseer" : undefined);
    if (r.ok || !r.running) {
      // Also after a partly applied default, which may have moved the helpers before it failed.
      const repin = helpers === undefined ? null : await acquireChatHandle(path).then((chat) => chat.switchSubagentProfile(helpers)).then(() => null, (e) => String(e));
      if (!r.ok) return { ok: false, error: `the default profile wasn't applied: ${r.error}`, profile, reason: ownReason(r.error, profile) };
      return repin ? { ok: false, error: `the named helpers weren't kept: ${repin}`, profile, reason: `the helpers it was started with weren't kept (${repin})` } : { ok: true, applied: "whole" };
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
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `the default profile's models weren't applied: ${why}`, profile, reason: `its models couldn't be set (${why})` };
  }
  return failed.length ? { ok: false, error: `the default profile's ${failed.join(", ")} weren't applied`, profile, reason: `its ${failed.join(", ")} couldn't be set` } : { ok: true, applied: "models" };
}
