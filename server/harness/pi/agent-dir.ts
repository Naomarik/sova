import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** pi's agent directory: $PI_CODING_AGENT_DIR (a leading ~ expanded), else ~/.pi/agent. Read per call
    (§app.harness/agent-root); the rest of the server asks `agentRoot()` (server/state-root.ts). */
export const piAgentDir = (): string => getAgentDir();
