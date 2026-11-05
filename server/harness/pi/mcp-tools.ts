// Each pi tool name's server and tool, for a tool row: a hashed name has lost the raw one. Filled as a chat's tools register.
import type { McpToolName } from "../../../shared/mcp";

const names = new Map<string, McpToolName>();
export const noteMcpTool = (name: string, tool: McpToolName): void => void names.set(name, tool);
export const mcpToolOf = (name: string): McpToolName | undefined => names.get(name);
