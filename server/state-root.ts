import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Sova's own state root (`<agent dir>/sova/`): the JSON stores, durable attachments, the remote
 * placeholder layout, the connect seed dir, the user themes folder.
 * Read per call, like every agent-dir path: PI_CODING_AGENT_DIR is what the tests move.
 */
export const stateRoot = () => join(getAgentDir(), "sova");
