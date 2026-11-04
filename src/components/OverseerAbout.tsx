import { createResource, For, onMount, Show } from "solid-js";
import { getOverseerAbilities } from "../lib/api";
import { ABOUT_FAILED, ABOUT_LOADING, ABOUT_TITLE, commandText, EXT_JOB, EXT_NONE, EXT_NOT_RUNNING, extIntro, limitRows } from "../lib/overseer-about";
import { openSettings } from "../lib/settings-nav";
import { Banner, Icon } from "./ui";
import "../overseer-todos.css";
import "../overseer-about.css";

/**
 * The Overseer page's About panel (§app.overseer/about): what the Overseer can do. Its built-in
 * abilities, its limits now, and the commands its extensions offer it, from the same reading sova_ext
 * uses (GET /api/overseer/abilities), so the panel and what it can run never disagree. Read each time
 * it opens. It takes the Ideas and Todos panels' place; one of the three is open at a time.
 */
export function OverseerAbout(props: { onClose(): void }) {
  const [info, { refetch }] = createResource(getOverseerAbilities);
  let titleEl!: HTMLHeadingElement;
  onMount(() => titleEl.focus());

  return (
    <aside
      class="todos-panel about-panel"
      id="overseer-about"
      aria-labelledby="about-title"
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        props.onClose();
      }}
    >
      <header class="todos-head">
        <div class="todos-head-main">
          <h2 class="todos-title" id="about-title" tabindex="-1" ref={titleEl}>
            {ABOUT_TITLE}
          </h2>
          <p class="todos-meta">What it can do, and its limits.</p>
        </div>
        <button type="button" class="button button-icon button-ghost" aria-label={`Close ${ABOUT_TITLE}`} onClick={() => props.onClose()}>
          <Icon name="close" />
        </button>
      </header>

      <div class="todos-body about-body" aria-busy={info.loading ? "true" : undefined}>
        <Show when={!info.error} fallback={<Banner tone="error" title={ABOUT_FAILED} action={<button type="button" class="button button-sm" onClick={() => void refetch()}>Try Again</button>} />}>
          <Show when={info()} fallback={<p class="todos-note">{ABOUT_LOADING}</p>}>
            {(a) => (
              <>
                <section class="about-section" aria-labelledby="about-built-in">
                  <h3 class="about-heading" id="about-built-in">
                    Built in
                  </h3>
                  <dl class="about-list">
                    <For each={a().builtIn}>
                      {(b) => (
                        <div class="about-item">
                          <dt class="about-name">{b.name}</dt>
                          <dd class="about-text">{b.text}</dd>
                        </div>
                      )}
                    </For>
                  </dl>
                </section>

                <section class="about-section" aria-labelledby="about-limits">
                  <h3 class="about-heading" id="about-limits">
                    Limits
                  </h3>
                  <dl class="about-limits">
                    <For each={limitRows(a().caps)}>
                      {(r) => (
                        <div class="about-limit">
                          <dt>{r.label}</dt>
                          <dd class="text-mono">{r.value}</dd>
                        </div>
                      )}
                    </For>
                  </dl>
                  <button type="button" class="button button-sm about-change" onClick={() => openSettings("overseer", "overseer-limits")}>
                    Change Limits
                  </button>
                </section>

                <section class="about-section" aria-labelledby="about-ext">
                  <h3 class="about-heading" id="about-ext">
                    From extensions
                  </h3>
                  <Show when={a().extensions.length > 0} fallback={<p class="about-note">{EXT_NONE}</p>}>
                    <p class="about-note">{extIntro(a().caps)}</p>
                    <For each={a().extensions}>
                      {(e) => (
                        <div class="about-ext" classList={{ "about-ext-stopped": !e.running }}>
                          <h4 class="about-ext-title">{e.title}</h4>
                          <Show when={!e.running}>
                            <p class="about-note about-stopped" title={e.error}>
                              {EXT_NOT_RUNNING}
                            </p>
                          </Show>
                          <ul class="about-commands" aria-label={`${e.title} commands`}>
                            <For each={e.commands}>
                              {(c) => (
                                <li class="about-command">
                                  <span class="about-command-label">{c.label}</span>
                                  <Show when={c.job}>
                                    <span class="chip about-job">{EXT_JOB}</span>
                                  </Show>
                                  <Show when={commandText(c)}>{(t) => <p class="about-text about-command-text">{t()}</p>}</Show>
                                </li>
                              )}
                            </For>
                          </ul>
                        </div>
                      )}
                    </For>
                  </Show>
                </section>
              </>
            )}
          </Show>
        </Show>
      </div>
    </aside>
  );
}
