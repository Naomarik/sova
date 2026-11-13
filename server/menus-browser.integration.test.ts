// Run: pnpm test:int -- server/menus-browser.integration.test.ts
// Right-click menus in a real browser (§app.context-menus/placement): a right-button press and release
// without moving leaves Sova's menu open, at the normal spot (a sidebar row, a message), flipped up,
// flipped left and both (Agents board rows, which reach the window's right edge and, with enough
// sessions, its bottom), and when the menu moves to another row. Real pointer input (page.mouse down and up with the right button,
// trusted CDP events, never a synthetic dispatch), against a throwaway server serving this tree's
// frontend (the harness is forms-browser.test.helper.ts). Per case: no menu while the button is held,
// the menu open after the release and still open a frame and 300 ms later, its corner (or, flipped,
// its far edge) at the pointer, and its open after the release's pointerup.
//
// A control runs first: a bare popover opened during the press with its corner at the pointer, then
// the release. A browser that keeps that one open never light-dismisses on a right-button release,
// so the cases can't fail on it: they skip saying so, never pass. In the "menus" slow group
// (scripts/test-groups.mjs): a landing runs it when menu code changes. The browser is found as the
// tour tests find it (discoverTourBrowser; on macOS Playwright's chrome-headless-shell first).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import type { Page } from "playwright-core";
import { formsBrowser, until } from "./forms-browser.test.helper";

const h = formsBrowser("sova-menus-browser-", { width: 1024, height: 720 });
const skip = h.skip;
let page: Page;
let s: typeof h.s;

/** The control's finding: undefined until it ran, false when this browser can't show the bug. */
let canFail: boolean | undefined;
const CANNOT_FAIL = "this browser never light-dismisses on right-button release; the fix can't fail here";

interface Session {
  id: string;
  path: string;
}
/** A real coding worktree in a throwaway repository, with one uncommitted file. */
async function codingWorktree(name: string): Promise<{ project: string; session: string; path: string }> {
  const root = join(s.work, name.toLowerCase().replaceAll(" ", "-"));
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q", "-b", "master");
  writeFileSync(join(root, "README.md"), `${name}\n`);
  git("add", "README.md");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "init");
  const registered = await api("POST", "/api/projects", { root, name });
  const started = await api("POST", `/api/projects/${registered.project.id}/overseer/coding`, { title: name });
  assert.ok(started.worktree?.path, "the coding session has a worktree");
  writeFileSync(join(started.worktree.path, "keep.txt"), "uncommitted work the listing must name\n");
  return { project: registered.project.id, session: started.sessionId, path: started.worktree.path };
}

/** The transcript on screen (the message cases'). */
let alpha: Session;
/** The two newest sessions: the top of the sidebar's list, so both rows are drawn. */
let newest: Session;
let next: Session;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${s.base}${path}`, { method, headers: { "x-sova-token": s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(r.ok, `${method} ${path}: ${r.status} ${await r.clone().text()}`);
  return r.json();
}
const replies = async (ses: Session) => ((await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}`)).items as { kind: string }[]).filter((i) => i.kind === "assistant-text").length;
/** A session on the stand-in model with `turns` whole exchanges. */
async function chat(first: string, turns: number): Promise<Session> {
  const ses: Session = await api("POST", "/api/sessions", { cwd: s.work });
  for (let n = 1; n <= turns; n++) {
    await api("POST", "/api/sessions/prompt", { path: ses.path, text: n === 1 ? first : `${first}, turn ${n}` });
    await until(`${first}: reply ${n}`, async () => (await replies(ses)) >= n, 60_000);
  }
  return ses;
}

