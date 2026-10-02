import { For, type JSX } from "solid-js";
import { Icon, type IconName } from "./ui";
import "../home.css";

interface Action {
  id: string;
  icon: IconName;
  title: string;
  body: string;
  /** Opens its dialog. */
  run: () => void;
}

/**
 * The overview's Start section (§chat.transcript/landing-page): one card per way to start
 * something. The whole card is the control, a button that opens its dialog, named by its title and
 * described by its line.
 */
export function OverviewActions(props: { onNewSession(): void }) {
  const actions: Action[] = [
    { id: "new", icon: "plus", title: "New Session", body: "Start a chat with pi in any folder or on any host.", run: () => props.onNewSession() },
    { id: "access", icon: "external", title: "Access", body: "Get a code to unlock Sova on another browser, another address, or your other device.", run: () => { location.hash = "#/access"; } },
  ];
  return (
    <section class="explain-section" aria-labelledby="overview-start-title">
      <h2 class="explain-section-head" id="overview-start-title">
        Start
      </h2>
      <ul class="overview-actions">
        <For each={actions}>
          {(a) => {
            const inner = (): JSX.Element => (
              <>
                <span class="action-card-head">
                  <span class="action-card-mark">
                    <Icon name={a.icon} />
                  </span>
                  <span class="action-card-title" id={`overview-action-${a.id}`}>
                    {a.title}
                  </span>
                </span>
                <span class="action-card-body" id={`overview-action-${a.id}-body`}>
                  {a.body}
                </span>
              </>
            );
            const aria = { "aria-labelledby": `overview-action-${a.id}`, "aria-describedby": `overview-action-${a.id}-body` };
            return (
              <li>
                <button type="button" class="card action-card" {...aria} onClick={() => a.run()}>
                  {inner()}
                </button>
              </li>
            );
          }}
        </For>
      </ul>
    </section>
  );
}
