import { For, Match, Show, Switch } from "solid-js";
import type { OwnerVersionRow } from "../../shared/project-assistant";

/**
 * The versions the owner can try (§app.project-assistant/versions), as rows: on Home under
 * "Versions you can try", and inside the assistant's bubble after it started one. `Open` while it
 * runs, `Starting…` (disabled) while it starts, the quiet failed line, or "Not running right now"; a fix's summary of
 * what it changes under its name, when one is shown.
 * Without `href` (the operator's preview) Open shows but leads nowhere.
 */

/** The row's meta line under its label. */
export function versionMeta(v: OwnerVersionRow): string {
  if (v.state === "failed") return `${v.project} · It didn't start. The team knows.`;
  if (v.state === "not-running") return `${v.project} · Not running right now`;
  return v.project;
}

/** Whether any row is starting: its page reads again every 3 s until none is. */
export const versionsStarting = (rows: readonly OwnerVersionRow[] | undefined): boolean => !!rows?.some((v) => v.state === "starting");

export function VersionRows(props: { versions: readonly OwnerVersionRow[]; href?: (handle: string) => string }) {
  return (
    <ul class="owner-list owner-versions">
      <For each={props.versions}>
        {(v) => (
          <li class="owner-row owner-row-static">
            <span class="owner-row-main">
              <span class="owner-row-title">{v.label}</span>
              <span class="owner-meta">{versionMeta(v)}</span>
              <Show when={v.summary}>{(t) => <span class="owner-version-summary">{t()}</span>}</Show>
            </span>
            <Switch>
              <Match when={v.state === "starting"}>
                <span class="button owner-version-open" aria-disabled="true" role="status">
                  Starting…
                </span>
              </Match>
              <Match when={v.state === "running"}>
                <Show when={props.href} fallback={<span class="button owner-version-open" aria-disabled="true">Open</span>}>
                  {(href) => (
                    <a class="button owner-version-open" href={href()(v.handle)} target="_blank" rel="noopener noreferrer">
                      Open
                    </a>
                  )}
                </Show>
              </Match>
            </Switch>
          </li>
        )}
      </For>
    </ul>
  );
}
