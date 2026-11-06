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

/** The session menu's size, so the board cases choose a point where it can't fit: opened from the
    keyboard (Shift+F10 on a board row's title link), which no pointer can close. */
let sessionBox: { width: number; height: number } | undefined;
async function sessionMenuBox() {
  if (sessionBox) return sessionBox;
  await page.locator(`${BOARD_ROWS} a[href^="#/s/"]`).first().focus();
  await page.keyboard.press("Shift+F10");
  await until("the session menu, from Shift+F10", async () => (await openMenus()).length === 1, 5_000);
  const [m] = await openMenus();
  await closeAll();
  return (sessionBox = { width: Math.ceil(m!.right - m!.left), height: Math.ceil(m!.bottom - m!.top) });
}

cases("a right-click on a sidebar row: open after the release, its corner at the pointer", async () => {
  const p = await rowPoint(newest);
  const m = opensOnRelease("sidebar row", await rightClick(p.x, p.y));
  assert.match(m.label ?? "", /^Actions for “/);
  assert.ok(near(m.left, p.x) && near(m.top, p.y), `corner at the pointer: ${JSON.stringify({ m, p })}`);
});

cases("a right-click on a message at the normal spot: open after the release", async () => {
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
