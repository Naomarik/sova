// The way to one MCP server's row (§app.mcp/in-a-chat): a chat's note names a row, the Settings tab
// or the project page opens it. A module signal, as Settings' sections are: the list that holds the
// row takes it once and opens the row.
import { createSignal } from "solid-js";
import type { McpNote } from "../../shared/mcp";
import { projectTabHref } from "./projects-route";
import { openSettings } from "./settings-nav";

const [wanted, setWanted] = createSignal<string | null>(null);
export const wantedMcpRow = wanted;
export const clearWantedMcpRow = (): void => {
  setWanted(null);
};

/** Opens the row a note links to: Settings' tab, or the project page's Settings tab. */
export function openMcpRow(link: NonNullable<McpNote["link"]>): void {
  setWanted(link.id);
  if (link.to === "settings") openSettings("mcp-servers");
  else location.hash = projectTabHref(link.projectId, "settings");
}
