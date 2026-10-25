import { For, type JSX, Show } from "solid-js";
import { setThemePick, THEME_PICKS, themePick, type ThemePick } from "./theme";

/**
 * Sova's mark and name, small, at the top of the owner page (§app.owner-page/content, Its frame), with the theme
 * switch beside them (§app.owner-page/page). The operator's preview draws the mark without the switch: a pick there
 * would change the operator's own app.
 */

const LABEL: Record<ThemePick, string> = { system: "System", light: "Light", dark: "Dark" };

/** Each pick's icon (24 grid, 1.5 stroke, round caps, as the design system's): a screen, a sun, a moon. */
const ICON: Record<ThemePick, () => JSX.Element> = {
  system: () => (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  light: () => (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </>
  ),
  dark: () => <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
};

export function ThemeSwitch() {
  return (
    <div class="share-theme" role="group" aria-label="Theme">
      <For each={THEME_PICKS}>
        {(p) => (
          <button type="button" class="button button-icon button-ghost share-theme-pick" aria-pressed={themePick() === p ? "true" : "false"} aria-label={LABEL[p]} title={LABEL[p]} onClick={() => setThemePick(p)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              {ICON[p]()}
            </svg>
          </button>
        )}
      </For>
    </div>
  );
}

export function ShareBrand(props: { themeSwitch?: boolean; class?: string }) {
  return (
    <div class={props.class ? `share-brand ${props.class}` : "share-brand"}>
      <span class="share-brand-name">
        <span class="icon share-brand-mark" aria-hidden="true" />
        Sova
      </span>
      <Show when={props.themeSwitch}>
        <ThemeSwitch />
      </Show>
    </div>
  );
}
