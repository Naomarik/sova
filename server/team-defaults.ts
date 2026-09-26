import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CLAUDE_EFFORTS, DELEGATE_BACKENDS, PI_EFFORTS } from "../pi-config/extensions/mode/delegate.ts";
// The subagents extension's own reader and writer of the file (node builtins only): the shape, the
// strict parse, the atomic write, and the defaults a missing file stands for. See CLAUDE.md.
import {
  DEFAULT_TEAM_DEFAULTS,
  parseTeamDefaults,
  readTeamDefaults,
  teamDefaultsPath,
  writeTeamDefaults,
  type TeamDefaultsFile,
  type WorkerTuple,
} from "../pi-config/extensions/subagents/team-defaults.ts";
import type { WorkerChoice } from "../shared/protocol";
import type { TeamDefaults, TeamDefaultsInfo, TeamDefaultsSaveResult } from "../shared/team-defaults";
import { delegateOptions, verifySlots, type DelegateSources } from "./delegate";

// Settings → Teams: the standing coordinator and monitor every new team gets. The file
// (~/.pi/agent/team-defaults.json) and what the members do are the subagents extension's
// (pi-config/extensions/subagents/team-defaults.ts); the offer and the save check are Delegate's
// (server/delegate.ts), since each member's model is the same backend · model · effort tuple. The
// extension re-reads the file at every team_create, so a save applies to teams created after it.

export const teamDefaultsFile = (agentDir = getAgentDir()) => teamDefaultsPath(agentDir);

const BACKEND_LABELS = { pi: "pi", "claude-code": "Claude Code" } as const;

/** The file may leave a tuple's effort out (the worker's own default); the screen shows that as not chosen. */
const choice = (t: WorkerTuple): WorkerChoice => ({ backend: t.backend, model: t.model, effort: t.effort ?? "" });
const toWire = (f: TeamDefaultsFile): TeamDefaults => ({
  ...f,
  coordinator: { ...f.coordinator, primary: choice(f.coordinator.primary), fallback: f.coordinator.fallback && choice(f.coordinator.fallback) },
  monitor: { ...f.monitor, usage: { ...f.monitor.usage }, primary: choice(f.monitor.primary), fallback: f.monitor.fallback && choice(f.monitor.fallback) },
  handover: { ...f.handover },
});

/** The built-in values with both members off: what a missing file means, and what the screen starts from. */
export function teamDefaultsOff(): TeamDefaults {
  const off = toWire(DEFAULT_TEAM_DEFAULTS);
  off.coordinator.enabled = false;
  off.monitor.enabled = false;
  return off;
}

export function teamDefaultsInfo(agentDir = getAgentDir()): TeamDefaultsInfo {
  const stored = readTeamDefaults(agentDir);
  return {
    settings: stored.state === "ok" ? toWire(stored.value) : teamDefaultsOff(),
    defaults: toWire(DEFAULT_TEAM_DEFAULTS),
    stored: stored.state !== "absent",
    ...(stored.state === "malformed" ? { error: stored.errors.join("; ") } : {}),
    backends: DELEGATE_BACKENDS.map((id) => ({ id, label: BACKEND_LABELS[id], efforts: [...(id === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS)] })),
    file: stored.file,
  };
}

/** What each backend offers the two members: exactly Delegate's discovery (one cached Claude CLI call serves all). */
export const teamOptions = delegateOptions;

export type TeamSaveOutcome =
  | { status: 200; body: TeamDefaultsSaveResult }
  | { status: 400 | 409; body: { error: string } };

const ROLES = [
  ["coordinator", "Coordinator"],
  ["monitor", "Monitor"],
] as const;

/**
 * Replace the whole file (PUT). A stored file that can't be read is never overwritten (409): the
 * user fixes or removes it first. Then the shape (the extension's strict parse; Settings always
 * names an effort, so a row without one is refused here), then discovery, with Delegate's rule for
 * all four worker rows: a CHANGED tuple the backend authoritatively cannot run is refused; one that
 * can't be checked, or that the policy refuses (Enabled or Subagents), is saved with a warning. A
 * member that is off is still checked — its rows are what turning it back on restores.
 */
export async function saveTeamDefaults(body: unknown, sources: DelegateSources, agentDir = getAgentDir()): Promise<TeamSaveOutcome> {
  const stored = readTeamDefaults(agentDir);
  if (stored.state === "malformed")
    return { status: 409, body: { error: `${stored.file} can't be read (${stored.errors.join("; ")}), so it wasn't overwritten; fix or delete it first` } };
  const parsed = parseTeamDefaults(body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.errors.join("; ") } };
  const slots = ROLES.flatMap(([role, label]) =>
    (["primary", "fallback"] as const).map((slot) => ({ label: `${label} ${slot}`, tuple: parsed.value[role][slot], stored: stored.state === "ok" ? stored.value[role][slot] : undefined })),
  );
  const noEffort = slots.find((s) => s.tuple && !s.tuple.effort);
  if (noEffort) return { status: 400, body: { error: `${noEffort.label}: choose an effort` } };
  const verdict = verifySlots(
    slots.map((s) => ({ label: s.label, choice: s.tuple && choice(s.tuple), stored: s.stored && choice(s.stored) })),
    await teamOptions(sources),
    "the team",
    "isn't created",
  );
  if ("error" in verdict) return { status: 400, body: { error: verdict.error } };
  writeTeamDefaults(agentDir, parsed.value);
  return { status: 200, body: { ...teamDefaultsInfo(agentDir), warnings: verdict.warnings } };
}
