import { Show } from "solid-js";
import { resolvedTheme, toggleTheme } from "./theme";

/**
 * Sova's mark and name, small, at the top of the owner page (§app.owner-page/content, Its frame), with the theme
 * toggle on the same row, to their right (§app.owner-page/page). The operator's preview draws the mark without the
 * toggle: a pick there would change the operator's own app.
 */

/** One button; its icon shows the action (24 grid, 1.5 stroke, round caps, as the design system's): a sun while dark, a moon while light. */
export function ThemeToggle() {
  const label = () => (resolvedTheme() === "dark" ? "Switch to light theme" : "Switch to dark theme");
  return (
    <button type="button" class="button button-icon button-ghost share-theme-toggle" aria-label={label()} title={label()} onClick={toggleTheme}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <Show when={resolvedTheme() === "dark"} fallback={<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
        </Show>
      </svg>
    </button>
  );
}

export function ShareBrand(props: { themeSwitch?: boolean; class?: string }) {
  return (
    <div class={props.class ? `share-brand ${props.class}` : "share-brand"}>
      <span class="share-brand-name">
        <span class="icon share-brand-mark" aria-hidden="true" />
        sova
      </span>
      <Show when={props.themeSwitch}>
        <ThemeToggle />
      </Show>
    </div>
  );
}
