// A group's guide line collapses it (§app.session-list/guide-lines), in a real Chrome: the app's own build, served from
// a scratch build with every request answered here (no server, no network). Measured, never hard-coded: each line's
// centre against its head's chevron (an org, a user group, a Done, an Archive day), an org's line one piece down past
// its projects, a folder's and a Projects-region project's edge line at the group's edge, nested lines' boxes split
// at their midpoint; then a press 5px off a line's centre collapses its group (an org, a folder, a Done, a project)
// through the head's own path, the choice holds through a refresh (a folder's in sessionStorage), and the head ends up
// in view: brought to the top when it had scrolled out, left where it was when it hadn't. At desktop and at 320px.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { ProjectSummary } from "../shared/projects";
import type { SessionGroup, SessionSummary } from "../shared/protocol";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  dist = process.env.SOVA_GUIDE_DIST || join(scratchRoot("sova-guide-lines-"), "dist");
  if (!process.env.SOVA_GUIDE_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

// ── The data, all invented (/w/… paths): a folder of 30 rows, a user group over two folders, one org of two projects
// (the first with 30 running and 30 finished coding sessions), a standalone project with 30 sessions, an archive.
const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();
const FOLDER = "/w/folders/big";
const GROUP: SessionGroup = { id: "grp_work", name: "Work", createdAt: iso(9999) };

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
}

function world(): World {
  const sessions: SessionSummary[] = [];
  for (let i = 0; i < 30; i++) sessions.push(row(`f${i}`, FOLDER, `Folder task ${i}`, 300 + i, i < 4 ? { groupId: GROUP.id } : {}));
  for (let i = 0; i < 4; i++) sessions.push(row(`g${i}`, "/w/folders/side", `Side task ${i}`, 400 + i, { groupId: GROUP.id }));
  for (let a = 0; a < 6; a++) sessions.push(row(`a${a}`, `/w/old/old-${a % 2}`, `Old work ${a}`, 60 * 24 * 40 + a, { archived: true, origin: "external" }));
  const projects: ProjectSummary[] = [];
  const orgId = "org_acme";
  ["Designs", "Shop"].forEach((suffix, p) => {
    const projectId = `prj_acme${p}`;
    const projectName = `Acme${suffix}`;
    const root = `/w/projects/acme-${p}`;
    projects.push({ id: projectId, name: projectName, root, origin: "folder", createdAt: iso(9999), space: { kind: "org", orgId, orgName: "Acme" } } as unknown as ProjectSummary);
    const n = p === 0 ? 30 : 4;
    for (let i = 0; i < n; i++) {
      sessions.push(row(`acme${p}-${i}`, root, `Acme ${p} job ${i}`, 20 + p * 100 + i, { org: { orgId, orgName: "Acme", projectId, projectName, kind: "coding" } } as Partial<SessionSummary>));
      if (p === 0) sessions.push(row(`acme${p}-done-${i}`, root, `Acme ${p} merged ${i}`, 500 + i, { org: { orgId, orgName: "Acme", projectId, projectName, kind: "coding", finished: true } } as Partial<SessionSummary>));
    }
  });
  // A second org after Acme, so the list has room below Acme to bring a collapsed head to its top.
  const zeta = "/w/projects/zeta";
  projects.push({ id: "prj_zeta", name: "ZetaWorks", root: zeta, origin: "folder", createdAt: iso(9999), space: { kind: "org", orgId: "org_zeta", orgName: "Zeta" } } as unknown as ProjectSummary);
  for (let i = 0; i < 40; i++) {
    sessions.push(row(`zeta-${i}`, zeta, `Zeta job ${i}`, 700 + i, { org: { orgId: "org_zeta", orgName: "Zeta", projectId: "prj_zeta", projectName: "ZetaWorks", kind: "coding" } } as Partial<SessionSummary>));
  }
  // A standalone project: the Projects region, its sessions in its folder.
  const solo = "/w/projects/solo";
  projects.push({ id: "prj_solo", name: "Solo", root: solo, origin: "folder", createdAt: iso(9999), space: { kind: "standalone" } } as unknown as ProjectSummary);
  for (let i = 0; i < 30; i++) {
    sessions.push(row(`solo-${i}`, solo, `Solo job ${i}`, 200 + i, { project: { projectId: "prj_solo", projectName: "Solo", kind: "coding" } } as Partial<SessionSummary>));
  }
  return { sessions, projects };
}

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

