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

/**
 * Where a chat process keeps its server's bookkeeping (its run's in-flight marker, the session's
 * writer lock): the state root of the server that started it, `SOVA_CHAT_STATE_ROOT`, when its own
 * agent dir is another (a worker on its worktree's agent dir); else the state root.
 */
export const chatStateRoot = () => process.env.SOVA_CHAT_STATE_ROOT || stateRoot();
