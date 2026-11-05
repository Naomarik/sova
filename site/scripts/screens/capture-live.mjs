#!/usr/bin/env node
// Screenshots of a RUNNING Sova (by default the live one on 127.0.0.1:4800), for what demo data
// can't stage well: the merge queue with real branches in it, a run's steps, releases, settings.
//
// Read-only by construction: every request the page makes goes through a guard that lets GETs
// and the project-services read verbs (*.status, *.logs) through and aborts everything else;
// clicks are only the ones a shot lists, and a click whose label reads as an action (Land,
// Publish, Apply, Save, Retry, Cancel, Hold, Restart, ...) is refused before it happens.
//
// Masking lives in one place, MASK below, and runs in the page before every shot; then the leak
// gate (harness.mjs's, plus this server's other projects' names and folders, read at run time
// and never stored) refuses the shot if anything private still shows. See README.md, "Live shots".
//
//   node scripts/screens/capture-live.mjs                 every shot
//   node scripts/screens/capture-live.mjs --shot merge-queue-tab --shot releases-tab
//   node scripts/screens/capture-live.mjs --explore '#/projects/{project}/merge-queue'
//                                                         print a page's buttons, links and text
//   --base http://127.0.0.1:4810   another server (a hermetic copy: pnpm run dev:hermetic)
//   --agent-dir <dir>              that server's agent dir (its token and cookie name; default ~/.pi/agent)
//   --base <copy> runs the shots marked copy: true (and the port-4800 server the others); --shot picks any.
//   --project sova                 the project whose pages are shot (by name, or its prj_ id)
//   --png                          also keep each shot's PNG beside the WebP (in the debug dir)
//   --light                        the light theme instead of dark

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { leakPatterns, leakGate, FREEZE_CSS, siteSharp, DEBUG_DIR } from "./harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const OUT_DIR = join(REPO, "site", "src", "assets", "screens", "live");
const MANIFEST = join(OUT_DIR, "manifest.json");

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const opts = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const flag = (name) => args.includes(name);
const BASE = opt("--base", "http://127.0.0.1:4800").replace(/\/$/, "");
const AGENT_DIR = resolve(opt("--agent-dir", join(homedir(), ".pi", "agent")));
const PROJECT = opt("--project", "sova");
const THEME = flag("--light") ? "light" : "dark";

// ---- the shots --------------------------------------------------------------------------------
// route: the page's hash ({project} is the project's id, {run} the run the queue is checking or
// last ran). steps: read-only moves before the shot, each one of
//   { click: "<visible text>" | { css: "<selector>" } }  (refused when it reads as an action)
//   { scroll: "<selector>" } (to the top of its scroller; any Playwright selector, text=... too)  { wait: <ms> }  { waitFor: "<css>" }
// clip: a CSS selector (or several: the box around the first match of each) to cut the shot to,
// padded by pad (CSS px, default 16); none for the whole viewport.
// tall: a viewport height for this shot (CSS px), for a long page.
const SHOTS = [
  {
    id: "merge-queue-tab",
    alt: "A project's Merge Queue tab: master and origin in step, the queue running with its merge thread idle, one branch being checked with its plain-words summary, and the branches queued behind it.",
    route: "#/projects/{project}/merge-queue",
    tall: 1400,
  },
  {
    id: "merge-queue-run",
    alt: "One merge-queue run: the branch merged onto the newest master in its own copy, each check with its state and time, and the steps still to come.",
    route: "#/projects/{project}/merge-queue",
    // The run being checked now (a link: it opens the run's page, nothing more).
    steps: [{ click: { css: '.mq-card[aria-label="Checking now"] a[href*="/merge-queue/"]' } }, { wait: 2500 }],
    tall: 1300,
  },
  {
    id: "landing-progress",
    alt: "Landing progress, branch by branch: the branch being checked with its plain-words summary, the check it is on and a progress bar, and the next branch in line with when it starts.",
    route: "#/projects/{project}/merge-queue",
    tall: 2400,
    clip: ['.mq-card[aria-label="Checking now"]', ".mq-list > li"],
  },
  {
    id: "releases-tab",
    alt: "A project's Releases tab: the latest release and the landings since, Release Note and Start Release, and the history of published releases, the newest with its notes open.",
    route: "#/projects/{project}/releases",
    tall: 1500,
    steps: [{ click: { css: 'text="Notes"' } }],
  },
  {
    id: "settings-merge-queue",
    alt: "Settings, Merge Queue, for one project: how a branch lands (merged locally, a pull request on GitHub, a merge request on GitLab, or the branch pushed only), each value marked with where it comes from.",
    route: "#/settings/merge-queue/{project}",
    tall: 1300,
    clip: ".settings-modal",
    pad: 0,
  },
  {
    id: "settings-merge-queue-checks",
    alt: "Settings, Merge Queue, further down: the checks every landing runs (Typecheck, Unit tests, Integration and more), which rerun their failed files, setup before the checks, and the review of each landing.",
    route: "#/settings/merge-queue/{project}",
    tall: 1300,
    steps: [{ scroll: "text=/^Checks\\b/" }, { wait: 500 }],
    clip: ".settings-modal",
    pad: 0,
  },
  // On a test copy seeded by scripts/e2e-release/seed-demo.ts (README.md, "Live shots"): no
  // release is open on the live server most of the time.
  {
    id: "release-in-progress",
    copy: true,
    project: "acme-app",
    alt: "A release in progress, step by step: the version, notes and release commit done, the gating checks passed, Try it on the staging copy held for you with Continue, a failed smoke test with Retry Step, a check still running, and Publish waiting its turn.",
    route: "#/projects/{project}/releases",
    tall: 1800,
    clip: ".rel-card",
  },
];