/** Records, in the page, the press and release, every contextmenu, and every popover's toggle (`menu`: one of Sova's menu panels). */
function recorder() {
  const w = window as unknown as { menuLog: [string, string][] };
  w.menuLog = [];
  for (const type of ["pointerdown", "pointerup", "contextmenu"]) addEventListener(type, (e) => w.menuLog.push([type, String((e as MouseEvent).buttons)]), true);
  document.addEventListener("beforetoggle", (e) => w.menuLog.push([(e.target as Element).matches(".action-menu") ? "menu" : "toggle", (e as Event & { newState: string }).newState]), true);
}
const log = () => page.evaluate(() => (window as unknown as { menuLog: [string, string][] }).menuLog.splice(0));
const frame = () => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const settle = async () => {
  await frame();
  await new Promise((r) => setTimeout(r, 300));
};
interface Open {
  label: string | null;
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** Every open menu panel of Sova's (a hover card is a popover too, and not one), with its menu's name and its box. */
const openMenus = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".action-menu:popover-open")].map((el) => {
      const r = el.getBoundingClientRect();
      return { label: el.querySelector('[role="menu"]')?.getAttribute("aria-label") ?? null, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }),
  );
async function closeAll() {
  await page.keyboard.press("Escape");
  await until("no menu open", async () => (await openMenus()).length === 0, 5_000);
  await log();
}

/** A right-button press and release at (x, y) without moving: what was open while held and after. */
async function rightClick(x: number, y: number): Promise<{ held: Open[]; after: Open[]; events: [string, string][] }> {
  await page.mouse.move(x, y);
  await frame();
  await log();
  await page.mouse.down({ button: "right" });
  await settle();
  const held = await openMenus();
  await page.mouse.up({ button: "right" });
  await settle();
  return { held, after: await openMenus(), events: await log() };
}

/** The checks every case makes; answers the one open menu. */
function opensOnRelease(what: string, r: Awaited<ReturnType<typeof rightClick>>): Open {
  const wrong = [r.held.length ? `${r.held.length} menu open while the button is held` : "", r.after.length !== 1 ? `${r.after.length} menus open after the release and 300 ms later` : ""].filter(Boolean);
  assert.deepEqual(wrong, [], `${what}: ${wrong.join("; ")} (events: ${JSON.stringify(r.events)})`);
  const lastUp = r.events.map((e) => e[0]).lastIndexOf("pointerup");
  const opened = r.events.findIndex((e) => e[0] === "menu" && e[1] === "open");
  assert.ok(lastUp >= 0 && opened > lastUp, `${what}: the menu opens after the release's pointerup (events: ${JSON.stringify(r.events)})`);
  assert.equal(r.events.slice(opened).some((e) => e[0] === "menu" && e[1] === "closed"), false, `${what}: nothing closes it`);
  return r.after[0]!;
}
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

type Spot = "normal" | "up" | "left" | "both";
/** The places the cases press: a message (the transcript's `.entry` holding an `article.message`) and an Agents board row. */
const MESSAGES = ".entry:has(article.message)";
const BOARD_ROWS = "li.board-row";
/**
 * A point on one of `places` where a menu of `box`'s size opens at `spot`, on no text (a Mac selects
 * a right-clicked word, and a click on the selection is the browser's menu) and on no link or button.
 */
