import { createSignal, For, Show } from "solid-js";
import type { McpServerRow, McpServers } from "../../shared/mcp";
import { getMcpServers } from "../lib/api";
import { MCP_INTRO, MCP_LOAD_FAILED, MCP_NONE, MCP_TITLE, mcpLoadFailedBody } from "../lib/mcp";
import { createPoll } from "../lib/poll";
import { McpServerDialog } from "./McpAddServer";
import { McpRow } from "./McpServerRow";
import { Banner } from "./ui";

const MCP_POLL_MS = 30_000;

/** Settings → MCP Servers (§app.mcp/settings-tab): this computer's servers. Every action on it saves at once. */
export function McpSettingsSection() {
  const poll = createPoll<McpServers>(getMcpServers, MCP_POLL_MS, { cacheKey: "mcp:servers" });
  const [adding, setAdding] = createSignal(false);
  const [editing, setEditing] = createSignal<McpServerRow | null>(null);
  const replace = (row: McpServerRow) => {
    const now = poll.data();
    if (now) poll.set({ servers: now.servers.map((r) => (r.id === row.id ? row : r)) });
  };
  return (
    <section class="settings-delegate mcp-settings" aria-labelledby="settings-mcp-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-mcp-title">
          {MCP_TITLE}
        </h3>
        <button type="button" class="button button-sm button-primary" onClick={() => setAdding(true)}>
          Add Server
        </button>
      </div>
      <p class="settings-intro">{MCP_INTRO}</p>
      <Show when={poll.error() && !poll.data()}>
        <Banner tone="error" title={MCP_LOAD_FAILED} body={mcpLoadFailedBody(poll.error()!)} />
      </Show>
      <Show when={poll.data()}>
        {(d) => (
          <Show when={d().servers.length} fallback={<p class="mcp-line">{MCP_NONE}</p>}>
            <ul class="mcp-rows" data-testid="mcp-servers">
              <For each={d().servers}>{(r) => <McpRow row={r} onChange={replace} onEdit={setEditing} onRemoved={poll.refetch} />}</For>
            </ul>
          </Show>
        )}
      </Show>
      <Show when={adding()}>
        <McpServerDialog taken={poll.data()?.servers.map((r) => r.name) ?? []} onClose={() => setAdding(false)} onChanged={poll.refetch} />
      </Show>
      <Show when={editing()}>{(row) => <McpServerDialog editing={row()} onClose={() => setEditing(null)} onChanged={poll.refetch} />}</Show>
    </section>
  );
}
