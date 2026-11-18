// pi's own names for an MCP tool, from pi-mcp's public naming rule (`createMcpToolName`, exported from
// pi 1.5.1; pi's MCP extension names every tool it registers with it). Sova's reading of a saved tool
// row (server/mcp/tool-names.ts) asks here instead of keeping a copy of the rule.
import { createMcpToolName } from "@earendil-works/pi-mcp";

/** The names pi can register `tool` of `server` under: its plain name, and the hashed form it takes when
    that is too long or another tool has it. */
export function piToolNames(server: string, tool: string): string[] {
  return [createMcpToolName(server, tool), createMcpToolName(server, tool, () => true)];
}