async function placePoint(places: string, spot: Spot, box: { width: number; height: number }): Promise<{ x: number; y: number }> {
  const found = await page.evaluate(
    ({ places, spot, box }) => {
      const W = innerWidth;
      const H = innerHeight;
      const onText = (x: number, y: number, root: Element) => {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) if (x >= r.left - 3 && x <= r.right + 3 && y >= r.top - 3 && y <= r.bottom + 3) return true;
        }
        return false;
      };
      const fitsBelow = (y: number) => box.height <= H - 8 - y;
      const fitsRight = (x: number) => box.width <= W - 8 - x;
      const want = (x: number, y: number) => {
        // Inside the window's 8px margin: a menu edge at the pointer, never clamped there.
        if (x > W - 9 || y > H - 9) return false;
        const up = !fitsBelow(y) && y - box.height >= 8;
        const left = !fitsRight(x) && x - box.width >= 8;
        if (spot === "normal") return fitsBelow(y) && fitsRight(x);
        if (spot === "up") return up && fitsRight(x);
        if (spot === "left") return left && fitsBelow(y);
        return up && left;
      };
      const all = [...document.querySelectorAll(places)];
      for (const place of [...all].reverse()) {
        const r = place.getBoundingClientRect();
        for (let y = Math.ceil(r.bottom) - 3; y > r.top + 2; y -= 4)
          for (let x = Math.floor(r.right) - 3; x > r.left + 2; x -= 4) {
            if (!want(x, y)) continue;
            const at = document.elementFromPoint(x, y);
            if (!at || !place.contains(at) || at.closest(".reply-slot, .chain-fold, a, button, input") || onText(x, y, place)) continue;
            return { x, y };
          }
      }
      return { geometry: { W, H, box, places: all.map((e) => e.getBoundingClientRect().toJSON()) } };
    },
    { places, spot, box },
  );
  assert.ok("x" in found, `no point on ${places} opens the menu ${spot}: ${JSON.stringify(found)}`);
  return found as { x: number; y: number };
}
/** The middle of a sidebar session row's link (the row is the place; its link is its own). */
async function rowPoint(ses: Session) {
  const box = await page.locator(`a.session-row[href="#/s/${encodeURIComponent(ses.path)}"]`).boundingBox();
  assert.ok(box, `the sidebar row of ${ses.path}`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** The Agents board, every session's row on it. */
async function board() {
  if (!page.url().endsWith("#/agents")) await page.goto(`${s.base}/#/agents`);
  await until("the Agents board's rows", async () => (await page.locator(BOARD_ROWS).count()) >= 6, 30_000);
  await settle();
}

before(
  async () => {
    if (skip) return;
    ({ page, s } = h);
    alpha = await chat("Alpha menus check", 2);
    // More rows, so the Agents board reaches the window's bottom: a row there flips its menu up.
    for (const name of ["Beta", "Gamma", "Delta"]) await chat(`${name} menus check`, 1);
    next = await chat("Epsilon menus check", 1);
    newest = await chat("Zeta menus check", 1);
    await page.addInitScript(recorder);
    await page.goto(`${s.base}/#/s/${encodeURIComponent(alpha.path)}`);
    await until("the transcript and both sidebar rows", async () => (await page.locator(".entry article.message").count()) >= 4 && (await page.locator("a.session-row").count()) >= 2 && (await page.locator(`a.session-row[href="#/s/${encodeURIComponent(newest.path)}"]`).count()) === 1, 30_000);
    await settle();
  },
  { timeout: 300_000 },
);

test("control: does this browser light-dismiss a popover opened during a right press, on its release?", { skip }, async () => {
  await page.evaluate(() => {
    const row = document.createElement("div");
    row.id = "menus-control-row";
    row.style.cssText = "position:fixed;left:300px;top:300px;width:320px;height:60px;z-index:2147483646;background:#ddd";
    const pop = document.createElement("div");
    pop.id = "menus-control-pop";
    pop.popover = "auto";
    // Rounded, as Sova's panel is: the pixel at the pointer is the row's, so the release lands on the row.
    pop.style.cssText = "position:fixed;inset:auto;margin:0;padding:0;width:160px;height:80px;border:1px solid;border-radius:8px";
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      pop.style.left = `${e.clientX}px`;
      pop.style.top = `${e.clientY}px`;
      pop.showPopover();
    });
    document.body.append(row, pop);
  });
  const r = await rightClick(460, 330);
  const isOpen = () => page.evaluate(() => document.getElementById("menus-control-pop")!.matches(":popover-open"));
  const opened = r.events.some((e) => e[0] === "toggle" && e[1] === "open");
  assert.equal(r.events.some((e) => e[0] === "menu"), false, "no menu of Sova's took part");
  assert.ok(opened, `the control popover opened (events: ${JSON.stringify(r.events)})`);
  canFail = !(await isOpen());
  console.log(`menus-browser control on ${page.context().browser()?.version() ?? "an unknown browser"}: ${canFail ? "the release closed the popover: this browser can show the bug" : CANNOT_FAIL} (events: ${JSON.stringify(r.events)})`);
  await page.evaluate(() => {
    const pop = document.getElementById("menus-control-pop")!;
    if (pop.matches(":popover-open")) pop.hidePopover();
    pop.remove();
    document.getElementById("menus-control-row")!.remove();
  });
  await log();
});