// ---- masking: the one place -------------------------------------------------------------------
// hide: removed from the page (not just hidden: the leak gate reads attributes too). blur: kept in place, unreadable. text: replacements made in every
// text node and in title/aria-label/placeholder/value (strings, or [regex, replacement]);
// otherProjects (added at run time) become "Another project", their folders "~/code/another".
const MASK = {
  hide: [
    // The sidebar starts collapsed to its spine (this browser's own setting, sova:sidebar-collapsed);
    // its lists hold every session and project on this machine.
    ".app-sidebar .list-row, .app-sidebar .ny-link, .app-sidebar [class*=list]",
    ".spine-tile",             // the spine's running chats, by title and folder
    ".toast, .toasts",
  ],
  blur: [],
  text: [
    // A chat's auto title from old work, shown as the merge thread's session name.
    ["UniiChat", "Merge thread"],
    // Any home folder, this machine's or another computer's in the mesh.
    [/\/(?:home|Users)\/[^/\s"']+/g, "~"],
    ["~/webapps/", "~/code/"],
    // Every email (the usage meter's account names).
    [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "you@example.com"],
    // A test copy's push hold until its private names are set up: it names the copy's own state
    // folder, and no set-up project shows it.
    [/Not ready to publish: pushes are held until this project's private names are set up \([^)]*\)\.?/g, ""],
    [/;?\s*pushes are held until this project's private names are set up \([^)]*\)/g, ""],
    // Money spent, on the project header.
    [/\$\d[\d,]*\.\d\d\b/g, "$—"],
  ],
};

// Words a click must never be: anything that could change the server's state.
const FORBIDDEN_CLICK = /\b(land|publish|apply|save|retry|cancel|hold|restart|reload|pause|resume|remove|delete|archive|start|stop|run|send|confirm|merge|withdraw|continue|try|fresh|clear|reset|update|upgrade|approve|discard|undo|add|set up|check now)\b/i;

// ---- run --------------------------------------------------------------------------------------

const PW_DIR = process.env.PLAYWRIGHT_DIR ?? join(REPO, ".claude", "skills", "playwright", "scripts");
const { chromium } = createRequire(join(PW_DIR, "package.json"))("playwright");
const token = readFileSync(join(AGENT_DIR, "sova", "auth-token"), "utf8").trim();
const cookieName = `sova_token_${createHash("sha256").update(AGENT_DIR).digest("hex").slice(0, 8)}`;
const api = async (path, init) => {
  const r = await fetch(BASE + path, { ...init, headers: { "x-sova-token": token, "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
};

const projects = (await api("/api/projects")).projects;
const tilde = (path) => (path.startsWith(homedir() + "/") ? "~" + path.slice(homedir().length) : path);
const asRule = ([from, to]) => (typeof from === "string" ? { s: from, to } : { re: from.source, flags: from.flags.includes("g") ? from.flags : from.flags + "g", to });

/** One project's page: the project (by prj_ id, else by name, the newest of that name), the leak
    patterns (every other project's name, folder and org, held in memory only) and the text rules. */
function scope(ref) {
  const named = projects.filter((p) => (p.id === ref || p.name === ref) && !p.archived);
  const project = named.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))[0];
  if (!project) throw new Error(`no project ${ref} on ${BASE}`);
  // A seeded copy may hold two projects of one name: those keep the name and lose the folder.
  const others = projects.filter((p) => p.id !== project.id).map((p) => (p.name === project.name ? { ...p, name: "" } : p));
  const patterns = leakPatterns(null);
  for (const p of others) {
    if (p.name.length >= 3) patterns.lits.push({ v: p.name, what: "another project's name" });
    if (p.root) patterns.lits.push({ v: p.root, what: "another project's folder" }, { v: tilde(p.root), what: "another project's folder" });
    if (p.space?.orgName) patterns.lits.push({ v: p.space.orgName, what: "an organization's name" });
  }
  patterns.res.push([/[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/, "an email address"]);
  const textRules = [
    ...others.flatMap((p) => [...(p.root ? [[p.root, "~/code/another"], [tilde(p.root), "~/code/another"]] : []), ...(p.name.length >= 3 ? [[p.name, "Another project"]] : []), ...(p.space?.orgName ? [[p.space.orgName, "An org"]] : [])]),
    [project.root, `~/code/${project.name}`],
    [tilde(project.root), `~/code/${project.name}`],
    [homedir(), "~"],
    ...MASK.text,
  ].map(asRule);
  return { project, patterns, textRules };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: THEME, reducedMotion: "reduce" });
const host = new URL(BASE).hostname;
await ctx.addCookies([{ name: cookieName, value: token, domain: host, path: "/", httpOnly: true }]);
const blocked = [];
await ctx.route("**/*", (r) => {
  const req = r.request();
  const u = new URL(req.url());
  const ok = req.method() === "GET" || req.method() === "HEAD" || (u.pathname.startsWith("/api/project-services/") && /\.(status|logs)$/.test(u.pathname));
  if (ok) return r.continue();
  blocked.push(`${req.method()} ${u.pathname}`);
  return r.abort();
});
await ctx.addInitScript(([theme]) => { try { localStorage.setItem("sova-theme", theme); localStorage.setItem("sova:sidebar-collapsed", "1"); } catch {} }, [THEME]);

async function mask(page, textRules) {
  await page.addStyleTag({ content: `${FREEZE_CSS} ${MASK.hide.join(", ")} { display: none !important; } ${MASK.blur.length ? `${MASK.blur.join(", ")} { filter: blur(6px) !important; }` : ""}` });
  // Applied now and again on every change (the page keeps updating from the live server).
  await page.evaluate(([rules, hide]) => {
    const apply = (t) => {
      for (const r of rules) t = r.s ? t.split(r.s).join(r.to) : t.replace(new RegExp(r.re, r.flags), r.to);
      return t;
    };
    const run = () => {
      for (const sel of hide) for (const el of document.querySelectorAll(sel)) el.remove();
      // Session links carry the session file's full path; nothing in a still follows them.
      for (const a of document.querySelectorAll("a[href^='#/s/']")) if (a.getAttribute("href") !== "#/s/session") a.setAttribute("href", "#/s/session");
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = walk.nextNode()); ) { const v = apply(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
      for (const el of document.querySelectorAll("*")) {
        for (const a of ["title", "aria-label", "placeholder", "alt", "href", "data-path", "data-tip"]) { const v = el.getAttribute(a); if (v) { const w = apply(v); if (w !== v) el.setAttribute(a, w); } }
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) { const w = apply(el.value); if (w !== el.value) el.value = w; }
      }
    };
    run();
    let queued = false;
    new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; run(); }); } })
      .observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, [textRules, MASK.hide]);
}

