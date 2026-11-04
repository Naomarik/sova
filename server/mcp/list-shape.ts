// A chat's list as session state (§app.mcp/tool-list): the shape alone, read by the state registry.
import type { McpCheckRecord } from "./store";
import type { McpOwner } from "./trust";

/** One server of a chat's list. */
export interface McpChatServer {
  id: string;
  name: string;
  owner: McpOwner;
  kind: "command" | "address";
  version: string;
  /** The record with the tools that were on when the list was made. */
  record: McpCheckRecord;
}

export interface McpChatList {
  v: 1;
  servers: McpChatServer[];
}

export const NO_MCP: McpChatList = { v: 1, servers: [] };

/** A list as session state: anything else is no list. */
export function normalizeChatList(v: unknown): McpChatList | null {
  const d = v as Partial<McpChatList> | null;
  if (!d || d.v !== 1 || !Array.isArray(d.servers)) return null;
  const good = d.servers.every((s) => s && typeof s.name === "string" && typeof s.id === "string" && typeof s.version === "string" && s.owner && s.record && Array.isArray(s.record.tools));
  return good ? { v: 1, servers: d.servers } : null;
}
