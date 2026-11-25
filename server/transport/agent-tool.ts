// `transport_setup`, the Transport agent's own tool (§app.transport/agent "Downloads, on your click", "Administrator
// rights stay yours"): served only to a Transport agent's chat (server/chat-handle.ts servedToolsForChat), it puts on
// the agent's card what it asks you: a download list (each tool, its version and the host it comes from), or a command
// needing administrator rights for you to run yourself. It changes nothing about the agent's sandbox and runs nothing:
// only your Allow or Done on the card does anything. A declaration here; the run is set at start (routes.ts), so this
// module imports nothing heavy.
import type { ToolSpec } from "../../shared/harness";

export const TRANSPORT_SETUP_TOOL = "transport_setup";

export const TRANSPORT_SETUP_DESCRIPTION =
  "Ask the user, on the Transport card, for what your sandbox can't do. " +
  'downloads {items: [{tool, version, host}], why}: the tools you need from sites the network refuses, each with the exact version and the one host it downloads from (a plain host name like nodejs.org; list every host the download goes to). Nothing is reachable until the user presses Allow Downloads; then exactly those hosts are. ' +
  "admin {command, why}: a command that needs administrator rights (sudo, system packages, services), which you never run: the user runs it themselves and presses Done. " +
  "After either, end your turn: you are told when the user has answered.";

export const TRANSPORT_SETUP_PARAMETERS = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["downloads", "admin"], description: "downloads | admin" },
    items: {
      type: "array",
      description: "downloads: each tool to download.",
      items: {
        type: "object",
        properties: {
          tool: { type: "string", description: "The tool, like node or java." },
          version: { type: "string", description: "The exact version it gets, like 22.11.0." },
          host: { type: "string", description: "The host it downloads from, like nodejs.org." },
        },
        required: ["tool", "version", "host"],
        additionalProperties: false,
      },
    },
    command: { type: "string", description: "admin: the exact command for the user to run." },
    why: { type: "string", description: "One sentence for the user: what it is for." },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

/** The server's run of a call (agent.ts askDownloads / askAdmin with this server's deps), set at start. */
export type TransportSetupRun = (sessionId: string, params: Record<string, unknown>) => { ok: true; text: string } | { ok: false; error: string };
let run: TransportSetupRun | null = null;
export const setTransportSetupRun = (r: TransportSetupRun | null): void => void (run = r);

/** The tool for the agent chat `sessionId`. */
export function transportSetupTool(sessionId: string): ToolSpec {
  return {
    name: TRANSPORT_SETUP_TOOL,
    label: "Transport setup",
    description: TRANSPORT_SETUP_DESCRIPTION,
    promptSnippet: "ask the user on the Transport card: a download list to allow, or an admin command to run themselves",
    parameters: TRANSPORT_SETUP_PARAMETERS as never,
    async execute(_id, params) {
      if (!run) throw new Error("This server runs no Transport agent.");
      const r = run(sessionId, (params ?? {}) as Record<string, unknown>);
      if (!r.ok) throw new Error(r.error);
      return { content: [{ type: "text", text: r.text }], details: null };
    },
  };
}
