import { join } from "node:path";
import { piAgentDir } from "./harness/pi/agent-dir";

/**
 * The agent directory (§app.harness/agent-root): $PI_CODING_AGENT_DIR, else ~/.pi/agent, resolved as
 * the harness resolves it. Read per call: PI_CODING_AGENT_DIR is what the tests move.
 */
export const agentRoot = (): string => piAgentDir();

/**
 * Sova's own state root (`<agent dir>/sova/`): the JSON stores, durable attachments, the remote
 * placeholder layout, the connect seed dir, the user themes folder.
 * Read per call, like every agent-dir path: PI_CODING_AGENT_DIR is what the tests move.
 */
export const stateRoot = () => join(agentRoot(), "sova");
