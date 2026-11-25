// `transport_setup`, the Transport agent's own tool (§app.transport/agent "Downloads, on your click", "Administrator
// rights stay yours"): served only to a Transport agent's chat (server/chat-handle.ts servedToolsForChat), it puts on
// the agent's card what it asks you: a download list (each tool, its version and the host it comes from), a command
// needing administrator rights for you to run yourself, or a file outside the project on the device the chat came
// from. It changes nothing about the agent's sandbox and runs nothing of the agent's: only your Allow, Done or Bring on
// the card does anything. After arrival it also starts the chat's running copy again through Sova's own project services
// (start_copy) and reads its logs (copy_logs); whether the transport is Ready is still Sova's reading after the turn. A declaration here; the run is set at start (routes.ts), so this
// module imports nothing heavy.
import type { ToolSpec } from "../../shared/harness";

export const TRANSPORT_SETUP_TOOL = "transport_setup";

export const TRANSPORT_SETUP_DESCRIPTION =
  "Ask the user, on the Transport card, for what your sandbox can't do. " +
  'downloads {items: [{tool, version, host}], why}: the tools you need from sites the network refuses, each with the exact version and the one host it downloads from (a plain host name like nodejs.org; list every host the download goes to). Nothing is reachable until the user presses Allow Downloads; then exactly those hosts are. ' +
  "admin {command, why}: a command that needs administrator rights (sudo, system packages, services), which you never run: the user runs it themselves and presses Done. Only for those: a folder or file outside your sandbox that needs no administrator rights is asked with align, never as an admin command. " +
  "outside_file {path, why}: a file the project needs that lives outside the project on the device the chat came from, in the user's home there (path as ~/…); the user brings that one file here (the same path in this home) or places it themselves. Never the private settings (~/.ssh, ~/.aws, ~/.gnupg and the like). " +
  "After any of those, end your turn: you are told when the user has answered. " +
  "start_copy {}: after arrival, Sova starts the project's running copy here again (its services the other device ran, each waited ready) and opens its entry page; it answers what runs and what failed. " +
  "copy_logs {copy?, service? | step?, lines?}: the running copy's log, a service's or a failed setup or data step's.";

export const TRANSPORT_SETUP_PARAMETERS = {
  type: "object",
  properties: {
    op: { type: "string", enum: ["downloads", "admin", "outside_file", "start_copy", "copy_logs"], description: "downloads | admin | outside_file | start_copy | copy_logs" },
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
    path: { type: "string", description: "outside_file: the file in the user's home on the device the chat came from, as ~/…" },
    copy: { type: "string", description: "copy_logs: which running copy (default the first)." },
    service: { type: "string", description: "copy_logs: a service's log." },
    step: { type: "string", description: "copy_logs: a setup or data step's log, as the failure names it." },
    lines: { type: "number", description: "copy_logs: how many lines (default 80, at most 200)." },
    why: { type: "string", description: "One sentence for the user: what it is for." },
  },
  required: ["op"],
  additionalProperties: false,
} as const;

/** The server's run of a call (agent.ts askDownloads, askAdmin, askOutsideFile, startCopy, copyLogs with this server's
    deps), set at start. */
type SetupAnswer = { ok: true; text: string } | { ok: false; error: string };
export type TransportSetupRun = (sessionId: string, params: Record<string, unknown>) => SetupAnswer | Promise<SetupAnswer>;
let run: TransportSetupRun | null = null;
export const setTransportSetupRun = (r: TransportSetupRun | null): void => void (run = r);

/** The tool for the agent chat `sessionId`. */
export function transportSetupTool(sessionId: string): ToolSpec {
  return {
    name: TRANSPORT_SETUP_TOOL,
    label: "Transport setup",
    description: TRANSPORT_SETUP_DESCRIPTION,
    promptSnippet: "ask the user on the Transport card (a download list, an admin command, a file from the other device), or start the arrived running copy again and read its logs",
    parameters: TRANSPORT_SETUP_PARAMETERS as never,
    async execute(_id, params) {
      if (!run) throw new Error("This server runs no Transport agent.");
      const r = await run(sessionId, (params ?? {}) as Record<string, unknown>);
      if (!r.ok) throw new Error(r.error);
      return { content: [{ type: "text", text: r.text }], details: null };
    },
  };
}