async function open(w: World, width: number): Promise<Page> {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: phone, isMobile: phone });
  const page = await ctx.newPage();
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.routeWebSocket(/.*/, () => {});
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p === "/api/sessions") return route.fulfill(json(w.sessions));
    if (p === "/api/projects") return route.fulfill(json({ projects: w.projects }));
    if (p === "/api/orgs") return route.fulfill(json({ operator: { name: "Operator" }, orgs: [{ id: "org_acme", name: "Acme", slug: "acme", createdAt: iso(9999), people: 0, projects: 2, openBatons: 0 }, { id: "org_zeta", name: "Zeta", slug: "zeta", createdAt: iso(9999), people: 0, projects: 1, openBatons: 0 }] }));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: T0, counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/session-groups") return route.fulfill(json([GROUP]));
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

/** The list re-read, as when the window comes back into focus, and given time to land. */
async function refresh(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(700);
}

// Each group is found by a selector the page evaluates; `HOSTS` names them once.
const HOSTS = {
  org: ".sidebar-orgs:not(.sidebar-projects) .org-section",
  done: ".sidebar-orgs:not(.sidebar-projects) .org-section .org-project:first-of-type .org-group:last-of-type > .org-done",
  folder: ".sidebar-folders .session-group",
  group: ".sidebar-groups .group-section",
  groupFolder: ".sidebar-groups .group-section > .session-group",
  day: ".sidebar-archive .archive-date",
  dayFolder: ".sidebar-archive .archive-date > .session-group",
  project: ".sidebar-projects .org-project",
} as const;
type Host = keyof typeof HOSTS;

/** Opens a closed <details> through its head, as a person would. */
async function openHead(page: Page, sel: string) {
  const open = await page.evaluate((sel) => (document.querySelector(sel) as HTMLDetailsElement | null)?.open, sel);
  assert.notEqual(open, undefined, `${sel} is on the page`);
  if (!open) await page.locator(`${sel} > summary`).first().click();
  await page.waitForTimeout(150);
}

/** Opens what the measurements need: the Groups region, the group and its first folder, the Archive's first day and
    its first folder, the Folders folder, the org's big Done. */
async function openAll(page: Page) {
  await openHead(page, ".sidebar-groups");
  await openHead(page, HOSTS.group);
  await openHead(page, HOSTS.groupFolder);
  await openHead(page, ".sidebar-archive");
  await openHead(page, HOSTS.day);
  await openHead(page, HOSTS.dayFolder);
  await openHead(page, HOSTS.folder);
  await openHead(page, HOSTS.done);
}

interface Geometry {
  /** The visible line's centre: an under-arrow line's drawn 2px, an edge line's host border. */
  line: number;
  /** The head's chevron centre. */
  chevron: number;
  /** The line's press box. */
  boxLeft: number;
  boxRight: number;
  boxTop: number;
  boxBottom: number;
  headBottom: number;
  hostLeft: number;
  hostBottom: number;
  edge: boolean;
}

const geometry = (page: Page, sel: string) =>
  page.evaluate((sel): Geometry => {
    const host = document.querySelector<HTMLElement>(sel)!;
    const line = host.querySelector<HTMLElement>(":scope > .guide-line")!;
    const head = host.querySelector<HTMLElement>(":scope > summary, :scope > .org-project-head")!;
    const chev = head.querySelector(".icon-twist")!.getBoundingClientRect();
    const box = line.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const edge = line.classList.contains("guide-line-edge");
    const cs = getComputedStyle(line, "::before");
    const hostCs = getComputedStyle(host);
    const lineX = edge ? hr.left + parseFloat(hostCs.borderLeftWidth) / 2 : box.left + parseFloat(cs.left) + parseFloat(cs.width) / 2;
    return { line: lineX, chevron: chev.left + chev.width / 2, boxLeft: box.left, boxRight: box.right, boxTop: box.top, boxBottom: box.bottom, headBottom: head.getBoundingClientRect().bottom, hostLeft: hr.left, hostBottom: hr.bottom, edge };
  }, sel);

