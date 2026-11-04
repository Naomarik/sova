// The sidebar's Needs you rows in a real Chrome, at desktop and phone width, light and dark: one row per item, every kind
// of row at once, each a stretched link with a state word; Merge Branch and Cancel are real buttons beside the link, one
// tab stop each; two same-named projects tell themselves apart; the region's collapse, count, softer tier and cut note
// stand. The app's own build, served from a scratch build with every request answered here (no server, no network).
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { AttentionItem, SessionSummary } from "../shared/protocol";
import type { ProjectSummary } from "../shared/projects";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  dist = process.env.SOVA_NY_UI_DIST || join(scratchRoot("sova-ny-ui-"), "dist");
  if (!process.env.SOVA_NY_UI_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

const T0 = Date.now();
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();
const PID = "prj_ny000001";
const PROJECT: ProjectSummary = { id: PID, name: "Notes", root: "/w/work/notes", origin: "folder", createdAt: iso(10_000), space: { kind: "standalone" } };
const session = (id: string, title: string, cwd: string): SessionSummary =>
  ({ id, path: `/w/sessions/${id}.jsonl`, cwd, title, createdAt: iso(120), lastActiveAt: iso(9), model: "mock/m1", context: { tokens: 1, window: 100_000 }, live: null, origin: "web", archived: false, busy: false }) as unknown as SessionSummary;
const CHAT = session("s1", "Fix the login page", "/w/shop");
const REVIEW = session("s2", "Set up deploy", "/w/shop");
const GUESS = session("s3", "Tidy the docs", "/w/docs");
const act = (x: Partial<AttentionItem> & Pick<AttentionItem, "id" | "kind">): AttentionItem => ({ path: "", title: "Notes", where: "/w/work/notes", tier: "act", since: T0 - 60_000, detail: "", href: `#/projects/${PID}`, ...x });

const ITEMS: AttentionItem[] = [
  act({ id: "c1", kind: "open-questions", path: CHAT.path, title: CHAT.title, where: "/w/shop", detail: "2 open questions in al_3", href: "#/s/x" }),
  act({ id: "c2", kind: "playbook-review", path: REVIEW.path, title: REVIEW.title, where: "/w/shop", detail: "The Project deploy playbook proposes a deploy recipe.", href: "#/s/y", playbook: { projectId: PID, label: "Project deploy", hash: `sha256:${"f".repeat(64)}`, branch: "sova/d", target: "master", proposes: "deploy" } }),
  act({ id: "c3", kind: "unverified", path: GUESS.path, title: GUESS.title, where: "/w/docs", tier: "decide", soft: true, detail: "It says it's done but ran nothing." }),
  act({ id: "r1", kind: "release-failed", detail: "v0.4.0: Publish failed: origin refused the push", href: `#/projects/${PID}/releases` }),
  act({ id: "r2", kind: "release-ready", where: "/w/play/notes", detail: "Ready to publish · v0.2.0", href: "#/projects/prj_ny000002/releases" }),
  act({ id: "d1", kind: "deploy-failed", title: "Shop", where: "/w/shop", detail: "Deploy to prod failed: exit 1" }),
  act({ id: "w1", kind: "whatsapp-down", title: "WhatsApp sending", where: "Settings → Outreach", detail: "WhatsApp sending is down for Sales: logged out", href: "#/settings/outreach" }),
  act({ id: "o1", kind: "owner-request", title: "The page is slow", where: "Acme", detail: "Kim reports a problem on Shop: The page is slow", href: "#/orgs/o1/requests/q1", org: { orgId: "o1", orgName: "Acme", projectId: "p9", projectName: "Shop" } }),
  act({ id: "h1", kind: "held-act", where: "Projects", detail: "Publishing v0.4.0 starts in 9 min unless you cancel it.", held: { id: "hold_7", goesAt: T0 + 9 * 60_000, what: "Publishing v0.4.0" } }),
];

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

interface Opened {
  page: Page;
  ctx: BrowserContext;
  calls: string[];
}

async function open(width: number, scheme: "light" | "dark", o: { items?: AttentionItem[]; act?: number } = {}): Promise<Opened> {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: phone, isMobile: phone, reducedMotion: "reduce", colorScheme: scheme });
  // Sova wears dark unless a stored theme stands on light: the operating system's scheme doesn't choose.
  if (scheme === "light") await ctx.addInitScript(() => localStorage.setItem("sova:theme", JSON.stringify({ id: "plain-light", base: "light", tokens: {} })));
  const page = await ctx.newPage();
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.routeWebSocket(/.*/, () => {});
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (route.request().method() === "POST" && (p.endsWith("/runtime/merge") || p.endsWith("/cancel"))) {
      calls.push(p);
      return route.fulfill(json(p.endsWith("/cancel") ? { ok: true } : { projectId: PID, playbookState: "idle", services: [] }));
    }
    if (p === "/api/project-services/merge.status") return route.fulfill(json({ v: 1, verb: "merge.status", ok: true, merge: { view: { served: false, checks: "unset", target: "master" } } }));
    if (p === "/api/sessions") return route.fulfill(json([CHAT, REVIEW, GUESS]));
    if (p === "/api/projects") return route.fulfill(json({ projects: [PROJECT] }));
    if (p === `/api/projects/${PID}`) return route.fulfill(json(PROJECT));
    if (p === "/api/overseer/attention") {
      const items = o.items ?? ITEMS;
      return route.fulfill(json({ generatedAt: T0, counts: { act: o.act ?? items.filter((i) => i.tier === "act").length, decide: 0, fyi: 0 }, items }));
    }
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/themes") return route.fulfill(json({ dir: "/t", themes: [{ id: "plain-light", name: "Plain Light", base: "light", tokens: {} }] }));
    if (p === "/api/session-groups" || p === "/api/extensions") return route.fulfill(json([]));
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
  await page.locator(".sidebar-needs-you .ny-row").first().waitFor();
  return { page, ctx, calls };
}

