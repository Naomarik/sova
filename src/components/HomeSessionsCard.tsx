import { For, Show } from "solid-js";
import type { SessionsGlance } from "../lib/home-sessions";
import { relativeTime } from "../lib/format";
import { sessionHref } from "./Sidebar";
import { Chip, Icon } from "./ui";
import "../home.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The home screen's Sessions card (§chat.transcript/landing-page): the list at a glance. The card
 * itself opens the session list (`onOpenList`: the list view on a phone, the unfolded pane on a wide
 * window); the Needs-you names and Resume are their own links on top of it.
 */
export function HomeSessionsCard(props: { glance: SessionsGlance; now: number; onOpenList(): void }) {
  const g = () => props.glance;
  const more = () => g().needsYou - g().needsYouFirst.length;
  return (
    <section class="explain-section" aria-labelledby="home-sessions-title">
      <h2 class="explain-section-head" id="home-sessions-title">
        Sessions
      </h2>
      <div class="card home-sessions" classList={{ "home-sessions-needs": g().needsYou > 0 }}>
        <div class="home-sessions-head">
          <Icon name="chat" class="home-sessions-icon" />
          {/* The card's one big target: its ::after covers the card, under the links below. */}
          <button
            type="button"
            class="home-sessions-open"
            aria-label={`${plural(g().total, "session")} across ${plural(g().folders, "folder")}: open the session list`}
            onClick={() => props.onOpenList()}
          >
            {plural(g().total, "session")} across {plural(g().folders, "folder")}
          </button>
          <Show when={g().needsYou}>
            <Chip tone="warn">
              Needs you · <span class="text-num">{g().needsYou}</span>
            </Chip>
          </Show>
        </div>
        <p class="home-sessions-line">
          {g().live} live · {g().working} working now
        </p>
        <Show when={g().needsYouFirst.length}>
          <p class="home-sessions-waiting">
            Waiting on you:{" "}
            <For each={g().needsYouFirst}>
              {(s, i) => (
                <>
                  {i() > 0 ? ", " : ""}
                  <a class="home-sessions-link" href={sessionHref(s.path)}>
                    {s.title}
                  </a>
                </>
              )}
            </For>
            {more() > 0 ? ` and ${more()} more` : ""}
          </p>
        </Show>
        <Show when={g().last} fallback={<p class="home-sessions-meta">Nothing yet: start one above.</p>}>
          {(last) => (
            <div class="home-sessions-last">
              <p class="home-sessions-meta">
                Last active <span class="home-sessions-title">{last().title}</span> · {relativeTime(last().lastActiveAt, props.now)}
              </p>
              <a class="button button-sm home-sessions-resume" href={sessionHref(last().path)} aria-label={`Resume ${last().title}`}>
                Resume
              </a>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}
