import { render } from "solid-js/web";
import "./design/tokens.css";
import "./design/base.css";
import "./app.css";
import { App } from "./App";
import { applyStoredTheme, clearTheme } from "./lib/theme";
import "./sw-register";

/**
 * The escape hatch, and the only thing that reads a theme off the URL.
 *
 * A theme can be entirely legal and still leave nothing on screen to click: every color set to
 * `#000000` passes the grammar (§0 checks shape, not whether you can read the result), and it
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
// themed window flashes the default first (spec/00-ground-rules.md §0). App.tsx reconciles the
// cache against /api/themes once it's up.
if (themeResetRequested()) clearTheme();
else applyStoredTheme();

render(() => <App />, document.getElementById("root")!);
