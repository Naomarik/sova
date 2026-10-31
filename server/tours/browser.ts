import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { chromium, type Browser } from "playwright-core";

/** Safe authored setup copy, never a browser's stderr or an executable/profile path. */
export class TourBrowserSetupError extends Error {}

/** Discover installed software only. This module never invokes an installer or downloads. */
export function discoverTourBrowser(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const configured = env.SOVA_TOUR_BROWSER;
  const candidates = configured ? [configured] : [
    ...(env.PATH ?? "").split(delimiter).flatMap((p) => ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"].map((n) => join(p, n))),
    ...(platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"] : []),
  ];
  for (const file of candidates) {
    try { if (!statSync(file).isFile()) continue; accessSync(file, constants.X_OK); return file; } catch { /* try installed locations */ }
  }
  throw new TourBrowserSetupError(configured
    ? "The configured recording browser cannot run. Set SOVA_TOUR_BROWSER to an installed Chrome or Chromium executable. Nothing was downloaded."
    : "Chrome or Chromium is not installed. Install one or set SOVA_TOUR_BROWSER to its executable, then retry. Sova never downloads a browser.");
}

/** Chromium's longest supported named-socket path, with safety margin below sun_path. */
export function assertTourBrowserTempPath(base: string): string {
  const socket = join(base, ".org.chromium.Chromium.scoped_dir.XXXXXX", "SingletonSocket");
  if (Buffer.byteLength(socket) > 100) throw new TourBrowserSetupError("The recording temporary path is too long for Chrome's private Unix sockets. Configure a shorter writable TMPDIR on the recording host, then retry; the sandbox is never disabled.");
  return socket;
}

/** Private writable storage with a short path budget for Chromium's named Unix sockets. */
export function createTourBrowserStorage(base = tmpdir()) {
  const root = mkdtempSync(join(base, "b-"));
  // Chromium creates named Unix sockets below TMPDIR. Deep descriptive prefixes can exceed
  // sun_path's ~108-byte limit and SIGTRAP before a page exists; keep this private tree short.
  const paths = { HOME: join(root, "h"), XDG_CONFIG_HOME: join(root, "c"), XDG_CACHE_HOME: join(root, "k"), XDG_DATA_HOME: join(root, "d"), TMPDIR: base };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    // The parent already owns this attempt's private tmp (or the OS sandbox supplies it).
    // Nesting Chromium's own temporary sockets below b-/t needlessly consumes sun_path.
    assertTourBrowserTempPath(paths.TMPDIR);
    for (const dir of Object.values(paths).filter(dir => dir !== base)) mkdirSync(dir, { mode: 0o700 });
    return { root, paths, cleanup };
  } catch (error) { cleanup(); throw error; }
}

/**
 * Playwright 1.58.2's own `--disable-features` switch, exactly as it emits it (chromiumSwitches),
 * which the launch drops for one merged switch. If a Playwright upgrade changes it, nothing is
 * dropped and two switches remain: browser-prediction.integration checks there is exactly one.
 */
const PLAYWRIGHT_FEATURES = ["AvoidUnnecessaryBeforeUnloadCheckSync", "BoundaryEventDispatchTracksNodeRemoval", "DestroyProfileOnBrowserClose", "DialMediaRouteProvider", "GlobalMediaControls", "HttpsUpgrades", "LensOverlay", "MediaRouter", "PaintHolding", "ThirdPartyStoragePartitioning", "Translate", "AutoDeElevate", "RenderDocument", "OptimizationHints"];
const PLAYWRIGHT_DISABLED_FEATURES = `--disable-features=${PLAYWRIGHT_FEATURES.join(",")}`;
/** Playwright's features plus the recorder's own: no network prediction, preconnect or speculative loads. */
const TOUR_DISABLED_FEATURES = `--disable-features=${[...PLAYWRIGHT_FEATURES, "NetworkPrediction", "SpeculationRulesPrefetchFuture", "SpeculationRulesPrefetchProxy", "Prerender2", "PreloadingHeuristics", "LinkPreconnect"].join(",")}`;

/** Fresh temporary profile and pipe-based Playwright transport, never a personal CDP browser. */
export async function launchTourBrowser(executablePath = discoverTourBrowser(), opts: { webrtcUdp?: boolean } = {}): Promise<Browser> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy;
  // Crashpad/XDG must never fall back to the inherited read-only HOME or a personal profile.
  const { root, paths, cleanup } = createTourBrowserStorage();
  try {
    const browser = await chromium.launch({
    executablePath, headless: true,
    env: { ...process.env, ...paths },
    // The controller and browser are already inside the chat's OS sandbox. Chromium's inner
    // user-namespace sandbox cannot nest on every host; disabling it does not remove the outer one.
    args: [`--crash-dumps-dir=${join(root, "crashes")}`, "--no-sandbox", "--disable-dev-shm-usage", "--disable-quic",
      // A test of a wall that must hold WebRTC itself (the card box's) asks for the user's default.
      ...(opts.webrtcUdp ? [] : ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]),
      // No speculative contact outside the per-request consent and address checks: no DNS prefetch,
      // preconnect, speculation-rules prefetch/prerender or background networking.
      "--dns-prefetch-disable", "--disable-background-networking", "--disable-blink-features=SpeculationRules", TOUR_DISABLED_FEATURES],
    // Chromium keeps one of duplicated switches: Playwright's own list is replaced by the merged one.
    ignoreDefaultArgs: [PLAYWRIGHT_DISABLED_FEATURES],
    // Loopback is not exempt: Playwright emits exactly one --proxy-bypass-list=<-loopback>.
    ...(proxy ? { proxy: { server: proxy, bypass: "<-loopback>" } } : {}),
    downloadsPath: paths.TMPDIR,
    });
    browser.once("disconnected", cleanup);
    return browser;
  } catch (error) { cleanup(); throw error; }
}
