import { render } from "solid-js/web";
import "./design/tokens.css";
import "./design/base.css";
import "./app.css";
import { App } from "./App";
import { applyStoredTheme, clearTheme, clearTypography, setTextSize } from "./lib/theme";
import { applyStoredSpine } from "./lib/spine";
import "./sw-register";

/**
 * The escape hatch, and the only thing that reads a theme off the URL.
 *
 * A theme can be entirely legal and still leave nothing on screen to click: every color set to
 * `#000000` passes the grammar (the ground rules check shape, not whether you can read the result), and it
 * paints the Themes picker in the same ink as its own background — so the one control that would
 * switch you back is the control the theme just erased. `?theme=default` always lands on the
 * built-in dark, whatever is cached, which makes an unreadable theme recoverable with a URL
 * instead of devtools.
 *
 * It is a one-way reset, not theme-by-URL: `default` and `dark` name the same built-in default,
 * and every other value is ignored rather than applied. The param is stripped straight after, so
 * the reset doesn't stick to a bookmarked or shared link.
 */
function themeResetRequested(): boolean {
  const params = new URLSearchParams(location.search);
  const asked = params.get("theme");
  if (asked !== "default" && asked !== "dark") return false;
  params.delete("theme");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  return true;
}

// Before first paint, synchronously: the cached theme goes on the document now, or a reload of a
// themed window flashes the default first. App.tsx reconciles the
// cache against /api/themes once it's up.
// The escape hatch takes the font pick and the text size off too: one URL that lands on the
// built-in dark in the built-in faces at the built-in size, whatever was cached.
if (themeResetRequested()) {
  clearTheme();
  clearTypography();
  setTextSize("medium");
} else applyStoredTheme();
// The collapsed sessions pane, the same way: a reload of a collapsed window must not flash the
// full pane first (lib/spine.ts).
applyStoredSpine();

render(() => <App />, document.getElementById("root")!);