/** A point on the line `dx` off its centre, inside the list's view; asserts the line is what is under it. */
async function pointOn(page: Page, sel: string, dx: number) {
  const p = await page.evaluate(
    ({ sel, dx }) => {
      const host = document.querySelector<HTMLElement>(sel)!;
      const line = host.querySelector<HTMLElement>(":scope > .guide-line")!;
      const scroller = document.querySelector<HTMLElement>(".sidebar-list")!;
      let list = scroller.getBoundingClientRect();
      let box = line.getBoundingClientRect();
      // Not enough of the line on screen: scroll it there first (a scroll of the user's own, as a wheel would be).
      if (Math.min(box.bottom, list.bottom) - Math.max(box.top, list.top) < 3 * 44 + 40) {
        scroller.scrollTop += box.top - list.top - 50;
        list = scroller.getBoundingClientRect();
        box = line.getBoundingClientRect();
      }
      const edge = line.classList.contains("guide-line-edge");
      const cs = getComputedStyle(line, "::before");
      const hr = host.getBoundingClientRect();
      const x = (edge ? hr.left + parseFloat(getComputedStyle(host).borderLeftWidth) / 2 : box.left + parseFloat(cs.left) + parseFloat(cs.width) / 2) + dx;
      // Below every sticky head (up to 3 deep), well inside the visible part of the line.
      const top = Math.max(box.top, list.top) + 3 * 44 + 10;
      const bottom = Math.min(box.bottom, list.bottom) - 10;
      const y = Math.min(top, (Math.max(box.top, list.top) + bottom) / 2 + 60, bottom);
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit === line };
    },
    { sel, dx },
  );
  assert.ok(p.hit, `${sel}: the line is what is under the press at ${dx}px off its centre`);
  return p;
}

const headPlace = (page: Page, sel: string) =>
  page.evaluate((sel) => {
    const host = document.querySelector<HTMLElement>(sel)!;
    const head = host.querySelector<HTMLElement>(":scope > summary, :scope > .org-project-head")!;
    const list = document.querySelector<HTMLElement>(".sidebar-list")!;
    const lr = list.getBoundingClientRect();
    const hr = head.getBoundingClientRect();
    return { top: hr.top - lr.top, inView: hr.top >= lr.top - 0.5 && hr.bottom <= lr.bottom + 0.5, scrollTop: list.scrollTop, open: host instanceof HTMLDetailsElement ? host.open : !!host.querySelector(".project-rows") };
  }, sel);

/** Scrolls the list so the host's head is `by` px above the list's top (its line still on screen below). */
const scrollPastHead = (page: Page, sel: string, by: number) =>
  page.evaluate(
    ({ sel, by }) => {
      const host = document.querySelector<HTMLElement>(sel)!;
      const head = host.querySelector<HTMLElement>(":scope > summary, :scope > .org-project-head")!;
      const list = document.querySelector<HTMLElement>(".sidebar-list")!;
      list.scrollTop += head.getBoundingClientRect().top - list.getBoundingClientRect().top + by;
    },
    { sel, by },
  );

