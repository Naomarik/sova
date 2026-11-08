import { render } from "solid-js/web";
import "./design/tokens.css";
import "./design/base.css";
import "./app.css";
import "./window-controls.css";
import { App } from "./App";
import { AuthShell } from "./components/Unlock";
import { unlockFromFragment } from "./lib/auth";
import { applyStoredTheme, clearTheme, clearTypography, setTextSize } from "./lib/theme";
import { applyStoredSpine } from "./lib/spine";
import { guardDelegatedEvents } from "./lib/release-control";
import { installWireStamp } from "./lib/wire-stamp";
import { installTabsOverflow } from "./lib/tabs-overflow";
import "./sw-register";

/**
 * The escape hatch, and the only thing that reads a theme off the URL.
 *
 * A theme can be entirely legal and still leave nothing on screen to click: every color set to
 * `#000000` passes the grammar (the ground rules check shape, not whether you can read the result), and it
 * paints the Themes picker in the same ink as its own background — so the one control that would
 * switch you back is the control the theme just erased. `?theme=default` always lands on the
 * starting setup — Dark mode, the built-in Dark and Light picks — whatever is cached, which makes
 * an unreadable theme recoverable with a URL instead of devtools, whichever pick it was.
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

// At startup, synchronously: the cached theme goes on the document (under Auto, the one the system's
// setting asks for). index.html's pre-paint script already painted it before the first frame (a
// module like this one runs after it, lib/theme-prepaint.ts); this takes over from it.
// App.tsx reconciles the cache against /api/themes once it's up.
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
// The document never scrolls (app.css), so a reload or an installed app's relaunch must not put
// back an offset left from before it: that offset is the list's head cut off at the top.
history.scrollRestoration = "manual";
// Before any event is handled: Solid's event delegation would otherwise leave an event, and
// through its path a closed view, alive for the page's life (lib/release-control).
installWireStamp();
// Every `.tabs` strip's edge fade where the browser has no scroll timelines (lib/tabs-overflow.ts).
installTabsOverflow();
guardDelegatedEvents(window, Object.getOwnPropertyDescriptor(Event.prototype, "currentTarget")!.get!);

// A `sova open` link's `#t=<token>` comes off the address bar before the app reads its own `#/…`
// route, and is posted while the shell holds the app back (lib/auth.ts).
void unlockFromFragment();

render(
  () => (
    <AuthShell>
      <App />
    </AuthShell>
  ),
  document.getElementById("root")!,
);