/** Each case runs only where the control showed the bug can happen. */
const cases = (name: string, fn: () => Promise<void>) =>
  test(name, { skip }, async (t) => {
    assert.notEqual(canFail, undefined, "the control didn't run");
    if (!canFail) return t.skip(CANNOT_FAIL);
    try {
      await fn();
    } finally {
      await closeAll();
    }
  });

/** The session menu's size, so the board cases choose a point where it can't fit: opened from its ⋯. */
let sessionBox: { width: number; height: number } | undefined;
async function sessionMenuBox() {
  if (sessionBox) return sessionBox;
  await page.locator(`${BOARD_ROWS} button[aria-haspopup="menu"]`).first().click();
  await until("the session menu, from its ⋯", async () => (await openMenus()).length === 1, 5_000);
  const [m] = await openMenus();
  await closeAll();
  return (sessionBox = { width: Math.ceil(m!.right - m!.left), height: Math.ceil(m!.bottom - m!.top) });
}

test("Shift+F10 on a focused session row opens nothing and Sova does not prevent it", { skip }, async () => {
  await board();
  const link = page.locator(`${BOARD_ROWS} a[href^="#/s/"]`).first();
  await link.focus();
  await page.evaluate(() => {
    const w = window as unknown as { menuKeyDefaultPrevented?: boolean; menuKeyContext?: unknown };
    addEventListener("keydown", (e) => {
      if (e.key === "F10" && e.shiftKey) w.menuKeyDefaultPrevented = e.defaultPrevented;
    });
    addEventListener("contextmenu", (e) => {
      const m = e as MouseEvent & { pointerType?: string; mozInputSource?: number };
      w.menuKeyContext = { pointerType: m.pointerType, mozInputSource: m.mozInputSource, detail: m.detail, button: m.button, buttons: m.buttons, ctrlKey: m.ctrlKey, x: m.clientX, y: m.clientY };
    });
  });
  await page.keyboard.press("Shift+F10");
  await frame();
  const keyContext = await page.evaluate(() => (window as unknown as { menuKeyContext?: unknown }).menuKeyContext);
  assert.deepEqual(await openMenus(), [], `Sova has no keyboard menu gesture (native event: ${JSON.stringify(keyContext)})`);
  assert.equal(await page.evaluate(() => (window as unknown as { menuKeyDefaultPrevented?: boolean }).menuKeyDefaultPrevented), false, "the browser keeps its own keyboard context-menu key");
  await closeAll();
});

cases("a right-click on a sidebar row: open after the release, its corner at the pointer", async () => {
  const p = await rowPoint(newest);
  const m = opensOnRelease("sidebar row", await rightClick(p.x, p.y));
  assert.match(m.label ?? "", /^Actions for “/);
  assert.ok(near(m.left, p.x) && near(m.top, p.y), `corner at the pointer: ${JSON.stringify({ m, p })}`);
});

cases("a right-click on a message at the normal spot: open after the release", async () => {
  await page.goto(`${s.base}/#/s/${encodeURIComponent(alpha.path)}`);
  await until("the transcript is back on screen", async () => (await page.locator(".entry article.message").count()) >= 4, 30_000);
  await settle();
  const p = await placePoint(MESSAGES, "normal", { width: 320, height: 320 });
  const m = opensOnRelease("message", await rightClick(p.x, p.y));
  assert.ok(near(m.left, p.x) && near(m.top, p.y), `corner at the pointer: ${JSON.stringify({ m, p })}`);
});