for (const width of [1280, 320]) {
  test(`${width}px: every line sits where it should: under its chevron, or at its group's edge`, async () => {
    const page = await open(world(), width);
    await openAll(page);
    for (const k of ["org", "group", "done", "day"] as Host[]) {
      const g = await geometry(page, HOSTS[k]);
      assert.equal(g.edge, false, `${k}: an under-arrow line`);
      assert.ok(Math.abs(g.line - g.chevron) <= 0.5, `${k}: the line's centre ${g.line} is the chevron's ${g.chevron}`);
      assert.ok(Math.abs(g.boxTop - g.headBottom) <= 1, `${k}: the line starts at the head's bottom`);
      // The box is about 12px, centred, except where it splits with a nested line.
      assert.ok(Math.abs(g.line - g.boxLeft - (g.boxRight - g.boxLeft) / 2) <= 0.5 || k === "group" || k === "day", `${k}: the box is centred on the line`);
    }
    for (const k of ["folder", "groupFolder", "dayFolder", "project"] as Host[]) {
      const g = await geometry(page, HOSTS[k]);
      assert.equal(g.edge, true, `${k}: an edge line`);
      assert.ok(Math.abs(g.boxLeft - (k === "folder" || k === "project" ? g.hostLeft : g.boxLeft)) <= 0.5, `${k}: the box starts at the group's edge`);
      assert.ok(Math.abs(g.boxTop - (await page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().top, HOSTS[k]))) <= 1, `${k}: the edge line runs the whole block`);
    }
    // The org's line is one piece down past its last project, not one per project.
    const org = await page.evaluate((sel) => {
      const host = document.querySelector<HTMLElement>(sel)!;
      const projects = host.querySelectorAll(":scope > .org-project");
      return { lines: host.querySelectorAll(":scope > .guide-line").length, projects: projects.length, lastBottom: projects[projects.length - 1]!.getBoundingClientRect().bottom, lineBottom: host.querySelector(":scope > .guide-line")!.getBoundingClientRect().bottom };
    }, HOSTS.org);
    assert.equal(org.lines, 1);
    assert.ok(org.projects >= 2);
    assert.ok(Math.abs(org.lineBottom - org.lastBottom) <= 1, `the org's line runs to its last project's end (${org.lineBottom} vs ${org.lastBottom})`);
    // Nested lines' boxes never overlap: the group's ends where its folder's begins, at the midpoint between the lines.
    for (const [outer, inner] of [["group", "groupFolder"], ["day", "dayFolder"]] as [Host, Host][]) {
      const o = await geometry(page, HOSTS[outer]);
      const i = await geometry(page, HOSTS[inner]);
      assert.ok(i.line - o.line >= 6, `${inner}'s line stands clear of ${outer}'s (${i.line - o.line}px apart)`);
      assert.ok(Math.abs(o.boxRight - i.boxLeft) <= 0.5, `${outer}'s box ends where ${inner}'s begins`);
      assert.ok(Math.abs(o.boxRight - (o.line + i.line) / 2) <= 0.5, "at the midpoint between the two lines");
    }
    // Folders-region titles lose nothing: a folder's rows start where they always did, 4px in.
    const rowLeft = await page.evaluate((sel) => {
      const host = document.querySelector<HTMLElement>(sel)!;
      return host.querySelector(".session-row-shell")!.getBoundingClientRect().left - document.querySelector(".sidebar-list")!.getBoundingClientRect().left;
    }, HOSTS.folder);
    assert.ok(Math.abs(rowLeft - 4) <= 0.5, `a Folders row starts 4px in (${rowLeft})`);
    await page.context().close();
  });
}

test("hovering a line: a hand, the line strengthens, the head lights up, and the tooltip names the group", async () => {
  const page = await open(world(), 1280);
  const p = await pointOn(page, HOSTS.org, 5);
  const rest = await page.evaluate((sel) => {
    const host = document.querySelector(sel)!;
    return { line: getComputedStyle(host.querySelector(":scope > .guide-line")!, "::before").backgroundColor, head: getComputedStyle(host.querySelector(":scope > summary")!).backgroundColor };
  }, HOSTS.org);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(300);
  const hover = await page.evaluate((sel) => {
    const host = document.querySelector(sel)!;
    const line = host.querySelector<HTMLElement>(":scope > .guide-line")!;
    return { cursor: getComputedStyle(line).cursor, line: getComputedStyle(line, "::before").backgroundColor, head: getComputedStyle(host.querySelector(":scope > summary")!).backgroundColor, title: line.title, hidden: line.getAttribute("aria-hidden"), tab: line.tabIndex };
  }, HOSTS.org);
  assert.equal(hover.cursor, "pointer");
  assert.notEqual(hover.line, rest.line, "the line strengthens");
  assert.notEqual(hover.head, rest.head, "the head lights up");
  assert.equal(hover.title, "Collapse Acme");
  assert.equal(hover.hidden, "true");
  assert.equal(hover.tab, -1, "not a Tab stop");
  await page.context().close();
});

