import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { chromium, type Browser } from "playwright-core";

/** Safe authored setup copy, never a browser's stderr or an executable/profile path. */
export class TourBrowserSetupError extends Error {}

function isRunnableFile(file: string): boolean {
  try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/** The chrome-headless-shell revision this Sova's playwright-core pins, or undefined. */
export function pinnedHeadlessShellRevision(): string | undefined {
  try {
    const dir = dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"));
    const list = (JSON.parse(readFileSync(join(dir, "browsers.json"), "utf8")) as { browsers?: { name?: string; revision?: string }[] }).browsers;
    const revision = list?.find(b => b.name === "chromium-headless-shell")?.revision;
    return typeof revision === "string" && /^\d+$/.test(revision) ? revision : undefined;
  } catch { return undefined; }
}

/**
 * macOS only: Playwright's already-installed chrome-headless-shell, which runs under the Seatbelt
 * sandbox (its `browser` rules) and, unlike an app-bundle Chrome, never raises a crash or Keychain
 * dialog. Where Playwright keeps it: PLAYWRIGHT_BROWSERS_PATH, else ~/Library/Caches/ms-playwright.
 * The pinned revision first, else the newest; this machine's architecture first. Never downloads.
 */
export function findMacHeadlessShell(env: NodeJS.ProcessEnv = process.env, pinned = pinnedHeadlessShellRevision(), arch: string = process.arch): string | undefined {
  let caches: string[];
  if (env.PLAYWRIGHT_BROWSERS_PATH === "0") {
    try { caches = [join(dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), ".local-browsers")]; } catch { return undefined; }
  } else if (env.PLAYWRIGHT_BROWSERS_PATH) caches = [env.PLAYWRIGHT_BROWSERS_PATH];
  else {
    // HOME first, then the account's own (a runtime whose HOME was changed after it started; Bun answers
    // with the HOME it started with, so the test runner names the cache: PLAYWRIGHT_BROWSERS_PATH).
    let account: string | undefined;
    try { account = userInfo().homedir; } catch { /* no passwd entry */ }
    caches = [...new Set([env.HOME || homedir(), ...(account ? [account] : [])])].map(h => join(h, "Library", "Caches", "ms-playwright"));
  }
  const revisions: { n: number; dir: string }[] = [];
  for (const cache of caches) {
    try { for (const d of readdirSync(cache)) { const m = /^chromium_headless_shell-(\d+)$/.exec(d); if (m) revisions.push({ n: Number(m[1]), dir: join(cache, d) }); } } catch { /* not there */ }
  }
  const first = pinned === undefined ? NaN : Number(pinned);
  revisions.sort((a, b) => Number(b.n === first) - Number(a.n === first) || b.n - a.n);
  const own = `chrome-headless-shell-mac-${arch}`;
  for (const r of revisions) {
    let platforms: string[] = [];
    try { platforms = readdirSync(r.dir).filter(p => /^chrome-headless-shell-mac-/.test(p)).sort((a, b) => Number(b === own) - Number(a === own)); } catch { /* unreadable */ }
    for (const p of platforms) { const bin = join(r.dir, p, "chrome-headless-shell"); if (isRunnableFile(bin)) return bin; }
  }
  return undefined;
}

/** The executable sits inside a macOS app bundle (Google Chrome.app, Chromium.app), itself or through a link. */
export function insideAppBundle(file: string): boolean {
  let real = file;
  try { real = realpathSync(file); } catch { /* the path as given */ }
  return [file, real].some(p => /\.app(\/|$)/i.test(p));
}

export const TOUR_BROWSER_GUIDANCE = "Check the installed browser and this chat's sandbox on the recording host. Sova never downloads a browser or disables the sandbox to make recording work.";
export const TOUR_APP_BROWSER_REFUSAL = "This recording's browser is a Chrome app, which can't run inside the macOS sandbox. Install Chrome's headless shell (for example: npx playwright install chromium-headless-shell), or point SOVA_TOUR_BROWSER at it, then retry. Sova never downloads a browser or loosens the sandbox.";

/**
 * The recording browser the server chooses before it starts the recording child, or undefined where
 * the child finds its own (every platform but macOS). On macOS the server's own environment decides
 * (a sandboxed child's environment drops SOVA_TOUR_BROWSER and PLAYWRIGHT_BROWSERS_PATH), and with
 * the chat's sandbox on an app-bundle Chrome is refused before anything starts: it would only crash.
 */
export function chooseTourBrowser(sandboxOn: boolean, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  if (platform !== "darwin") return undefined;
  const executable = discoverTourBrowser(env, platform);
  if (sandboxOn && insideAppBundle(executable)) throw new TourBrowserSetupError(TOUR_APP_BROWSER_REFUSAL);
  return executable;
}

/** Discover installed software only. This module never invokes an installer or downloads. */
export function discoverTourBrowser(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const configured = env.SOVA_TOUR_BROWSER;
  // macOS: Chrome's headless shell ahead of any Chrome or Chromium app; elsewhere nothing changes.
  const shell = !configured && platform === "darwin" ? findMacHeadlessShell(env) : undefined;
  const candidates = configured ? [configured] : [
    ...(shell ? [shell] : []),
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