const shot = async (page: Page, name: string) => {
  const dir = process.env.NY_UI_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
};

const region = (p: Page) => p.locator(".sidebar-needs-you");
const row = (p: Page, title: string) => p.locator(".ny-row").filter({ has: p.locator(".ny-title", { hasText: title }) });

describe("Needs you rows", () => {
  for (const [width, scheme] of [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const) {
    test(`every kind of row at ${width}px ${scheme}: its name, a state word, title, detail and what it opens, with no folder path`, async () => {
      const o = await open(width, scheme);
      try {
        assert.equal(await o.page.evaluate(() => document.documentElement.dataset.theme ?? "dark"), scheme);
        const rows = region(o.page).locator(".ny-row");
        assert.equal(await rows.count(), 8, "one row per item, the held act in the organizations region");
        assert.equal(await o.page.locator(".ny-row").count(), 9);
        for (const r of await o.page.locator(".ny-row").all()) {
          assert.ok(((await r.locator(".chip").textContent()) ?? "").trim(), "a word on every chip");
          assert.ok(((await r.locator(".ny-action").textContent()) ?? "").trim(), "what it opens");
          assert.ok((await r.locator(".ny-action .icon").getAttribute("aria-hidden")) === "true", "the arrow is decoration");
        }
        const text = (await region(o.page).innerText()).toLowerCase();
        assert.doesNotMatch(text, /\/w\/shop|\/w\/docs|\/w\/work|\/w\/play/, "no full folder path in a row");
        // No nesting: nothing interactive inside a link, and the separate buttons under rows are gone.
        assert.equal(await o.page.locator(".ny-link a, .ny-link button").count(), 0);
        const failed = row(o.page, "Release step failed");
        assert.equal((await failed.locator(".chip").textContent())?.trim(), "Failed");
        assert.equal(await failed.locator(".ny-detail").textContent(), "v0.4.0: Publish failed: origin refused the push");
        assert.match((await failed.locator(".ny-action").textContent()) ?? "", /^Open Release/);
        assert.equal((await row(o.page, "Ready to publish").locator(".ny-action").textContent())?.trim(), "Review and Publish");
        assert.equal(await row(o.page, "Ready to publish").locator(".ny-detail").textContent(), "v0.2.0");
        assert.equal((await row(o.page, "Fix the login page").locator(".chip").textContent())?.trim(), "Question");
        assert.equal(await row(o.page, "Sending is down").locator(".ny-name").textContent(), "WhatsApp sending");
        assert.equal(await row(o.page, "The page is slow").locator(".ny-name").textContent(), "Acme · Shop");
        assert.equal(await o.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "nothing scrolls sideways");
        assert.equal(await o.page.evaluate(() => document.documentElement.dataset.theme ?? "dark"), scheme, "still, after the theme list came");
        await shot(o.page, `needs-you-${width}-${scheme}`);
      } finally {
        await o.ctx.close();
      }
    });
  }

  test("two same-named projects show just enough of their paths, and the folder's full path is the tooltip", async () => {
    const o = await open(1280, "light");
    try {
      const failed = row(o.page, "Release step failed").locator(".ny-name");
      const ready = row(o.page, "Ready to publish").locator(".ny-name");
      assert.equal(await failed.textContent(), "Notes · work/notes");
      assert.equal(await ready.textContent(), "Notes · play/notes");
      assert.equal(await ready.getAttribute("title"), "/w/play/notes");
      assert.equal(await row(o.page, "Deploy failed").locator(".ny-name").textContent(), "Shop", "a name of its own stays plain");
    } finally {
      await o.ctx.close();
    }
  });

  test("the whole row is the target; a screen reader gets it once; the link is one tab stop", async () => {
    const o = await open(1280, "light");
    try {
      const failed = row(o.page, "Release step failed");
      assert.equal(await failed.locator("a, button").count(), 1);
      const name = await failed.getByRole("link").evaluate((el) => el.textContent);
      assert.equal(name, "Notes · work/notesFailedRelease step failedv0.4.0: Publish failed: origin refused the pushOpen Release");
      assert.equal(await failed.getByRole("link").getAttribute("title"), null, "the words aren't said a second time as a description");
      // The name line, far from the link's text box edges: the stretch reaches the row's corner.
      const box = (await failed.boundingBox())!;
      await o.page.mouse.click(box.x + box.width - 6, box.y + box.height - 6);
      await o.page.waitForURL(`**/#/projects/${PID}/releases`);
    } finally {
      await o.ctx.close();
    }
  });

  for (const width of [1280, 390]) {
    test(`at ${width}px Merge Branch and Cancel are real buttons beside the row's link: each acts, none navigates, one tab stop each`, async () => {
      const o = await open(width, "light");
      try {
        const review = row(o.page, "Set up deploy");
        const merge = review.getByRole("button", { name: "Merge Branch" });
        await merge.waitFor();
        assert.equal(await review.locator(".ny-link button").count(), 0, "a sibling of the link");
        const a = (await review.locator(".ny-action").boundingBox())!;
        const b = (await merge.boundingBox())!;
        assert.ok(a.x + a.width <= b.x, `the action's words and the button stand apart: ${JSON.stringify({ a, b })}`);
        assert.ok(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) <= 4, "on one line");
        assert.ok(b.y + b.height <= (await review.boundingBox())!.y + (await review.boundingBox())!.height, "inside the row");
        await review.getByRole("link").focus();
        await o.page.keyboard.press("Tab");
        assert.equal(await o.page.evaluate(() => document.activeElement?.textContent?.trim()), "Merge Branch");
        const at = o.page.url();
        await merge.click();
        await new Promise<void>((done) => {
          const t = setInterval(() => o.calls.some((c) => c.endsWith("/runtime/merge")) && (clearInterval(t), done()), 20);
        });
        assert.equal(o.page.url(), at, "the button acted; the row's link stayed shut");

        const held = row(o.page, "Publishing v0.4.0");
        assert.match((await held.locator(".ny-detail").textContent()) ?? "", /Publishing v0\.4\.0 starts in \d+ min unless you cancel it\./);
        await held.getByRole("button", { name: "Cancel: Publishing v0.4.0" }).click();
        await new Promise<void>((done) => {
          const t = setInterval(() => o.calls.some((c) => c.endsWith("/held/hold_7/cancel")) && (clearInterval(t), done()), 20);
        });
        assert.equal(o.page.url(), at);
      } finally {
        await o.ctx.close();
      }
    });
  }

  test("what the region did stands: the count, the softer tier under its label, the cut note, collapse", async () => {
    const o = await open(1280, "light", { act: 40 });
    try {
      const head = region(o.page).locator(".sidebar-region-count");
      assert.equal(((await head.textContent()) ?? "").replace(/\s+/g, " ").trim(), "· 8");
      const soft = o.page.getByRole("list", { name: "Maybe waiting on you" });
      assert.equal(await soft.locator(".ny-row").count(), 1);
      assert.equal((await soft.locator(".chip").textContent())?.trim(), "Unchecked");
      await region(o.page).getByText("Some sessions may not be listed").waitFor();
      await region(o.page).locator("summary").click();
      assert.equal(await region(o.page).locator(".ny-row").first().isVisible(), false);
      await region(o.page).locator("summary").click();
      assert.equal(await region(o.page).locator(".ny-row").first().isVisible(), true);
    } finally {
      await o.ctx.close();
    }
  });
});