async function step(page, s) {
  if (s.wait) return page.waitForTimeout(s.wait);
  if (s.waitFor) return page.waitForSelector(s.waitFor, { timeout: 15_000 });
  if (s.scroll) return page.locator(s.scroll).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
  if (s.click) {
    const loc = typeof s.click === "string" ? page.getByRole("button", { name: s.click, exact: true }).or(page.getByRole("tab", { name: s.click, exact: true })).first() : page.locator(s.click.css).first();
    const label = (await loc.innerText().catch(() => "")) || (await loc.getAttribute("aria-label")) || "";
    if (FORBIDDEN_CLICK.test(label) && !s.allow) throw new Error(`refusing to click "${label.trim()}": it reads as an action`);
    await loc.click({ timeout: 10_000 });
    return page.waitForTimeout(800);
  }
  throw new Error(`unknown step ${JSON.stringify(s)}`);
}

async function open(route, project, height = 900) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height });
  await page.goto(`${BASE}/${route.replace("{project}", project.id)}`);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return page;
}

if (opt("--explore")) {
  const sc = scope(PROJECT);
  const page = await open(opt("--explore"), sc.project, Number(opt("--tall", 1400)));
  await mask(page, sc.textRules);
  console.log(await page.evaluate(() => [
    "BUTTONS: " + [...document.querySelectorAll("button,[role=tab]")].map((b) => b.innerText.trim() || b.getAttribute("aria-label")).filter(Boolean).join(" | "),
    "LINKS: " + [...document.querySelectorAll("a[href^='#']")].map((a) => `${a.innerText.trim().slice(0, 40)} -> ${a.getAttribute("href")}`).join(" | "),
    "TEXT:\n" + document.querySelector("main, .app-main, body").innerText.slice(0, 6000),
  ].join("\n")));
  if (opt("--to")) await page.screenshot({ path: opt("--to") });
  await browser.close();
  process.exit(0);
}

