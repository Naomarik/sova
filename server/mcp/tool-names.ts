// What a tool row's name means. pi names a tool from its server and raw name, shortening a long one with a hash
// (quirk P35), so a chat's kept list says what each name was; a tool result's details say so too, on success. With
// neither it is no server's tool: a name alone can't tell, and `my-server` has already become `my_server` in it.
import { createHash } from "node:crypto";
import type { McpToolName } from "../../shared/mcp";
import type { McpChatList } from "./list-shape";

export type McpNames = ReadonlyMap<string, McpToolName>;

const NAME_MAX = 64;

/** pi's name for a tool, and the hashed form it takes when that is too long or taken. */
export function piToolNames(server: string, tool: string): string[] {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
  return [name, `${name.slice(0, NAME_MAX - hash.length - 1)}_${hash}`];
}

export function mcpNamesOf(list: McpChatList | null | undefined): McpNames {
  const names = new Map<string, McpToolName>();
  for (const s of list?.servers ?? []) for (const t of s.record.tools) for (const name of piToolNames(s.name, t.name)) names.set(name, { server: s.name, tool: t.name });
  return names;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** A tool-call or tool-result row's server and tool, or undefined for a tool of no server. */
export function mcpToolOfRow(name: string | undefined, details: unknown, names?: McpNames): McpToolName | undefined {
  const d = details as { server?: unknown; tool?: unknown } | null | undefined;
  if (isString(d?.server) && isString(d?.tool)) return { server: d.server, tool: d.tool };
  return name ? names?.get(name) : undefined;
}
