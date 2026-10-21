// Only the user scrolls the session list (§app.session-list/content-rules, "Only the user scrolls the list";
// §app.session-list/search, Keys), in a real Chrome: the app's own build, served from a scratch build with every
// request answered here (no server, no network), with enough organization sections to scroll. A click on a row
// at the bottom, then a refresh; a session arriving above; Needs you appearing and clearing above; a section above
// opening and closing on its own; the user's own toggle; Escape out of the search; and a phone's width. Each one
// holds the list where it was: its scrollTop, the row on screen at the same place, the same row node, its focus.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { ProjectSummary } from "../shared/projects";
import type { AttentionDigest, AttentionItem, SessionSummary } from "../shared/protocol";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_SCROLL_DIST=<dir>: drive a build made elsewhere (by hand, to show a tree without the fix fails).
  dist = process.env.SOVA_SCROLL_DIST || join(scratchRoot("sova-sidebar-scroll-"), "dist");
  if (!process.env.SOVA_SCROLL_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

// ── The data: four organizations of two projects each, every project five running coding sessions (so the rows
// stand open, no Done to open), some folders above and an archive below. Everything is invented: /w/… paths.
const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();
const ORGS = ["Acme", "Globex", "Initech", "Rakiba"];

function row(id: string, cwd: string, title: string, minAgo: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    path: `/w/sessions/${id}.jsonl`,
    cwd,
    title,
    createdAt: iso(minAgo + 60),
    lastActiveAt: iso(minAgo),
    model: "mock/m1",
    context: { tokens: 1, window: 100_000 },
    live: null,
    origin: "web",
    archived: false,
    busy: false,
    ...extra,
  } as SessionSummary;
}

interface World {
  sessions: SessionSummary[];
  projects: ProjectSummary[];
  attention: AttentionDigest;
}

function world(): World {
  const sessions: SessionSummary[] = [];
  const projects: ProjectSummary[] = [];
  for (let f = 0; f < 4; f++) for (let i = 0; i < 2; i++) sessions.push(row(`f${f}-${i}`, `/w/folders/folder-${f}`, `Folder ${f} task ${i}`, 300 + f * 10 + i));
  for (let a = 0; a < 6; a++) sessions.push(row(`a${a}`, `/w/old/old-${a % 2}`, `Old work ${a}`, 60 * 24 * 40 + a, { origin: "external" }));
  ORGS.forEach((name, oi) => {
    const orgId = `org_${name.toLowerCase()}`;
    for (let p = 0; p < 2; p++) {
      const projectId = `prj_${name.toLowerCase()}${p}`;
      const projectName = `${name}${p === 0 ? "Designs" : "Shop"}`;
      const root = `/w/projects/${name.toLowerCase()}-${p}`;
      projects.push({ id: projectId, name: projectName, root, origin: "folder", createdAt: iso(9999), space: { kind: "org", orgId, orgName: name } } as unknown as ProjectSummary);
      for (let i = 0; i < 5; i++) {
        sessions.push(row(`${name.toLowerCase()}${p}-${i}`, root, `${name} ${p} job ${i}`, 20 + oi * 40 + p * 15 + i, { org: { orgId, orgName: name, projectId, projectName, kind: "coding" } } as Partial<SessionSummary>));
      }
    }
  });
  return { sessions, projects, attention: { generatedAt: T0, counts: { act: 0, decide: 0, fyi: 0 }, items: [] } };
}

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

/** A page at `width` whose every request is answered from `w` (read at each request, so a test changes it between
    refreshes). */
