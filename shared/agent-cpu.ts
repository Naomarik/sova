import type { WholeRule } from "./form-rules";

/**
 * Settings → General's **Agents' CPU · this computer** (server/agent-cpu.ts): an off-by-default ceiling on
 * the CPU every agent together may use (chats, their background jobs, project services: everything in
 * systemd's `sova.slice`), as "Agents may use at most N of M cores". Linux with a systemd user manager
 * only; elsewhere `available` is false and `why` says so. GET and PUT `/api/settings/agent-cpu`.
 */
export interface AgentCpuState {
  /** Whether this computer can limit the agents' CPU. */
  available: boolean;
  /** Why it can't, one sentence, when `available` is false. */
  why: string | null;
  /** The cores this computer has (M). */
  cores: number;
  /** The saved ceiling (N cores), or null: no ceiling (the default). */
  maxCores: number | null;
  /** The ceiling systemd holds on the agents' slice now, in cores (null: none), when it was asked. */
  inForce: number | null;
}

/** PUT `/api/settings/agent-cpu`'s body: a whole number of cores, or null to remove the ceiling. */
export interface AgentCpuSet {
  maxCores: number | null;
}

/** The ceiling's rule: 1 to the computer's cores, both on the page and in the route. */
export const agentCoresRule = (cores: number): WholeRule => ({ kind: "whole", label: "Cores", min: 1, max: Math.max(1, cores) });
