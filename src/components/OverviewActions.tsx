import { For, type JSX } from "solid-js";
import { ORGS_HREF } from "../lib/orgs-route";
import { Icon, type IconName } from "./ui";
import "../home.css";

interface Action {
  id: string;
  icon: IconName;
  title: string;
  body: string;
  /** A dialog to open, or a route to go to. */
  run: (() => void) | { href: string };
}

/**
 * The overview's Start section (§chat.transcript/landing-page): one card per way to start
 * something. The whole card is the control — a button when it opens a dialog, a link when it goes
 * to a page — named by its title and described by its line.
 */
export function OverviewActions(props: { onNewSession(): void; onFanOut(): void }) {
  const actions: Action[] = [
    { id: "new", icon: "plus", title: "New Session", body: "Start a chat with pi in any folder or on any host.", run: () => props.onNewSession() },
    { id: "fanout", icon: "branch", title: "Fan Out", body: "Send one prompt to several models and compare the replies side by side.", run: () => props.onFanOut() },
    { id: "orgs", icon: "network", title: "Organizations", body: "Keep each client's people, projects, and hand-off sessions together.", run: { href: ORGS_HREF } },
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
            const run = a.run;
            return (
              <li>
                {typeof run === "function" ? (
                  <button type="button" class="card action-card" {...aria} onClick={run}>
                    {inner()}
                  </button>
                ) : (
                  <a class="card action-card" href={run.href} {...aria}>
                    {inner()}
                  </a>
                )}
              </li>
            );
          }}
        </For>
      </ul>
    </section>
  );
}