async function open(w: World, width: number): Promise<Page> {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.routeWebSocket(/.*/, () => {
    // Accepted and silent: the list is re-read by focus here, as it is on a window's return.
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === "/api/sessions") return route.fulfill(json(w.sessions));
    if (p === "/api/projects") return route.fulfill(json({ projects: w.projects }));
    if (p === "/api/orgs") return route.fulfill(json({ operator: { name: "Operator" }, orgs: ORGS.map((name) => ({ id: `org_${name.toLowerCase()}`, name, slug: name.toLowerCase(), createdAt: iso(9999), people: 0, projects: 2, openBatons: 0 })) }));
    if (p === "/api/overseer/attention") return route.fulfill(json(w.attention));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/session-groups") return route.fulfill(json([]));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/`);
  assert.equal(await page.evaluate(() => innerWidth), width);
  await page.locator(".sidebar-list .org-section a.session-row").first().waitFor({ timeout: 20_000 });
  return page;
}

/** The list re-read, as when the window comes back into focus, and given time to land and settle. */
async function refresh(page: Page, landed: () => Promise<boolean>) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const t0 = Date.now();
  while (!(await landed())) {
    assert.ok(Date.now() - t0 < 10_000, "the refresh never landed");
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(400);
}

/** Scrolls the list to its end and marks the last row fully on screen in the given org's section. */
async function bottomRowOf(page: Page, org: string) {
  await page.locator(".sidebar-list").evaluate((l) => (l.scrollTop = l.scrollHeight));
  await page.waitForTimeout(300);
  const ok = await page.evaluate((org) => {
    const l = document.querySelector(".sidebar-list")!;
    const lr = l.getBoundingClientRect();
    const sec = [...l.querySelectorAll(".org-section")].find((d) => d.querySelector(".group-name")?.textContent?.includes(org));
    const rows = [...(sec?.querySelectorAll("a.session-row") ?? [])].filter((a) => {
      const r = a.getBoundingClientRect();
      return r.top >= lr.top && r.bottom <= lr.bottom;
    });
    rows.at(-1)?.setAttribute("data-probe", "1");
    return rows.length > 0 && l.scrollTop > 500;
  }, org);
  assert.ok(ok, `the list scrolls and a ${org} row is on screen at its end`);
}

/** Where things are: the list's scrollTop, the marked row's top (null once that node is gone), its focus. */
const reading = (page: Page) =>
  page.evaluate(() => {
    const l = document.querySelector(".sidebar-list")!;
    const a = document.querySelector("[data-probe]");
    return { scrollTop: Math.round(l.scrollTop), rowTop: a ? Math.round(a.getBoundingClientRect().top) : null, focused: !!a && document.activeElement === a };
  });

/** What the user sees: the marked row at the same place (null if its node was replaced), and its focus. scrollTop is
    left out: content arriving or leaving above has to move it by exactly its height for the row to stay put. */
const onScreen = async (page: Page) => {
  const { rowTop, focused } = await reading(page);
  return { rowTop, focused };
};

const titled = (page: Page, text: string) => async () => (await page.locator(".sidebar-list").getByText(text, { exact: true }).count()) > 0;

test("a click on an org's row at the bottom, then a refresh: the list holds still and the row keeps its node and focus", async () => {
  const w = world();
  const page = await open(w, 1280);
  await bottomRowOf(page, "Rakiba");
  await page.locator("[data-probe]").click();
  await page.waitForTimeout(600);
  const before = await reading(page);
  assert.equal(before.focused, true, "the clicked row has focus");
  // A session in the first org moves: its title changes, and the whole list is a fresh array of fresh objects.
  w.sessions = w.sessions.map((s) => (s.id === "acme0-0" ? { ...s, title: "Acme renamed" } : { ...s }));
  await refresh(page, titled(page, "Acme renamed"));
  assert.deepEqual(await reading(page), before);
  await page.context().close();
});

test("a session arriving above, then going away: the rows on screen hold still", async () => {
  const w = world();
  const page = await open(w, 1280);
  await bottomRowOf(page, "Rakiba");
  const before = await onScreen(page);
  // Newest of all: it leads Recent and adds a folder to Folders, both above.
  w.sessions = [...w.sessions, row("new-1", "/w/folders/folder-new", "Brand new session", 0)];
  await refresh(page, titled(page, "Brand new session"));
  assert.deepEqual(await onScreen(page), before);
  w.sessions = w.sessions.filter((s) => s.id !== "new-1");
  await refresh(page, async () => !(await titled(page, "Brand new session")()));
  assert.deepEqual(await onScreen(page), before);
  await page.context().close();
});

test("Needs you appearing and clearing above: the rows on screen hold still", async () => {
  const w = world();
  const page = await open(w, 1280);
  await bottomRowOf(page, "Rakiba");
  const before = await onScreen(page);
  const s = w.sessions.find((x) => x.id === "f0-0")!;
  const item: AttentionItem = { id: s.id, path: s.path, title: s.title, where: s.cwd, tier: "act", kind: "error", since: T0, detail: "The last turn stopped with an error.", href: `#/s/${encodeURIComponent(s.path)}` };
  w.attention = { generatedAt: T0, counts: { act: 1, decide: 0, fyi: 0 }, items: [item] };
  await refresh(page, async () => (await page.locator(".sidebar-needs-you").count()) > 0);
  assert.deepEqual(await onScreen(page), before);
  w.attention = { generatedAt: T0, counts: { act: 0, decide: 0, fyi: 0 }, items: [] };
  await refresh(page, async () => (await page.locator(".sidebar-needs-you").count()) === 0);
  assert.deepEqual(await onScreen(page), before);
  await page.context().close();
});

test("a section above opening and closing on its own (the open session moving into it and out): the rows on screen hold still", async () => {
  const w = world();
  const page = await open(w, 1280);
  // The user folds Acme, at the top of the region.
  await page.locator(".org-section", { hasText: "Acme" }).locator(":scope > summary").click();
  await page.waitForFunction(() => ![...document.querySelectorAll<HTMLDetailsElement>(".org-section")].find((d) => d.textContent?.includes("Acme"))?.open);
  await bottomRowOf(page, "Rakiba");
  const before = await onScreen(page);
  // A link elsewhere opens an Acme session: its section opens for it.
  const acme = w.sessions.find((x) => x.id === "acme1-2")!;
  await page.evaluate((p) => (location.hash = `#/s/${encodeURIComponent(p)}`), acme.path);
  await page.waitForFunction(() => !![...document.querySelectorAll<HTMLDetailsElement>(".org-section")].find((d) => d.textContent?.includes("Acme"))?.open);
  await page.waitForTimeout(400);
  assert.deepEqual(await onScreen(page), before, "opened above");
  // Off to an Initech session: Acme goes back to the user's fold.
  const initech = w.sessions.find((x) => x.id === "initech0-0")!;
  await page.evaluate((p) => (location.hash = `#/s/${encodeURIComponent(p)}`), initech.path);
  await page.waitForFunction(() => ![...document.querySelectorAll<HTMLDetailsElement>(".org-section")].find((d) => d.textContent?.includes("Acme"))?.open);
  await page.waitForTimeout(400);
  assert.deepEqual(await onScreen(page), before, "closed above");
  await page.context().close();
});

test("the user folding a section: the head they pressed holds still", async () => {
  const w = world();
  const page = await open(w, 1280);
  // Globex's head 200px down the list, with Initech and Rakiba below it: enough list left that folding it needs no clamp.
  const head = page.locator(".org-section", { hasText: "Globex" }).locator(":scope > summary");
  await head.evaluate((h) => {
    const l = document.querySelector(".sidebar-list")!;
    l.scrollTop += h.getBoundingClientRect().top - l.getBoundingClientRect().top - 200;
  });
  await page.waitForTimeout(300);
  const at = async () => Math.round((await head.boundingBox())!.y);
  const y = await at();
  assert.ok((await page.locator(".sidebar-list").evaluate((l) => l.scrollTop)) > 300, "scrolled");
  await head.click();
  await page.waitForTimeout(400);
  assert.equal(await at(), y, "folded");
  await head.click();
  await page.waitForTimeout(400);
  assert.equal(await at(), y, "unfolded");
  await page.context().close();
});

test("Escape out of the search: the list stays where it was, and focus lands on a row on screen", async () => {
  const w = world();
  const page = await open(w, 1280);
  // The open session sits at the very end of the list, off screen once the list is back at its top.
  await bottomRowOf(page, "Rakiba");
  await page.locator("[data-probe]").click();
  await page.locator(".sidebar-list").evaluate((l) => (l.scrollTop = 200));
  await page.waitForTimeout(300);
  const field = page.locator(".sidebar-toolbar input");
  await field.click();
  await field.fill("job");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  assert.equal(await field.inputValue(), "", "the first Esc clears");
  const before = await reading(page);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  assert.equal((await reading(page)).scrollTop, before.scrollTop, "the second Esc leaves the list where it was");
  const onScreen = await page.evaluate(() => {
    const a = document.activeElement;
    const l = document.querySelector(".sidebar-list")!.getBoundingClientRect();
    if (!a?.matches("a.session-row")) return false;
    const r = a.getBoundingClientRect();
    return r.bottom > l.top && r.top < l.bottom;
  });
  assert.equal(onScreen, true, "focus is on a row on screen");
  await page.context().close();
});

test("390px phone: a refresh and a session arriving above hold the list still", async () => {
  const w = world();
  const page = await open(w, 390);
  await bottomRowOf(page, "Rakiba");
  const before = await onScreen(page);
  w.sessions = [...w.sessions.map((s) => (s.id === "acme0-0" ? { ...s, title: "Acme renamed" } : { ...s })), row("new-2", "/w/folders/folder-new", "Brand new session", 0)];
  await refresh(page, titled(page, "Brand new session"));
  assert.deepEqual(await onScreen(page), before);
  await page.context().close();
});