const wanted = opts("--shot");
for (const w of wanted) if (!SHOTS.some((s) => s.id === w)) throw new Error(`no shot ${w}; shots: ${SHOTS.map((s) => s.id).join(", ")}`);
// The live server (port 4800) takes the live shots; any other server, the shots marked copy: true.
const LIVE = new URL(BASE).port === "4800";
const todo = SHOTS.filter((s) => (wanted.length ? wanted.includes(s.id) : !!s.copy !== LIVE));
mkdirSync(OUT_DIR, { recursive: true });
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { shots: {} };
manifest._generated = "by site/scripts/screens/capture-live.mjs; edit its SHOTS instead";
// sharp from this site's install, or (SITE_INSTALL_DIR) another checkout's installed site/.
const sharp = process.env.SITE_INSTALL_DIR
  ? createRequire(createRequire(join(process.env.SITE_INSTALL_DIR, "package.json")).resolve("astro/package.json"))("sharp")
  : siteSharp();
let failed = 0;
for (const shot of todo) {
  const { project, patterns, textRules } = scope(shot.project ?? PROJECT);
  const page = await open(shot.route, project, shot.tall ?? 900);
  try {
    for (const s of shot.steps ?? []) await step(page, s);
    await mask(page, textRules);
    await page.waitForTimeout(300);
    await leakGate(page, patterns, shot.id).catch(async (e) => {
      // Where each hit is, for whoever runs this (printed, never written).
      if (flag("--why")) console.error(await page.evaluate((needles) => {
        const out = [];
        for (const el of document.querySelectorAll("*")) {
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("");
          const attrs = ["title", "aria-label", "alt", "placeholder", "href", "src", "value", "data-path"].map((a) => el.getAttribute(a) ?? "").join(" ");
          for (const n of needles) if ((own + " " + attrs).toLowerCase().includes(n.toLowerCase())) out.push(`${el.tagName}.${el.className}: ${(own + " " + attrs).trim().slice(0, 120)}`);
        }
        if (/[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/.test(document.body.innerHTML)) out.push("email in: " + (document.body.innerHTML.match(/.{0,60}[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+.{0,20}/) ?? [""])[0]);
        return out.slice(0, 30).join("\n");
      }, patterns.lits.map((l) => l.v)));
      throw e;
    });
    let clip;
    if (shot.clip) {
      const boxes = [];
      for (const sel of [shot.clip].flat()) {
        const box = await page.locator(sel).first().boundingBox();
        if (!box) throw new Error(`${sel}: not on the page`);
        boxes.push(box);
      }
      const pad = shot.pad ?? 16;
      const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad), y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
      clip = { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) + pad - x, height: Math.max(...boxes.map((b) => b.y + b.height)) + pad - y };
    }
    const png = await page.screenshot({ clip, animations: "disabled" });
    if (flag("--png")) { mkdirSync(DEBUG_DIR, { recursive: true }); writeFileSync(join(DEBUG_DIR, `${shot.id}.png`), png); }
    const img = sharp(png);
    const meta = await img.metadata();
    const webp = await img.webp({ lossless: true, effort: 6 }).toBuffer();
    const file = `${shot.id}.webp`;
    writeFileSync(join(OUT_DIR, file), webp);
    manifest.shots[shot.id] = { file, width: meta.width, height: meta.height, theme: THEME, alt: shot.alt, source: LIVE ? "live" : "copy", taken: new Date().toISOString().slice(0, 10), bytes: webp.length };
    console.log(`${shot.id}: ${meta.width}x${meta.height}, ${Math.round(webp.length / 1024)} KB`);
  } catch (e) {
    failed++;
    console.error(`${shot.id}: ${e.message}`);
  } finally {
    await page.close();
  }
}
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
if (blocked.length) console.log(`the guard stopped ${blocked.length} request(s), none reached the server: ${[...new Set(blocked)].join(", ")}`);
await browser.close();
process.exit(failed ? 1 : 0);
