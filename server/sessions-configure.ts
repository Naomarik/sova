import { existsSync } from "node:fs";
import type { SessionConfigure, SessionConfigureResult } from "../shared/mesh-links";
import type { SessionSummary } from "../shared/protocol";
import { MEMORY_CODING_REFUSAL } from "../shared/memory";
import { acquireChat, isSessionBusy } from "./chat-manager";
import { workingSubagents } from "./live";
import { parseModePatch, type ModePatch } from "./mode-state";
import { modelDenial, readModelPolicy } from "./model-policy";
import { resolveSessionPath } from "./paths";
import { getSessionSummary } from "./sessions-index";
import { requireSubagentProfile } from "./subagent-profiles";

// POST /api/sessions/configure (§mesh.links/configure): a session's model, thinking, mode and minor
// modes set over REST, opening its runtime here if it isn't loaded. The same code sova_set_session
// runs in-process, as a route a peer reaches on the peer listener (the Overseer configuring a
// session it created there). It changes that session only: every setter is called without `save`,
// so the saved default new sessions start from never moves. A mode it sets is pinned with the
// session's own `mode` entry, as the Overseer's local tools pin one.

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type ConfigureOutcome = { ok: true; result: SessionConfigureResult } | { ok: false; status: 400 | 404 | 409; error: string };

/** A body as the route takes it: every field checked before anything is touched. */
export function parseConfigure(body: unknown): { req: SessionConfigure; patch: ModePatch | null } | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { error: "Expected JSON body { path, model?, thinking?, mode?, minorModes? }" };
  const b = body as Record<string, unknown>;
  if (typeof b.path !== "string" || !b.path) return { error: "path is required" };
  if (b.model !== undefined && (typeof b.model !== "string" || !b.model.includes("/"))) return { error: 'model must be a ref "provider/model"' };
  if (b.thinking !== undefined && (typeof b.thinking !== "string" || !THINKING_LEVELS.includes(b.thinking)))
    return { error: `thinking must be one of: ${THINKING_LEVELS.join(", ")}` };
  let patch: ModePatch | null = null;
  // The Overseer's route to a peer's session: memory is never given to a coding session (§chat.memory/where).
  if (Array.isArray(b.minorModes) && b.minorModes.includes("memory")) return { error: MEMORY_CODING_REFUSAL };
  if (b.mode !== undefined || b.minorModes !== undefined) {
    const p = parseModePatch({ ...(b.mode !== undefined ? { mode: b.mode } : {}), ...(b.minorModes !== undefined ? { minorModes: b.minorModes } : {}) });
    if ("error" in p) return { error: p.error };
    patch = p;
  }
  if (b.subagent_profile !== undefined && typeof b.subagent_profile !== "string") return { error: "subagent_profile must be a profile id" };
  if (b.model === undefined && b.thinking === undefined && !patch && b.subagent_profile === undefined) return { error: "Nothing to change: send model, thinking, mode and/or minorModes" };
  return {
    req: {
      path: b.path,
      ...(typeof b.subagent_profile === "string" ? { subagent_profile: b.subagent_profile } : {}),
      ...(typeof b.model === "string" ? { model: b.model } : {}),
      ...(typeof b.thinking === "string" ? { thinking: b.thinking } : {}),
      ...(typeof b.mode === "string" ? { mode: b.mode } : {}),
      ...(Array.isArray(b.minorModes) ? { minorModes: b.minorModes as string[] } : {}),
    },
    patch,
  };
}

/** Why this session can't be configured from here, or null. Checked before the runtime opens. */
export function configureRefusal(s: SessionSummary, busy: boolean, subagents: number, profileOnly = false): string | null {
  if (s.overseer) return "That is the Overseer's own conversation.";
  if (s.projectOverseer) return "That is a project overseer's own conversation.";
  if (s.baton) return "That is a baton session: only its participants write in it.";
  if (s.workerSession) return "That is a subagent's own session; configure the session that runs it.";
  if (s.live) return `It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.`;
  if (s.archived) return "That session is archived; unarchive it first.";
  // A profile-only switch touches nothing running: it applies to later turns and team actions.
  if (!profileOnly && busy) return "It is running a turn; wait for it to finish.";
  if (!profileOnly && subagents > 0) return `Its subagents are working (${subagents}); wait for them to finish.`;
  return null;
}

export async function configureSession(body: unknown): Promise<ConfigureOutcome> {
  const parsed = parseConfigure(body);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  const { req, patch } = parsed;
  if (req.subagent_profile !== undefined) {
    try { requireSubagentProfile(req.subagent_profile); }
    catch (err) { return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) }; }
  }
  const path = resolveSessionPath(req.path);
  if (!path) return { ok: false, status: 400, error: "Invalid path (must be a .jsonl under the pi sessions dir)" };
  if (!existsSync(path)) return { ok: false, status: 404, error: "Session file not found" };
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  const profileOnly = req.subagent_profile !== undefined && req.model === undefined && req.thinking === undefined && !patch;
  const refused = configureRefusal(s, isSessionBusy(path), workingSubagents(path), profileOnly);
  if (refused) return { ok: false, status: 409, error: refused };
  // The user's model policy refuses before anything opens or changes.
  if (req.model) {
    const denial = modelDenial(readModelPolicy(), req.model);
    if (denial) return { ok: false, status: 409, error: denial };
  }
  const done: string[] = [];
  try {
    const chat = await acquireChat(path);
    if (req.subagent_profile !== undefined) {
      await chat.switchSubagentProfile(req.subagent_profile);
      done.push(`subagent profile ${req.subagent_profile}`);
    }
    if (req.model) {
      await chat.setModelRef(req.model);
      done.push(`model ${req.model}`);
    }
    if (req.thinking) done.push(`thinking ${chat.setThinking(req.thinking)}`);
    const mode = patch ? await chat.switchMode(patch) : null;
    // Pinned, as sova_create_session and sova_set_session pin a local session: a mode equal to
    // the default still gets its entry, so it never follows a later change of mode.json.
    if (patch && !chat.pinMode()) throw new Error("Switched, but its mode entry was not written, so it may follow a later default");
    const result: SessionConfigureResult = {
      ok: true,
      model: chat.harness.model()?.ref ?? null,
      thinking: chat.harness.thinking() ?? null,
      ...(mode ? { mode: mode.mode, minorModes: mode.minorModes } : {}),
    };
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 409, error: done.length ? `${msg} (already set: ${done.join(", ")})` : msg };
  }
}