for (const [spot, edge] of [
  ["up", "its bottom edge at the pointer"],
  ["left", "its right edge at the pointer"],
  ["both", "its bottom-right corner at the pointer"],
] as const)
  cases(`a right-click on an Agents board row near the window's ${spot === "up" ? "bottom" : spot === "left" ? "right edge" : "bottom-right corner"}: flipped ${spot}, ${edge}, open after the release`, async () => {
    await board();
    const p = await placePoint(BOARD_ROWS, spot, await sessionMenuBox());
    const m = opensOnRelease(`flipped ${spot}`, await rightClick(p.x, p.y));
    if (spot !== "left") assert.ok(near(m.bottom, p.y), `bottom edge at the pointer: ${JSON.stringify({ m, p })}`);
    if (spot !== "up") assert.ok(near(m.right, p.x), `right edge at the pointer: ${JSON.stringify({ m, p })}`);
  });

cases("moving the menu to another row: the next press closes it, the new one opens on its release", async () => {
  await board();
  // From the lower row to the one above it: the first menu opens below and right of its pointer, so
  // it never covers the second row (a press on a menu is the browser's, §app.context-menus/native).
  const a = await rowPoint(next);
  const first = opensOnRelease("row A", await rightClick(a.x, a.y));
  const b = await rowPoint(newest);
  const second = opensOnRelease("row B, with row A's menu open", await rightClick(b.x, b.y));
  assert.notEqual(second.label, first.label, "row B's own menu");
  assert.match(second.label ?? "", /^Actions for “/);
  assert.ok(near(second.left, b.x) && near(second.top, b.y), `corner at the pointer: ${JSON.stringify({ second, b })}`);
});

cases("a right-click menu follows its row when the sidebar scrolls under it", async () => {
  const link = page.locator(`a.session-row[href="#/s/${encodeURIComponent(next.path)}"]`);
  const scroller = () => link.evaluateHandle((el) => {
    let p = el.parentElement;
    while (p && p.scrollHeight <= p.clientHeight + 1) p = p.parentElement;
    return (p ?? document.scrollingElement) as HTMLElement;
  });
  const beforeScroll = await scroller().then((h) => h.evaluate((el) => {
    el.scrollTop = Math.min(80, el.scrollHeight - el.clientHeight);
    return el.scrollTop;
  }));
  assert.ok(beforeScroll > 0, "the sidebar can scroll far enough to move the row");
  await settle();
  const p = await rowPoint(next);
  const m = opensOnRelease("row before its sidebar scrolls", await rightClick(p.x, p.y));
  const before = await link.boundingBox();
  assert.ok(before);
  await scroller().then((h) => h.evaluate((el) => (el.scrollTop = 0)));
  await settle();
  const after = await link.boundingBox();
  assert.ok(after);
  const [moved] = await openMenus();
  assert.ok(moved, "the menu stays open");
  const dy = after.y - before.y;
  assert.ok(Math.abs(dy) >= beforeScroll - 1, `the row moved with the scroll: ${dy}`);
  assert.ok(near(moved.top - m.top, dy), `the menu follows that row, not its captured viewport point: ${JSON.stringify({ before: m, after: moved, dy })}`);
  assert.ok(near(moved.left - m.left, after.x - before.x), "the horizontal point follows too");
});

