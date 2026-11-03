import { createMemo, createResource, createSignal, Show, type JSX } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { fetchSchedules } from "../lib/api";
import { automationGroups, liveKey } from "../lib/automations-shelf";
import { ForKey } from "../lib/for-key";
import { Icon } from "./ui";

/**
 * The Automations region (§app.session-list/automations): a shortcut under Groups to the sessions
 * Sova's schedules run, one sub-group per schedule. Re-read from GET /api/schedules whenever the
 * list's live sessions change. `row` draws a session row the way the rest of the list does, from an accessor that follows each refresh.
 */
export function AutomationsShelf(props: { sessions: readonly SessionSummary[] | undefined; searching: boolean; row: (s: () => SessionSummary) => JSX.Element }) {
  const live = createMemo(() => liveKey(props.sessions));
  const [schedules] = createResource(live, async () => (await fetchSchedules().catch(() => ({ schedules: [] }))).schedules);
  const [open, setOpen] = createSignal(true);
  const groups = createMemo(() => automationGroups(schedules() ?? [], props.sessions ?? []));
  const count = () => groups().reduce((n, g) => n + g.rows.length, 0);
  return (
    <Show when={!props.searching && groups().length > 0}>
      <details class="sidebar-region sidebar-profiles sidebar-automations" aria-labelledby="r-automations" open={open()} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary class="sidebar-needs-you-summary">
          <h2 class="sidebar-region-head" id="r-automations" title="Sessions Sova's schedules run. They are listed below too.">
            <Icon name="chevron-right" small class="icon-twist" />
            Automations <span class="sidebar-region-count">· {count()}</span>
          </h2>
        </summary>
        {/* Keyed by schedule id and session path (lib/for-key): a refresh updates each in place, never rebuilds it. */}
        <ForKey each={groups()} by={(x) => x.id}>
          {(g) => (
            <div class="profile-shelf-group">
              <p class="profile-shelf-head">
                <Icon name="bell" small />
                <span class="profile-shelf-name">{g().label}</span>
                <span class="profile-shelf-project">
                  · {g().projectName} · {g().id}
                </span>
                <span class="text-muted">{g().longRunning ? "Long-running" : `${g().rows.length} live`}</span>
              </p>
              <ul class="list">
                <ForKey each={g().rows} by={(s) => s.path}>
                  {(s) => props.row(s)}
                </ForKey>
              </ul>
            </div>
          )}
        </ForKey>
      </details>
    </Show>
  );
}
