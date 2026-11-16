import type { AgentCpuState } from "../../shared/agent-cpu";

/**
 * Settings → General's Agents' CPU (src/components/AgentCpuSettings.tsx): its words and its first
 * value, pure for tests.
 */

/** The ceiling the switch offers when turned on: all but 2 cores, at least 1. */
export const firstCeiling = (cores: number): number => Math.max(1, cores - 2);

export const coresWord = (n: number): string => `${n} ${n === 1 ? "core" : "cores"}`;

/** What a save announces. */
export const savedLine = (s: Pick<AgentCpuState, "maxCores" | "cores">): string =>
  s.maxCores === null ? "Agents may use every core again." : `Agents may now use at most ${s.maxCores} of ${coresWord(s.cores)}.`;

/** When systemd holds something other than the saved ceiling (another program changed it), one sentence; else null. */
export function driftLine(s: AgentCpuState): string | null {
  if (!s.available || s.inForce === s.maxCores) return null;
  const held = s.inForce === null ? "no ceiling" : `a ceiling of ${coresWord(s.inForce)}`;
  return `systemd holds ${held} on the agents now. Sova puts your setting back when it next starts.`;
}
