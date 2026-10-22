import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { powerOffSentence, type ModelPick, type PowerId, type PowerMap, type WorkModels } from "../shared/powers";
import type { OwnerAbilityOutcome } from "../shared/owner";
import { CONTRACT_FILE, parseDefinition } from "../shared/project-contract";
import { readProjects } from "./orgs";
import { projectVersions } from "./owner-versions";
import { effectiveAssistantModel } from "./project-assistant-store";
import { projectOverseerPaths, readPoSettings } from "./project-overseer-store";

/**
 * The one question "what would the Project Assistant do if asked now?" (§app.project-assistant/abilities), asked
 * without doing anything. The owner page's card (server/owner-page.ts) and the assistant's own tools
 * (server/project-assistant-tools.ts: start_fix, deploy, start_version) both ask it, so what the owner is told and
 * what the tool does can't drift. The order, the first failing step answering `team`: settings readable and the
 * assistant column there; the act's switch; the brake (as the project page reads it); a fix's coding model; a
 * release's deploy target; the engine's own check of the act from the assistant, unattended (switch, brake,
 * limits, at-once caps, archived). Then a fix or a release is `held` while the waiting period is above 0; a version
 * is never held. A version first needs one listed that could be opened, else `none`. Unclear is `team`.
 */

export type AssistantAbility = "fix" | "version" | "release";
export type WouldReason = "ok" | "unreadable" | "power-off" | "brake" | "no-model" | "no-recipe" | "no-version" | "refused";
export interface WouldAnswer {
  outcome: OwnerAbilityOutcome | "none";
  reason: WouldReason;
  /** For the assistant's model (a tool's answer), never for the owner. */
  sentence?: string;
}

export const ABILITY_POWER: Record<AssistantAbility, PowerId> = { fix: "codingStart", version: "copiesRun", release: "deploy" };
const ACT_EVENT: Record<AssistantAbility, string> = { fix: "build/start", version: "services/run", release: "deploy/run" };
/** The acts the hold policy holds for the waiting period (registry `:hold true`); services/run is never held. */
const HELD_ACT: Record<AssistantAbility, boolean> = { fix: true, version: false, release: true };

/** What the question reads; the server's own by default, tests stand in. */
export interface WouldActFacts {
  /** The project's Project Assistant column as set and its model overrides; `assistant: null` when unreadable. */
  column(projectId: string): { assistant: PowerMap | null; models: WorkModels | null };
  /** A brake holds the switches (paused, empty roster); null when it can't be read. */
  braked(projectId: string): Promise<boolean | null>;
  /** The coding model a fix would run on, or null. */
  codingModel(orgId: string, models: WorkModels | null): ModelPick | null;
  /** The project declares release steps (a deploy target). */
  hasRelease(projectId: string): Promise<boolean>;
  /** A version is listed that could be opened. */
  hasVersion(orgId: string, projectId: string): Promise<boolean>;
  /** The engine's check of the act from the assistant, unattended: its refusal or null, and the waiting period; null when the engine can't be asked. */
  engine(projectId: string, event: string, payload: Record<string, unknown>): Promise<{ refusal: { code: string; sentence: string } | null; holdMs: number } | null>;
}

const unreadable = () => null;

const serverFacts: WouldActFacts = {
  column(projectId) {
    try {
      const s = readPoSettings(projectOverseerPaths(projectId));
      return { assistant: s.powers?.assistant ?? null, models: s.powers?.assistantModels ?? null };
    } catch {
      return { assistant: null, models: null };
    }
  },
  async braked(projectId) {
    try {
      // The brake as the project page reads it (powersView): imported late, project-overseer reaches this module's neighbours.
      const { powersOf } = await import("./project-overseer");
      return !!powersOf(projectId).brake;
    } catch {
      return unreadable();
    }
  },
  codingModel: (orgId, models) => effectiveAssistantModel(orgId, "coding", models)?.pick ?? null,
  hasRelease: async (projectId) => (await deployTargetOf(projectId)) !== null,
  async hasVersion(orgId, projectId) {
    const p = readProjects(orgId).find((x) => x.id === projectId);
    if (!p) return false;
    const vs = await projectVersions(orgId, p).catch(() => []);
    return vs.some((v) => v.endpoint !== null);
  },
  async engine(projectId, event, payload) {
    try {
      const { projectEnvelope, projectHost, projectSid } = await import("./projects/spaces");
      const envelope = projectEnvelope(projectId, { by: "assistant", attended: false });
      const r = projectHost(projectId).explain(projectSid(projectId), event, payload, envelope);
      return { refusal: r ? { code: r.code ?? "refused", sentence: r.sentence } : null, holdMs: typeof envelope.holdMs === "number" ? envelope.holdMs : 0 };
    } catch {
      return null;
    }
  },
};