test("board Rename saves a typed title on click-away; empty, unchanged and Escape write nothing", { skip }, async () => {
  await board();
  await page.evaluate(() => {
    const w = window as unknown as { titleWrites: number };
    w.titleWrites = 0;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/api/sessions/title")) w.titleWrites++;
      return original(input, init);
    };
  });
  const row = page.locator(BOARD_ROWS).first();
  const originalTitle = await row.locator("a.board-title").innerText();
  const typed = "Typed from the board menu";
  const openRename = async () => {
    await row.locator('button[aria-haspopup="menu"]').click();
    await page.getByRole("menuitem", { name: `Rename “${await row.locator("a.board-title").innerText()}”` }).click();
    return page.locator('form[aria-label^="Rename "] input');
  };
  const writes = () => page.evaluate(() => (window as unknown as { titleWrites: number }).titleWrites);
  const clickAway = async () => {
    await page.locator("h1").click();
    await until("the rename menu closed", async () => (await openMenus()).length === 0, 5_000);
  };
  try {
    const box = await openRename();
    await box.fill(typed);
    await clickAway();
    await until("the typed title is on the board", async () => (await row.locator("a.board-title").innerText()) === typed, 5_000);
    assert.equal(await writes(), 1, "click-away saved the typed nonempty title once");

    await (await openRename()).fill("   ");
    await clickAway();
    assert.equal(await row.locator("a.board-title").innerText(), typed);
    assert.equal(await writes(), 1, "an empty box on click-away cancels, as the old field did");

    await (await openRename()).fill("Not saved");
    await page.locator('form[aria-label^="Rename "] input').press("Escape");
    await until("Escape closed the rename menu", async () => (await openMenus()).length === 0, 5_000);
    assert.equal(await writes(), 1, "Escape cancels");

    await openRename();
    await clickAway();
    assert.equal(await writes(), 1, "an unchanged title writes nothing");
    assert.equal(await row.locator("a.board-title").innerText(), typed);
    assert.notEqual(originalTitle, typed, "the case really changed the title");
  } finally {
    await closeAll();
  }
});

test("Remove Anyway's listing starts on Back, and Tab reaches Delete and Remove Worktree", { skip }, async () => {
  const wt = await codingWorktree("Menu removal focus");
  const hold = await api("POST", `/api/projects/${wt.project}/overseer/worktrees/remove`, { sessionId: wt.session, dryRun: true });
  assert.ok(hold.removeAnyway, `the uncommitted file offers Remove Anyway: ${hold.reason}`);
  await page.goto(`${s.base}/#/projects/${wt.project}`);
  const row = page.locator("li.project-worktree", { hasText: "Menu removal focus" });
  await until("the coding worktree row", async () => (await row.count()) === 1, 30_000);
  await row.locator('button[aria-haspopup="menu"]').click();
  const remove = page.getByRole("menuitem", { name: /^Remove Worktree:/ });
  await until("Remove Worktree is available", async () => (await remove.getAttribute("aria-disabled")) === null, 30_000);
  await remove.click();
  const anyway = page.getByRole("button", { name: "Remove Anyway", exact: true });
  await until("the dry run offers Remove Anyway", async () => (await anyway.count()) === 1, 10_000, () => page.locator(".action-menu:popover-open").innerText());
  await anyway.click();
  const back = page.getByRole("button", { name: "Back", exact: true });
  const del = page.getByRole("button", { name: "Delete and Remove Worktree", exact: true });
  await until("focus starts on Back", async () => back.evaluate((el) => el === document.activeElement), 5_000);
  assert.match(await page.locator(".remove-anyway-listing").innerText(), /keep\.txt/, "the exact uncommitted listing is in the menu");
  await page.keyboard.press("Tab");
  assert.equal(await del.evaluate((el) => el === document.activeElement), true, "Tab reaches the destructive choice without activating it");
  await page.keyboard.press("Escape");
  await until("Escape closes the menu", async () => (await openMenus()).length === 0, 5_000);
});

test("a hard dry-run hold moves focus to Cancel when the destructive button disappears", { skip }, async () => {
  const wt = await codingWorktree("Menu hard hold focus");
  await page.goto(`${s.base}/#/projects/${wt.project}`);
  await page.reload();
  const row = page.locator("li.project-worktree", { hasText: "Menu hard hold focus" });
  await until("the hard-hold worktree row", async () => (await row.count()) === 1, 10_000, () => page.locator("body").innerText());
  const route = `**/api/projects/${wt.project}/overseer/worktrees/remove`;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(route, async (r) => {
    if (r.request().postDataJSON()?.dryRun !== true) return r.continue();
    await gate;
    await r.fulfill({ json: { reason: "Its session is working. Stop it before removing the worktree." } });
  });
  try {
    await row.locator('button[aria-haspopup="menu"]').click();
    const remove = page.getByRole("menuitem", { name: /^Remove Worktree:/ });
    await until("Remove Worktree is available for the hard-hold case", async () => (await remove.getAttribute("aria-disabled")) === null, 30_000);
    await remove.click();
    const destructive = page.getByRole("button", { name: "Remove Worktree", exact: true });
    await until("the loading question's button has focus", async () => destructive.evaluate((el) => el === document.activeElement), 5_000);
    release();
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await until("Cancel takes focus when the hard hold removes the destructive button", async () => cancel.evaluate((el) => el === document.activeElement), 5_000);
  } finally {
    release();
    await page.unroute(route);
    await closeAll();
  }
});

