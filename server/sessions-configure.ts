import { existsSync } from "node:fs";
import type { SessionConfigure, SessionConfigureResult } from "../shared/mesh-links";
import type { SessionSummary } from "../shared/protocol";
import { acquireChat, isSessionBusy } from "./chat-manager";
import { workingSubagents } from "./live";
import { parseModePatch, type ModePatch } from "./mode-state";
import { modelDenial, readModelPolicy } from "./model-policy";
import { resolveSessionPath } from "./paths";
import { getSessionSummary } from "./sessions-index";

// POST /api/sessions/configure (§mesh.links/configure): a session's model, thinking, mode and minor
// modes set over REST, opening its runtime here if it isn't loaded. The same code sova_set_session
// runs in-process, as a route a peer reaches on the peer listener (the Overseer configuring a
// session it created there). It changes that session only: every setter is called without `save`,
// so the saved default new sessions start from never moves.

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
  if (b.mode !== undefined || b.minorModes !== undefined) {
    const p = parseModePatch({ ...(b.mode !== undefined ? { mode: b.mode } : {}), ...(b.minorModes !== undefined ? { minorModes: b.minorModes } : {}) });
    if ("error" in p) return { error: p.error };
    patch = p;
  }
  if (b.model === undefined && b.thinking === undefined && !patch) return { error: "Nothing to change: send model, thinking, mode and/or minorModes" };
  return {
    req: {
      path: b.path,
      ...(typeof b.model === "string" ? { model: b.model } : {}),
      ...(typeof b.thinking === "string" ? { thinking: b.thinking } : {}),
      ...(typeof b.mode === "string" ? { mode: b.mode } : {}),
      ...(Array.isArray(b.minorModes) ? { minorModes: b.minorModes as string[] } : {}),
    },
    patch,
  };
}

/** Why this session can't be configured from here, or null. Checked before the runtime opens. */
export function configureRefusal(s: SessionSummary, busy: boolean, subagents: number): string | null {
  if (s.overseer) return "That is the Overseer's own conversation.";
  if (s.projectOverseer) return "That is a project overseer's own conversation.";
  if (s.baton) return "That is a baton session: only its participants write in it.";
  if (s.workerSession) return "That is a subagent's own session; configure the session that runs it.";
  if (s.live) return `It is open in a terminal (pid ${s.live.pid}), so this server must not write to it.`;
  if (s.archived) return "That session is archived; unarchive it first.";
  if (busy) return "It is running a turn; wait for it to finish.";
  if (subagents > 0) return `Its subagents are working (${subagents}); wait for them to finish.`;
  return null;
}

export async function configureSession(body: unknown): Promise<ConfigureOutcome> {
  const parsed = parseConfigure(body);
  if ("error" in parsed) return { ok: false, status: 400, error: parsed.error };
  const { req, patch } = parsed;
  const path = resolveSessionPath(req.path);
  if (!path) return { ok: false, status: 400, error: "Invalid path (must be a .jsonl under the pi sessions dir)" };
  if (!existsSync(path)) return { ok: false, status: 404, error: "Session file not found" };
  const s = await getSessionSummary(path);
  if (!s) return { ok: false, status: 404, error: "Session file not found" };
  const refused = configureRefusal(s, isSessionBusy(path), workingSubagents(path));
  if (refused) return { ok: false, status: 409, error: refused };
  // The user's model policy refuses before anything opens or changes.
  if (req.model) {
    const denial = modelDenial(readModelPolicy(), req.model);
    if (denial) return { ok: false, status: 409, error: denial };
  }
  const done: string[] = [];
  try {
    const chat = await acquireChat(path);
    if (req.model) {
      await chat.setModelRef(req.model);
      done.push(`model ${req.model}`);
    }
    if (req.thinking) done.push(`thinking ${chat.setThinking(req.thinking)}`);
    const mode = patch ? await chat.switchMode(patch) : null;
    const m = chat.session.model;
    const result: SessionConfigureResult = {
      ok: true,
      model: m ? `${m.provider}/${m.id}` : null,
      thinking: chat.session.thinkingLevel ?? null,
      ...(mode ? { mode: mode.mode, minorModes: mode.minorModes } : {}),
    };
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 409, error: done.length ? `${msg} (already set: ${done.join(", ")})` : msg };
  }
}