let factsForTest: WouldActFacts | null = null;
export function setWouldActFactsForTest(f: WouldActFacts | null): void {
  factsForTest = f;
}

/** The project's first deploy target, from its definition at its root; null when it declares none (or can't be read). */
export async function deployTargetOf(projectId: string): Promise<string | null> {
  try {
    const { listProjects } = await import("./projects/spaces");
    const root = listProjects().find((p) => p.id === projectId)?.root;
    if (!root) return null;
    const file = join(root, CONTRACT_FILE);
    if (!existsSync(file)) return null;
    return parseDefinition(readFileSync(file, "utf8")).deploy?.targets[0]?.name ?? null;
  } catch {
    return null;
  }
}

const ENGINE_PAYLOAD: Record<AssistantAbility, Record<string, unknown>> = {
  fix: { sessionId: "would-act", title: "would-act", prompt: "would-act", basis: { kind: "owner-request", id: "would-act" } },
  version: { verb: "up", instance: "would-act" },
  release: {},
};

const BRAKE_SENTENCE = "Nothing happens without the operator right now. Tell the owner it went to the team: it reaches the operator as a request.";

/**
 * What the assistant would do for `ability` on `projectId` if asked now. `attended`: the operator started this turn
 * (their acts are never restricted), so the switch, the brake and the engine are not asked; the rest is.
 */
export async function assistantWouldAct(orgId: string, projectId: string, ability: AssistantAbility, o: { attended?: boolean } = {}): Promise<WouldAnswer> {
  const f = factsForTest ?? serverFacts;
  const team = (reason: WouldReason, sentence?: string): WouldAnswer => ({ outcome: "team", reason, ...(sentence ? { sentence } : {}) });
  if (ability === "version" && !(await f.hasVersion(orgId, projectId).catch(() => false))) return { outcome: "none", reason: "no-version" };
  const col = f.column(projectId);
  if (!o.attended) {
    if (!col.assistant) return team("unreadable", "Its settings can't be read now. Tell the owner it went to the team.");
    if (!col.assistant[ABILITY_POWER[ability]]) return team("power-off", powerOffSentence(ABILITY_POWER[ability], "assistant"));
    const b = await f.braked(projectId).catch(() => null);
    if (b === null) return team("unreadable", "Its settings can't be read now. Tell the owner it went to the team.");
    if (b) return team("brake", BRAKE_SENTENCE);
  }
  if (ability === "fix" && !f.codingModel(orgId, col.models)) return team("no-model", "no model is set for fixes");
  if (ability === "release" && !(await f.hasRelease(projectId).catch(() => false))) return team("no-recipe", "the project has no release steps set up");
  if (o.attended) return { outcome: "now", reason: "ok" };
  const e = await f.engine(projectId, ACT_EVENT[ability], ENGINE_PAYLOAD[ability]);
  if (!e) return team("unreadable", "The project can't be reached on this host now. Tell the owner it went to the team.");
  if (e.refusal) return team(e.refusal.code === "power-off" ? "power-off" : e.refusal.code === "brake" ? "brake" : "refused", e.refusal.sentence);
  return { outcome: HELD_ACT[ability] && e.holdMs > 0 ? "held" : "now", reason: "ok" };
}
