import { HOME_HREF, SESSIONS_HREF } from "../lib/sessions-route";
import { Icon } from "./ui";
import "../home.css";

/**
 * A page head's leading links on a phone (§app.shell/home), the one place they are decided: the
 * brand mark home to `#/`, then the back link (to the list unless a page names another way back).
 * Both are folded-only; at 768px and up the list and its brand are beside every page.
 */
export function FoldedNav(props: { back?: { href: string; label: string } }) {
  const back = () => props.back ?? { href: SESSIONS_HREF, label: "Back to Sessions" };
  return (
    <span class="folded-nav">
      <a class="button button-icon button-ghost folded-home" href={HOME_HREF} aria-label="Home" title="Home">
        <span class="icon" style={{ "--icon": "url(/icons/sova-mark.svg)" }} aria-hidden="true" />
      </a>
      <a class="button button-icon button-ghost app-back" href={back().href} aria-label={back().label}>
        <Icon name="chevron-left" />
      </a>
    </span>
  );
}
