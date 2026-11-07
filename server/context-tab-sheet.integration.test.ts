// The session pane's Context tab in a real Chrome (§app.subagents-pane/context-tab): the app's own build,
// served from a scratch build with every request answered here (no server, no network). Every top line is a
// group that opens one sheet over the tab, the same way whatever it holds; a part reads inside the sheet;
// Escape and Back go back one level and focus returns to the row it came from, and the pane stays open; each
// file is listed once, the ones not yet loaded last; skills say Read or Not read yet; Conversation opens to
// its counts and the kept summary, with no transcript button; a failed read is a toast and the sheet stays. At 390, 880 and 1440 px,
// every row is a 44px target and nothing scrolls sideways.
// CTX_UI_SHOTS=<dir> also saves screenshots of each step, light and dark, at each width.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright-core";
import type { SessionContextView, SessionSummary } from "../shared/protocol";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
const SHOTS = process.env.CTX_UI_SHOTS ?? "";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_CONTEXT_TAB_DIST=<dir>: drive a build made elsewhere.
  dist = process.env.SOVA_CONTEXT_TAB_DIST || join(scratchRoot("sova-context-tab-"), "dist");
  if (!process.env.SOVA_CONTEXT_TAB_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();
const PATH = "/w/sessions/s1.jsonl";
const CWD = "/w/projects/shop";

const ITEMS = Array.from({ length: 6 }, (_, i) => [
  { id: `u${i}`, kind: "user", text: `Question ${i}`, at: iso(60 - i * 2) },
  { id: `a${i}`, kind: "assistant-text", text: `Answer ${i}.`, at: iso(59 - i * 2), model: "mock/m1" },
]).flat();

const SESSION = {
  id: "s1",
  path: PATH,
  cwd: CWD,
  title: "Context",
  createdAt: iso(120),
  lastActiveAt: iso(9),
  model: "mock/m1",
  context: { tokens: 88_512, window: 200_000 },
  live: null,
  origin: "web",
  archived: false,
  busy: false,
} as unknown as SessionSummary;

const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "message", "ask", "inbox", "project", "worktree"];
const VIEW: SessionContextView = {
  state: "ok",
  cwd: CWD,
  window: 200_000,
  total: 88_512,
  prompt: true,
  instructions: [
    { id: "file:/w/projects/shop/AGENTS.md", label: "AGENTS.md", path: `${CWD}/AGENTS.md`, tokens: 4_300 },
    { id: "file:/w/AGENTS.md", label: "~/AGENTS.md", path: "/w/AGENTS.md", tokens: 1_900 },
  ],
  mode: { id: "section:mode", label: "Mode", text: "# Delegate mode\n\nHand work to workers.", tokens: 600 },
  rules: [
    { id: "section:preamble", label: "Preamble", text: "You are a coding assistant.", tokens: 900 },
    { id: "section:rules", label: "Rules", text: "- Be concise.", tokens: 450 },
  ],
  skills: [
    { id: "skill:design", label: "fold-ai-dev-design", detail: "Designing this project's interfaces and copy.", path: "/w/skills/design/SKILL.md", tokens: 380, read: true },
    { id: "skill:playwright", label: "playwright", detail: "Browser automation through CDP.", path: "/w/skills/playwright/SKILL.md", tokens: 300, read: false },
  ],
  tools: TOOLS.map((name, i) => ({ id: `tool:${name}`, label: name, text: JSON.stringify({ name, description: `The ${name} tool.`, parameters: { type: "object" } }, null, 2), tokens: 300 + i * 40 })),
  conversation: 60_012,
  talk: {
    user: { count: 47, tokens: 5_312 },
    replies: { count: 47, tokens: 11_400 },
    toolResults: { count: 92, tokens: 38_100 },
    other: { count: 0, tokens: 0 },
    summary: { text: "# Summary\n\n## Goal\n\nPolish the Context tab.", tokens: 5_200, at: iso(30) },
  },
  nested: [
    { path: "server/AGENTS.md", abs: `${CWD}/server/AGENTS.md`, folder: "server", tokens: 900, loaded: true },
    { path: "src/AGENTS.md", abs: `${CWD}/src/AGENTS.md`, folder: "src", tokens: 1_600, loaded: false },
  ],
  checkedAt: T0,
};
const FILES: Record<string, string> = {
  [`${CWD}/AGENTS.md`]: "# Shop\n\nThe shop's rules.\n\n- Land through the queue.",
  "/w/AGENTS.md": "- Keyboard RGB lives elsewhere.",
  [`${CWD}/server/AGENTS.md`]: "# Server\n\nBun, Hono and ws.",
  [`${CWD}/src/AGENTS.md`]: "# Frontend\n\nSolid, not React.",
  "/w/skills/design/SKILL.md": "---\nname: design\n---\n# Design\n\nThe design system.",
};
/** Read on open; this one fails, to show the sheet stays where it was. */
const MISSING = "/w/AGENTS.md";

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