for (const width of [1280, 320]) {
  test(`${width}px: a press 5px off an org's line collapses it, the head comes to the top, and it stays shut`, async () => {
    const page = await open(world(), width);
    await scrollPastHead(page, HOSTS.org, 400);
    assert.equal((await headPlace(page, HOSTS.org)).inView, false, "the org's head has scrolled out above");
    const p = await pointOn(page, HOSTS.org, 5);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(400);
    const after = await headPlace(page, HOSTS.org);
    assert.equal(after.open, false, "collapsed");
    assert.ok(after.inView && Math.abs(after.top) <= 1, `its head sits at the list's top (${after.top})`);
    await refresh(page);
    assert.equal((await headPlace(page, HOSTS.org)).open, false, "the choice holds through a refresh");
    await page.context().close();
  });
}

test("a press 5px off a folder's edge line collapses it, the choice is stored as the head's is, and its pinned head stays in view", async () => {
  const page = await open(world(), 1280);
  await openHead(page, HOSTS.folder);
  await scrollPastHead(page, HOSTS.folder, 600);
  const p = await pointOn(page, HOSTS.folder, 5);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  const after = await headPlace(page, HOSTS.folder);
  assert.equal(after.open, false, "collapsed");
  assert.ok(after.inView, `its head is in view (${after.top})`);
  assert.equal(await page.evaluate((cwd) => sessionStorage.getItem(`sova:folder-open-t-${cwd}`), FOLDER), "0", "stored exactly as the head's press stores it");
  await refresh(page);
  assert.equal((await headPlace(page, HOSTS.folder)).open, false);
  await page.context().close();
});

test("a press 5px off a Done's line collapses it; with its head in view nothing moves", async () => {
  const page = await open(world(), 1280);
  await openHead(page, HOSTS.done);
  // The Done's head on screen, a little below the list's top.
  await scrollPastHead(page, HOSTS.done, -30);
  const before = await headPlace(page, HOSTS.done);
  assert.ok(before.inView);
  const p = await pointOn(page, HOSTS.done, -5);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  const after = await headPlace(page, HOSTS.done);
  assert.equal(after.open, false, "collapsed");
  assert.ok(Math.abs(after.top - before.top) <= 1, `its head holds still (${before.top} → ${after.top})`);
  await refresh(page);
  assert.equal((await headPlace(page, HOSTS.done)).open, false, "the choice holds through a refresh");
  // Scrolled out, then pressed: it comes to the top.
  await openHead(page, HOSTS.done);
  await scrollPastHead(page, HOSTS.done, 500);
  const q = await pointOn(page, HOSTS.done, 5);
  await page.mouse.click(q.x, q.y);
  await page.waitForTimeout(400);
  const back = await headPlace(page, HOSTS.done);
  assert.equal(back.open, false);
  assert.ok(back.inView && Math.abs(back.top) <= 1, `its head sits at the list's top (${back.top})`);
  await page.context().close();
});

test("a press on a Projects-region project's edge line folds it as its arrow does", async () => {
  const page = await open(world(), 1280);
  await scrollPastHead(page, HOSTS.project, 500);
  const p = await pointOn(page, HOSTS.project, 5);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  const after = await headPlace(page, HOSTS.project);
  assert.equal(after.open, false, "folded");
  assert.ok(after.inView, `its head is in view (${after.top})`);
  assert.equal(await page.locator(`${HOSTS.project} .project-fold`).first().getAttribute("aria-expanded"), "false", "its arrow says folded");
  await page.context().close();
});

test("a group's line and its folder's split at the midpoint: each press goes to the nearer line", async () => {
  const page = await open(world(), 1280);
  await openAll(page);
  const o = await geometry(page, HOSTS.group);
  const i = await geometry(page, HOSTS.groupFolder);
  const mid = (o.line + i.line) / 2;
  const y = await page.evaluate((sel) => {
    const folder = document.querySelector<HTMLElement>(sel)!;
    const list = document.querySelector<HTMLElement>(".sidebar-list")!;
    list.scrollTop += folder.getBoundingClientRect().top - list.getBoundingClientRect().top - 100;
    const r = folder.getBoundingClientRect();
    return r.top + Math.min(r.height / 2, 200);
  }, HOSTS.groupFolder);
  const at = (x: number) =>
    page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el?.classList.contains("guide-line") ? (el.parentElement!.classList.contains("group-section") ? "group" : "folder") : "other";
      },
      { x, y },
    );
  assert.equal(await at(mid - 1), "group");
  assert.equal(await at(mid + 1), "folder");
  await page.context().close();
});