test("reopening removal never offers the retained hold while the fresh dry run is pending", { skip }, async () => {
  const wt = await codingWorktree("Menu reopened removal");
  const first = await api("POST", `/api/projects/${wt.project}/overseer/worktrees/remove`, { sessionId: wt.session, dryRun: true });
  assert.ok(first.removeAnyway, `the first dry run offers Remove Anyway: ${first.reason}`);
  await page.goto(`${s.base}/#/projects/${wt.project}`);
  await page.reload();
  const row = page.locator("li.project-worktree", { hasText: "Menu reopened removal" });
  await until("the reopened worktree row", async () => (await row.count()) === 1, 10_000, () => page.locator("body").innerText());
  const openRemoval = async (rightClick = false) => {
    if (rightClick) await row.click({ button: "right", position: { x: 20, y: 20 } });
    else await row.locator('button[aria-haspopup="menu"]').click();
    const remove = page.getByRole("menuitem", { name: /^Remove Worktree:/ });
    await until("Remove Worktree is available for reopening", async () => (await remove.getAttribute("aria-disabled")) === null, 5_000, () => page.locator("body").innerText());
    await remove.click();
  };
  await openRemoval();
  const anyway = page.getByRole("button", { name: "Remove Anyway", exact: true });
  await until("the first dry run is visible", async () => (await anyway.count()) === 1, 10_000);
  await page.getByRole("button", { name: "Cancel", exact: true }).press("Enter");
  await until("the first removal closed", async () => (await openMenus()).length === 0, 5_000, async () => `${JSON.stringify(await openMenus())}\n${await page.locator(".action-menu:popover-open").allInnerTexts()}`);

  const route = `**/api/projects/${wt.project}/overseer/worktrees/remove`;
  let release!: () => void;
  let intercepted = false;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(route, async (r) => {
    if (r.request().postDataJSON()?.dryRun !== true) return r.continue();
    intercepted = true;
    await gate;
    await r.fulfill({ json: { reason: "Fresh dry run: the worktree still cannot go." } });
  });
  try {
    await openRemoval(true);
    await until("the second dry run started", async () => intercepted, 5_000, () => page.locator("body").innerText());
    const panel = page.locator(".action-menu:popover-open");
    assert.doesNotMatch(await panel.innerText(), new RegExp(first.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the old reason is not presented as the fresh answer");
    assert.equal(await panel.getByRole("button", { name: "Remove Anyway", exact: true }).count(), 0, "no Remove Anyway from the retained hold");
    assert.equal(await panel.locator(".remove-anyway-listing").count(), 0, "no old exact listing");
    assert.equal(await panel.getByRole("button", { name: "Delete and Remove Worktree", exact: true }).count(), 0, "no old destructive confirmation");
    assert.equal(await panel.getByRole("button", { name: "Remove Worktree", exact: true }).getAttribute("aria-disabled"), "true", "the ordinary removal waits for the fresh dry run");
    release();
    await until("the fresh answer replaces the retained one", async () => (await panel.innerText()).includes("Fresh dry run: the worktree still cannot go."), 5_000);
    assert.doesNotMatch(await panel.innerText(), /keep\.txt/, "nothing from the old listing survives the fresh answer");
  } finally {
    release();
    await page.unroute(route);
    await closeAll();
  }
});