/** The chat open at `width` in `scheme`, its pane on the Context tab; every request answered from the data above. */
async function open(width: number, scheme: "light" | "dark" = "light", over: { view?: SessionContextView; height?: number; files?: Record<string, string> } = {}): Promise<Page> {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: over.height ?? (phone ? 844 : width < 1000 ? 1000 : 960) }, hasTouch: phone, isMobile: phone, reducedMotion: "reduce", colorScheme: scheme });
  const page = await ctx.newPage();
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.routeWebSocket(/.*/, (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/ws/chat")) return;
    ws.send(JSON.stringify({ type: "hello", items: ITEMS, isStreaming: false, model: "mock/m1", thinking: "off", context: null }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    const q = url.searchParams;
    if (p === "/api/sessions") return route.fulfill(json([SESSION]));
    if (p === "/api/transcript") return route.fulfill(json({ items: ITEMS, context: null }));
    if (p === "/api/sessions/context-view") return route.fulfill(json(over.view ?? VIEW));
    if (p === "/api/sessions/context/file") {
      const f = q.get("file") ?? "";
      const files = { ...FILES, ...over.files };
      return f in files && f !== MISSING ? route.fulfill(json({ path: f, text: files[f] })) : route.fulfill(json({ error: "That file isn't there any more." }, 404));
    }
    if (p === "/api/projects") return route.fulfill(json({ projects: [] }));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: T0, counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
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
  await page.goto(`${ORIGIN}/#/s/${encodeURIComponent(PATH)}`);
  await page.locator('.entry[data-entry="u0"]').waitFor({ timeout: 20_000 });
  // Sova is dark unless the page wears the light base (tokens.css), whatever the system says.
  if (scheme === "light") await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.locator(".session-details-open").first().click();
  await page.locator("#session-tab-context").click();
  await page.locator(".context-list .context-row").first().waitFor({ timeout: 20_000 });
  return page;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(60);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const activeKey = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.ctxKey ?? (document.activeElement as HTMLElement | null)?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? null);
const crumbs = (page: Page) => page.locator(".context-crumbs ol").innerText().then((t) => t.replace(/\s+/g, " ").trim());
/** Every row and sheet control on screen that a finger presses: none under 44px tall. */
async function targetsOk(page: Page, where: string) {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#session-pane .context-tab button, #session-pane .context-row")]
      .filter((el) => el.checkVisibility() && !el.closest("[inert]"))
      .map((el) => ({ what: el.dataset.ctxKey ?? el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30), h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 43.5),
  );
  assert.deepEqual(small, [], `targets under 44px (${where})`);
}
/** Nothing in the pane scrolls sideways. */
async function noSideways(page: Page, where: string) {
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#session-pane .context-tab, #session-pane .session-panel-scroll, #session-pane .context-sheet-body")]
      .filter((el) => el.checkVisibility() && el.scrollWidth > el.clientWidth + 1)
      .map((el) => {
        const right = el.getBoundingClientRect().right;
        const past = [...el.querySelectorAll<HTMLElement>("*")].filter((c) => c.getBoundingClientRect().right > right + 1).slice(0, 3).map((c) => `${c.tagName.toLowerCase()}.${c.className} ${Math.round(c.getBoundingClientRect().right - right)}px`);
        return `${el.className}: ${el.scrollWidth} > ${el.clientWidth} (${past.join(", ")})`;
      }),
  );
  assert.deepEqual(wide, [], `sideways scroll (${where})`);
}

for (const width of [390, 880, 1440]) {
  test(`at ${width}px: every group opens one sheet; a part reads in it; Escape steps back one level and focus returns to its row`, async () => {
    const page = await open(width);
    try {
      // The tab: groups biggest first, an arrow on each, Other apart and static, no Free line, no subfolder section.
      const names = await page.locator("#session-pane .context-list").first().locator(".context-row-name").allInnerTexts();
      assert.deepEqual(names, ["Conversation", "Instruction files", "Tools", "Rules and docs", "Skills offered", "Mode"]);
      assert.equal(await page.locator("#session-pane button.context-row").count(), 6, "every group is a button");
      assert.equal(await page.locator("#session-pane .context-row-static .context-row-name").innerText(), "Other");
      assert.equal(await page.getByText("Free", { exact: true }).count(), 0);
      assert.equal(await page.getByText("Subfolder instructions").count(), 0);
      assert.match(await page.locator(".context-headline").innerText(), /88,512 of 200,000 tokens · 44% · 111k left/);
      assert.ok(await page.locator(".context-meter .context-meter-part").count() >= 6, "the fill bar");
      assert.match(await page.locator('[data-ctx-key="line:instructions"]').innerText(), /3 loaded · 1 not yet loaded/);
      await targetsOk(page, "the tab");
      await noSideways(page, "the tab");
      await shot(page, `${width}-light-1-tab`);

      // A group by keyboard: the sheet opens on it, focus on Back.
      await page.locator('[data-ctx-key="line:tools"]').focus();
      await page.keyboard.press("Enter");
      await page.locator(".context-sheet").waitFor();
      assert.equal(await crumbs(page), "Context › Tools");
      assert.equal(await activeKey(page), "Back");
      assert.match(await page.locator(".context-sheet-sub").first().innerText(), /^12 tools$/);
      assert.equal(await page.locator(".context-sheet button.context-row").count(), TOOLS.length);
      await targetsOk(page, "Tools");
      await noSideways(page, "Tools");
      await shot(page, `${width}-light-2-tools`);

      // A part reads in the sheet: its declaration as JSON, the group's name under it, Copy and no Source.
      await page.locator('[data-ctx-key="part:tools:tool:read"]').focus();
      await page.keyboard.press("Enter");
      await page.locator(".context-sheet .md-viewer-source code.hljs").waitFor();
      assert.equal(await crumbs(page), "Context › Tools › read");
      assert.equal(await page.locator(".context-sheet-sub").first().innerText(), "Tools");
      assert.equal(await page.locator(".context-sheet").getByRole("button", { name: "Copy" }).count(), 1);
      assert.equal(await page.locator(".context-sheet").getByRole("button", { name: "Source" }).count(), 0);
      await targetsOk(page, "a tool");

      // Escape: back one level, focus on the row it came from; again: the sheet closes, the pane stays.
      await page.keyboard.press("Escape");
      assert.equal(await crumbs(page), "Context › Tools");
      assert.equal(await activeKey(page), "part:tools:tool:read");
      await page.keyboard.press("Escape");
      await page.locator(".context-sheet").waitFor({ state: "detached" });
      assert.equal(await activeKey(page), "line:tools");
      assert.ok(await page.locator("#session-pane").isVisible(), "the pane stays open");

      // Instruction files: each once, loaded first with their folder and Loaded, then the one not yet loaded.
      await page.locator('[data-ctx-key="line:instructions"]').click();
      const files = page.locator(".context-sheet .context-list");
      assert.deepEqual(await files.nth(0).locator(".context-row-name").allInnerTexts(), ["AGENTS.md", "~/AGENTS.md", "server/AGENTS.md"]);
      assert.match(await files.nth(0).locator(".context-row").nth(0).innerText(), /Loaded[\s\S]*This chat's folder/);
      assert.match(await files.nth(0).locator(".context-row").nth(1).innerText(), /Your home folder/);
      assert.ok(await page.getByText("Not yet loaded · not counted").isVisible());
      assert.deepEqual(await files.nth(1).locator(".context-row-name").allInnerTexts(), ["src/AGENTS.md"]);
      assert.equal(await files.nth(1).locator(".context-row-size").innerText(), "+≈1.6k");
      assert.equal(await files.nth(1).locator(".context-share").count(), 0, "no share bar for a file not yet loaded");
      await shot(page, `${width}-light-3-files`);

      // A file reads from disk: its path under its name, Source and Copy; the one not yet loaded says when it would.
      await page.locator(`[data-ctx-key="part:subfolder:${CWD}/src/AGENTS.md"]`).click();
      await page.locator(".context-sheet .md-viewer-doc .message-body").waitFor();
      assert.equal(await page.locator(".context-sheet-sub").first().innerText(), `${CWD}/src/AGENTS.md`);
      assert.match(await page.locator(".context-sheet").innerText(), /Not counted yet\. It loads the first time the agent reads, edits or writes a file in src\./);
      assert.equal(await page.locator(".context-sheet").getByRole("button", { name: "Source" }).count(), 1);
      await targetsOk(page, "a file");
      await noSideways(page, "a file");
      await shot(page, `${width}-light-4-file`);

      // The breadcrumb goes straight to a level: Context closes the sheet.
      await page.locator(".context-crumb", { hasText: "Instruction files" }).click();
      assert.equal(await crumbs(page), "Context › Instruction files");
      assert.equal(await activeKey(page), `part:subfolder:${CWD}/src/AGENTS.md`);

      // A read that fails is a toast; the sheet stays on the group.
      await page.locator('[data-ctx-key="part:instructions:file:/w/AGENTS.md"]').click();
      await page.locator(".toast", { hasText: "Couldn't open that file." }).waitFor();
      assert.equal(await crumbs(page), "Context › Instruction files");
      await page.locator(".context-crumb", { hasText: "Context" }).click();
      await page.locator(".context-sheet").waitFor({ state: "detached" });

      // Skills: description and Read or Not read yet; a skill's note says what its size counts.
      await page.locator('[data-ctx-key="line:skills"]').click();
      const skills = await page.locator(".context-sheet .context-row").allInnerTexts();
      assert.match(skills[0]!, /fold-ai-dev-design[\s\S]*Read[\s\S]*Designing this project's interfaces and copy\./);
      assert.match(skills[1]!, /playwright[\s\S]*Not read yet[\s\S]*Browser automation through CDP\./);
      await shot(page, `${width}-light-5-skills`);
      await page.locator('[data-ctx-key="part:skills:skill:design"]').click();
      await page.locator(".context-sheet .md-viewer-doc").waitFor();
      assert.match(await page.locator(".context-sheet").innerText(), /Its size counts only what the model is offered: name and description\./);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.locator(".context-sheet").waitFor({ state: "detached" });

      // Conversation: its counts as static rows, the kept summary as a part, and no other button.
      await page.locator('[data-ctx-key="line:conversation"]').click();
      assert.match(await page.locator(".context-sheet-sub").first().innerText(), /^Since the last compaction · 186 messages$/);
      assert.deepEqual(await page.locator(".context-sheet .context-row-name").allInnerTexts(), ["Tool results", "Replies", "Your messages", "Compaction summary"]);
      assert.equal(await page.locator(".context-sheet .context-row-static").count(), 3);
      assert.match(await page.locator(".context-sheet .context-row-static").first().innerText(), /92 results/);
      await targetsOk(page, "Conversation");
      await shot(page, `${width}-light-6-conversation`);
      assert.equal(await page.locator(".context-sheet").getByRole("button", { name: /transcript/i }).count(), 0);
    } finally {
      await page.context().close();
    }
  });
}

// The sheet's body scrolls and its children keep their height. A card clips its rows (overflow: hidden), so as a
// shrinkable flex item it has no minimum height and collapsed to its borders once the body overflowed.
const MANY_NOT_LOADED: SessionContextView = {
  ...VIEW,
  instructions: VIEW.instructions!.slice(0, 1),
  nested: [
    { path: "server/AGENTS.md", abs: `${CWD}/server/AGENTS.md`, folder: "server", tokens: 900, loaded: true },
    ...Array.from({ length: 11 }, (_, i) => ({ path: `pkg${i}/AGENTS.md`, abs: `${CWD}/pkg${i}/AGENTS.md`, folder: `pkg${i}`, tokens: 500 + i, loaded: false })),
  ],
};
const LONG_DOC = `${CWD}/LONG.md`;
const LONG_VIEW: SessionContextView = { ...VIEW, instructions: [{ id: `file:${LONG_DOC}`, label: "LONG.md", path: LONG_DOC, tokens: 4_000 }] };
const LONG_TEXT = `# Long\n\n${Array.from({ length: 200 }, (_, i) => `Paragraph ${i}.`).join("\n\n")}`;
/** The sheet body's scroll sizes, and the height and laid-out content height of each of its element children. */
const bodyLayout = (page: Page) =>
  page.locator(".context-sheet-body").evaluate((body) => ({
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
    children: [...body.children].map((el) => ({ tag: el.tagName.toLowerCase(), h: el.getBoundingClientRect().height, content: el.scrollHeight })),
  }));

for (const width of [390, 1440]) {
  test(`at ${width}px, a list taller than the sheet: the loaded rows keep their height and the sheet scrolls`, async () => {
    const page = await open(width, "light", { view: MANY_NOT_LOADED, height: 600 });
    try {
      assert.match(await page.locator('[data-ctx-key="line:instructions"]').innerText(), /2 loaded · 11 not yet loaded/);
      await page.locator('[data-ctx-key="line:instructions"]').click();
      const loaded = page.locator(".context-sheet .context-list").first();
      await loaded.locator(".context-row").first().waitFor({ state: "attached" });
      const m = await loaded.evaluate((ul) => {
        const rows = [...ul.querySelectorAll<HTMLElement>(":scope > li")];
        const chip = ul.querySelector<HTMLElement>(".chip-success")!.getBoundingClientRect();
        return { ul: ul.getBoundingClientRect().height, rows: rows.length, rowsHeight: rows.reduce((sum, li) => sum + li.scrollHeight, 0), chipW: chip.width, chipH: chip.height };
      });
      const body = await bodyLayout(page);
      const say = JSON.stringify({ ...m, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight });
      assert.ok(body.scrollHeight > body.clientHeight, `the sheet must overflow, or this proves nothing: ${say}`);
      assert.equal(m.rows, 2, say);
      assert.ok(m.ul > 40, `the loaded card is laid out: ${say}`);
      assert.ok(m.ul + 1 >= m.rowsHeight, `the loaded card is as tall as its rows: ${say}`);
      assert.ok(m.chipW > 0 && m.chipH > 0, `the Loaded chip has a box: ${say}`);
      await shot(page, `${width}-light-7-many-files`);
      // Scrolled to its end, the sheet shows the last file not yet loaded.
      await page.locator(".context-sheet .context-list").last().locator(".context-row").last().scrollIntoViewIfNeeded();
      assert.ok(await page.locator(".context-sheet-body").evaluate((el) => el.scrollTop > 0), "the body itself scrolled");
      await noSideways(page, "many files");
    } finally {
      await page.context().close();
    }
  });

  test(`at ${width}px, a long document: it keeps its height and the sheet scrolls to its end`, async () => {
    const page = await open(width, "light", { view: LONG_VIEW, height: 600, files: { [LONG_DOC]: LONG_TEXT } });
    try {
      await page.locator('[data-ctx-key="line:instructions"]').click();
      await page.locator(`[data-ctx-key="part:instructions:file:${LONG_DOC}"]`).click();
      await page.locator(".context-sheet .md-viewer-doc .message-body").waitFor();
      const body = await bodyLayout(page);
      const say = JSON.stringify(body);
      assert.ok(body.scrollHeight > body.clientHeight, `the document must overflow, or this proves nothing: ${say}`);
      for (const c of body.children) assert.ok(c.h + 1 >= c.content, `no child of the sheet is squeezed: ${say}`);
      const last = page.locator(".context-sheet .md-viewer-doc .message-body p").last();
      assert.equal(await last.innerText(), "Paragraph 199.");
      await last.scrollIntoViewIfNeeded();
      assert.ok(await last.isVisible());
      assert.ok(await page.locator(".context-sheet-body").evaluate((el) => el.scrollTop > 0), "the body itself scrolled");
      assert.equal(await page.locator(".context-sheet").getByRole("button", { name: "Copy" }).count(), 1);
    } finally {
      await page.context().close();
    }
  });
}

if (SHOTS) {
  test("screenshots in dark, at each width: the tab, a group and a file", async () => {
    for (const width of [390, 880, 1440]) {
      const page = await open(width, "dark");
      try {
        await shot(page, `${width}-dark-1-tab`);
        await page.locator('[data-ctx-key="line:instructions"]').click();
        await shot(page, `${width}-dark-3-files`);
        await page.locator(`[data-ctx-key="part:instructions:file:${CWD}/AGENTS.md"]`).click();
        await page.locator(".context-sheet .md-viewer-doc .message-body").waitFor();
        await shot(page, `${width}-dark-4-file`);
        await page.locator(".context-crumb", { hasText: "Context" }).click();
        await page.locator('[data-ctx-key="line:conversation"]').click();
        await shot(page, `${width}-dark-6-conversation`);
      } finally {
        await page.context().close();
      }
    }
  });
}
