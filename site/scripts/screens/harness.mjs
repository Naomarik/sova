// What capture.mjs and record.mjs share: the throwaway root, free ports, the director and the Sova
// server as child processes (each stopped on exit), the playwright skill's browser, and the leak
// gate. Everything here starts only what it stops.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { hostname, homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { HERE, REPO, SITE } from "./load-story.mjs";

/** The run's own token, pinned on the server with SOVA_TOKEN and sent by every client. */
export const TOKEN = randomBytes(32).toString("base64url");
export const tokenHeaders = () => ({ "x-sova-token": TOKEN, "content-type": "application/json" });

/** The agent dir: pi's own place under the root's HOME, because the web app reads home from a
    session file's path (`<home>/.pi/agent/sessions/…`) and shows every path under it as ~/…. */
export const agentDirOf = (root) => join(root, "home", ".pi", "agent");

/** A fresh root outside the repository: <root>/home is HOME, <root>/home/.pi/agent the agent dir. */
export function makeRoot() {
  const base = realpathSync(tmpdir());
  if (base === REPO || base.startsWith(`${REPO}/`)) throw new Error(`the temp dir ${base} is inside the repository; set TMPDIR elsewhere`);
  const root = mkdtempSync(join(base, "sova-screens-"));
  for (const d of ["home", "tmp", "logs"]) mkdirSync(join(root, d), { recursive: true });
  mkdirSync(agentDirOf(root), { recursive: true });
  return root;
}

export function removeRoot(root) {
  if (root && root.startsWith(realpathSync(tmpdir())) && root.includes("sova-screens-")) rmSync(root, { recursive: true, force: true });
}

export async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

