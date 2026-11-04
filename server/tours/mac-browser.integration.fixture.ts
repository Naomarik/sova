import { discoverTourBrowser, findMacHeadlessShell, insideAppBundle } from "./browser";

/**
 * macOS: a test that confines the recording browser needs Chrome's headless shell. Skips only when no
 * browser that can run confined is installed: starting an app-bundle Chrome confined would crash it and
 * raise a "quit unexpectedly" dialog on the user's screen. Elsewhere: false, nothing changes.
 */
export function macConfinedBrowserSkip(): string | false {
  if (process.platform !== "darwin") return false;
  let browser: string | undefined;
  try { browser = discoverTourBrowser(); } catch { /* none, or a configured path that isn't there */ }
  if (browser ? !insideAppBundle(browser) : findMacHeadlessShell()) return false;
  return "macOS: no chrome-headless-shell installed (npx playwright install chromium-headless-shell); an app-bundle Chrome is never started confined";
}
