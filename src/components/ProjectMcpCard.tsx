import { For, Show } from "solid-js";
import type { McpProjectServers, McpServerRow } from "../../shared/mcp";
import { getProjectMcp } from "../lib/api";
import { PROJECT_INTRO, PROJECT_NONE, projectBroken, projectGroups } from "../lib/mcp";
import { createPoll } from "../lib/poll";
import { McpRow } from "./McpServerRow";

const MCP_POLL_MS = 30_000;

/**
 * The project page's MCP Servers (§app.mcp/project-servers): what each checkout's `.mcp.json` declares,
 * with the same rows as Settings. Changes go through the file, so nothing here adds, edits or removes.
 */
export function ProjectMcpCard(props: { projectId: string }) {
  const poll = createPoll<McpProjectServers>(() => getProjectMcp(props.projectId), MCP_POLL_MS, { cacheKey: `project:${props.projectId}:mcp` });
  const replace = (row: McpServerRow) => {
    const now = poll.data();
    if (now) poll.set({ checkouts: now.checkouts.map((c) => ({ ...c, servers: c.servers.map((r) => (r.id === row.id ? row : r)) })) });
  };
  return (
    <section class="card orgs-section project-mcp" aria-labelledby="project-mcp">
      <h2 class="orgs-h2" id="project-mcp">
        MCP Servers
      </h2>
      <p class="orgs-line">{PROJECT_INTRO}</p>
      <Show when={poll.error() && !poll.data()}>
        <p class="field-error">Couldn't read the MCP servers. {poll.error()}</p>
      </Show>
      <Show when={poll.data()}>
        {(d) => (
          <Show when={projectGroups(d()).length} fallback={<p class="orgs-line">{PROJECT_NONE}</p>}>
            <For each={projectGroups(d())}>
              {(c) => (
                <div class="mcp-checkout">
                  <h3 class="mcp-heading">{c.folder}</h3>
                  <Show when={c.file === "broken"}>
                    <p class="field-error">{projectBroken((c.error ?? "").replace(/\.$/, ""))}</p>
                  </Show>
                  <Show when={c.servers.length}>
                    <ul class="mcp-rows">
                      <For each={c.servers}>{(r) => <McpRow row={r} onChange={replace} />}</For>
                    </ul>
                  </Show>
                </div>
              )}
            </For>
          </Show>
        )}
      </Show>
    </section>
  );
}