const children = new Set();
function killAll() {
  for (const c of children) {
    try { process.kill(-c.pid, "SIGTERM"); } catch {}
  }
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(sig, () => {
    killAll();
    process.exit(130);
  });
process.once("exit", killAll);

/** Start a child in its own process group, output to a log file; returns { proc, stop }. */
export function startChild(cmd, args, { env, cwd, log }) {
  const out = openSync(log, "a");
  const proc = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
  children.add(proc);
  proc.once("exit", () => children.delete(proc));
  const stop = async () => {
    if (proc.exitCode !== null || proc.signalCode) return;
    try { process.kill(-proc.pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 40 && proc.exitCode === null && !proc.signalCode; i++) await sleep(100);
    try { process.kill(-proc.pid, "SIGKILL"); } catch {}
  };
  return { proc, stop };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment every child runs in: the root's own home, nothing from the real ~/.pi. */
export function rootEnv(root, extra = {}) {
  const home = join(root, "home");
  return {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    TZ: "UTC",
    NO_COLOR: "1",
    HOME: home,
    USER: "demo",
    LOGNAME: "demo",
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    GIT_CONFIG_NOSYSTEM: "1",
    SOVA_MODELS_FETCH: "off",
    ...extra,
  };
}

/** The bun binary start-server.sh would pick, resolved with the real environment (a mise shim
    can't find its config once HOME points at the root). null: run the server on Node. */
export function resolveBun() {
  if (process.env.SOVA_BUN) return process.env.SOVA_BUN;
  try {
    const out = execFileSync(process.execPath, [join(REPO, "server", "runtime-choice.ts"), "launch"], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n");
    if (out[0] === "bun" && out[1]) {
      try {
        return execFileSync("mise", ["which", "bun"], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || out[1];
      } catch {
        return out[1];
      }
    }
  } catch {}
  return null;
}

export async function waitFor(fn, { timeout = 30_000, every = 200, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

/** Start the director on a free port; returns { port, url, stop, api }. */
export async function startDirector(root, { chunkMs, gated = true, storyFile } = {}) {
  const port = await freePort();
  const args = [join(HERE, "director.mjs"), "--port", String(port), "--root", root, "--chunk", String(chunkMs ?? 6), ...(gated ? [] : ["--no-gates"]), ...(storyFile ? ["--story", storyFile] : [])];
  const child = startChild(process.execPath, args, { env: rootEnv(root), cwd: HERE, log: join(root, "logs", "director.log") });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${url}/state`).then((r) => r.ok), { what: "the director", timeout: 15_000 });
  const api = {
    state: () => fetch(`${url}/state`).then((r) => r.json()),
    release: (hold) => fetch(`${url}/release/${hold}`, { method: "POST" }).then((r) => r.json()),
    reached: async (hold, timeout = 120_000) => {
      const r = await fetch(`${url}/wait/${hold}?timeout=${timeout}`);
      const j = await r.json();
      if (!j.reached) throw new Error(`hold "${hold}" was not reached in ${timeout / 1000}s. Director state: ${JSON.stringify(await api.state())}`);
      return j;
    },
    idle: async (scene, timeout = 120_000) => {
      const r = await fetch(`${url}/idle/${scene}?timeout=${timeout}`);
      const j = await r.json();
      if (!j.done) throw new Error(`scene "${scene}" did not finish in ${timeout / 1000}s. Director state: ${JSON.stringify(await api.state())}`);
      return j;
    },
    pace: (chunk) => fetch(`${url}/pace`, { method: "POST", body: JSON.stringify({ chunk }) }),
  };
  return { port, url, stop: child.stop, api };
}

/** Start the Sova server on the seeded root; returns { port, base, stop, call }. */
export async function startServer(root, { node = false } = {}) {
  const port = await freePort();
  const bun = node ? null : resolveBun();
  const env = rootEnv(root, { PORT: String(port), PI_CODING_AGENT_DIR: agentDirOf(root), SOVA_TOKEN: TOKEN, ...(bun ? { SOVA_BUN: bun } : { SOVA_RUNTIME: "node" }) });
  const child = startChild(join(REPO, "scripts", "start-server.sh"), bun ? [] : ["--node"], { env, cwd: REPO, log: join(root, "logs", "server.log") });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(() => fetch(`${base}/api/health`).then((r) => r.ok), { what: `the Sova server (log: ${join(root, "logs", "server.log")})`, timeout: 60_000 });
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: tokenHeaders(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const t = await r.text();
    let j;
    try { j = JSON.parse(t); } catch { j = t; }
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${typeof j === "string" ? j : JSON.stringify(j)}`);
    return j;
  };
  return { port, base, stop: child.stop, call };
}

// ---- the browser ------------------------------------------------------------------------------

const SKILL = resolve(REPO, ".claude/skills/playwright/scripts");

/** The playwright skill's isolated browser (start-browser.sh), and playwright from its own
    node_modules, refused when that resolves outside this worktree. */
export async function startBrowser() {
  for (const p of [SKILL, join(SKILL, "node_modules")]) {
    if (!existsSync(p)) throw new Error(`${p} is missing: install the playwright skill's packages (CLAUDE.md: Playwright in a fresh worktree)`);
    const real = realpathSync(p);
    if (real !== REPO && !real.startsWith(`${REPO}/`)) throw new Error(`${p} resolves to ${real}, outside ${REPO}: refusing to use it`);
  }
  let out;
  try {
    out = execFileSync(join(SKILL, "start-browser.sh"), ["--headless"], { cwd: SKILL, stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    throw new Error(`the playwright skill's start-browser.sh failed (exit ${e.status}):\n${String(e.stdout ?? "")}${String(e.stderr ?? "")}`.trim());
  }
  const port = /PW_PORT=(\d+)/.exec(out)?.[1];
  if (!port) throw new Error(`start-browser.sh printed no PW_PORT:\n${out}`);
  const { chromium } = createRequire(join(SKILL, "package.json"))("playwright");
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return {
    browser,
    port,
    stop: async () => {
      try { await browser.close(); } catch {}
      try { execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: port }, stdio: "ignore" }); } catch {}
    },
  };
}

/** A story viewport (story.json `viewports`) as Playwright's context options. */
export const contextOptions = (vp) => ({
  viewport: { width: vp.width, height: vp.height },
  deviceScaleFactor: vp.scale,
  isMobile: !!vp.mobile,
  hasTouch: !!vp.mobile,
  colorScheme: "dark",
  timezoneId: "UTC",
  locale: "en-US",
});

/**
 * The app's controls the capture and the video use, each found in the state the page is in, never
 * the state a previous step left it in. The composer and Review Changes are the open session's
 * (inside <main>): the session detail pane beside it can hold its own. The pane opens on whichever
 * tab it last showed, so the Agents tab is selected by its own button, not assumed.
 * `moveTo` moves the video's pointer to a control before it is clicked (a no-op for screenshots).
 */
export const ui = {
  composer: (page) => page.locator("main textarea.composer-input").first(),
  send: (page) => page.locator("main .composer-actions button[type=submit]").first(),
  reviewChanges: (page) => page.locator("main").getByRole("button", { name: "Review Changes" }).last(),
  /** Back to the end of the transcript when Jump to Latest shows (it covers what is under it). */
  async toLatest(page, moveTo = async () => {}) {
    const pill = page.locator("main .jump-latest[data-shown]").first();
    if (await pill.isVisible().catch(() => false)) {
      await moveTo(pill);
      await pill.click();
      await page.waitForTimeout(600);
    }
  },
  async openAgents(page, moveTo = async () => {}) {
    const panel = page.locator("#session-tabpanel");
    if (!(await panel.isVisible().catch(() => false))) {
      const trigger = page.locator("main button.run-status-link:not(.run-status-align):not(.run-status-running)").first();
      await moveTo(trigger);
      await trigger.click({ timeout: 10_000 });
      await panel.waitFor({ state: "visible", timeout: 10_000 });
    }
    const tab = page.locator("#session-tab-agents");
    if ((await tab.getAttribute("aria-selected")) !== "true") {
      await moveTo(tab);
      await tab.click({ timeout: 10_000 });
    }
    await page.locator("#session-tabpanel .subagent-row").first().waitFor({ state: "visible", timeout: 10_000 });
  },
  async openWorker(page, name, moveTo = async () => {}) {
    await ui.openAgents(page, moveTo);
    const row = page.locator("#session-tabpanel .subagent-row", { hasText: name }).first();
    await moveTo(row);
    await row.click({ timeout: 10_000 });
  },
};

/** Animations and carets off, so a shot is the same every run. */
export const FREEZE_CSS = "*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; caret-color: transparent !important; } ::-webkit-scrollbar { display: none; }";

// ---- the leak gate ----------------------------------------------------------------------------

/** What must never reach an image: this machine's home, user and host, tailnet names and
    addresses, and the capture root itself. Held in memory only. */
export function leakPatterns(root) {
  const lits = [];
  const add = (v, what) => v && v.length >= 3 && !["demo", "root", "localhost"].includes(v) && lits.push({ v, what });
  add(homedir(), "the real home directory");
  try { add(userInfo().username, "the real user name"); } catch {}
  add(hostname(), "the real host name");
  add(hostname().split(".")[0], "the real host name");
  try {
    const st = JSON.parse(execFileSync("tailscale", ["status", "--json"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString());
    const suffix = st?.MagicDNSSuffix || st?.CurrentTailnet?.MagicDNSSuffix;
    if (suffix) add(suffix, "the tailnet's name");
    if (st?.Self?.DNSName) add(st.Self.DNSName.replace(/\.$/, ""), "this machine's tailnet name");
  } catch {}
  return {
    lits,
    res: [
      [/(?<!\bexample)\.ts\.net\b/i, "a .ts.net name"],
      [/\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, "a tailnet (100.64.0.0/10) address"],
    ],
    // The root is in every session link and data attribute by design (sessions live under it);
    // what must never show is a path that the app failed to shorten to ~/…, so only the page's
    // rendered text and form fields are checked for it (a tooltip may hold the full path).
    visible: [
      ...(root ? [{ v: root, what: "the capture root (a path that should read ~/…)" }] : []),
      { v: "sova-screens-", what: "the capture root's name (a path that should read ~/…)" },
    ],
  };
}

/** Every visible string, attribute and link on the page, checked against the patterns. Throws. */
export async function leakGate(page, patterns, where) {
  const { all, visible } = await page.evaluate(() => {
    const text = [document.body.innerText];
    const seen = [document.title];
    const attrs = [location.href.replace(/#t=[^&]*/, "")];
    for (const el of document.querySelectorAll("*")) {
      for (const a of ["title", "aria-label", "alt", "placeholder"]) {
        const v = el.getAttribute(a);
        if (v) seen.push(v);
      }
      for (const a of ["href", "src", "value", "data-path"]) {
        const v = el.getAttribute(a);
        if (v) attrs.push(v);
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) text.push(el.value, el.placeholder);
    }
    return { visible: text.join("\n"), all: [...text, ...seen, ...attrs].join("\n") };
  });
  const hits = [];
  for (const { v, what } of patterns.lits) if (all.toLowerCase().includes(v.toLowerCase())) hits.push(what);
  for (const [re, what] of patterns.res) if (re.test(all)) hits.push(what);
  for (const { v, what } of patterns.visible ?? []) if (visible.includes(v)) hits.push(what);
  if (hits.length) throw new Error(`leak gate at ${where}: the page shows ${[...new Set(hits)].join(", ")}. Nothing was written.`);
}

/** Where debug output of a failed run goes: the worktree's ignored .agent/screens/. */
export const DEBUG_DIR = join(REPO, ".agent", "screens", "debug");
export const OUT_DIR = join(SITE, "src", "assets", "screens");

/**
 * What a page looked like when a run failed, for whoever fixes the story or a selector:
 * <DEBUG_DIR>/<name>.png, and <name>.txt with its route and visible text. Written only when the
 * page passes the leak gate. Returns where it went, or a reason it wrote nothing.
 */
export async function saveDebug(page, patterns, name) {
  if (!page || page.isClosed()) return "no page to save";
  try {
    await leakGate(page, patterns, "debug");
  } catch (e) {
    return `not saved: ${e.message}`;
  }
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const base = join(DEBUG_DIR, name);
    await page.screenshot({ path: `${base}.png` });
    const info = await page.evaluate(() => ({
      route: location.hash.replace(/#t=[^&]*/, ""),
      size: `${innerWidth}x${innerHeight}`,
      focused: document.activeElement?.outerHTML.slice(0, 200) ?? "",
      text: document.body.innerText,
    }));
    writeFileSync(`${base}.txt`, `route: ${info.route}\nviewport: ${info.size}\nfocused: ${info.focused}\n\n${info.text}\n`);
    return `page saved to ${base}.png and .txt`;
  } catch (e) {
    return `not saved: ${e.message}`;
  }
}
export const VIDEO_DIR = join(SITE, "public", "video");

export function writeJson(path, v) {
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
}
