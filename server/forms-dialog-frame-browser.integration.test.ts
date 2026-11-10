// Run: pnpm test:int -- server/forms-dialog-frame-browser.integration.test.ts
// The Settings dialog's frame never moves (§app.settings-dialog/one-height): clicking or focusing a
// control low in a long scrolling list scrolls only that list, never the dialog's own box. A switch's
// box is a visually hidden input; anchored to the dialog instead of its row, it sat at its row's
// un-scrolled place, far below the frame, and focusing it scrolled the frame (`overflow: hidden` still
// scrolls programmatically): head, rail and list slid off the top and a blank block came in under the
// footer. Two fixes, each guarded here: the frame is `overflow: clip` (it can't scroll at all), and the
// hidden inputs are anchored to their own row inside the list that scrolls (focus brings the row into
// view). Only a browser lays this out, so a unit test of the CSS text can't tell the states apart.
// A file of its own in the "forms" group (harness: forms-browser.test.helper.ts), on a short window so
// the hermetic Models list runs below the fold; settings-browser.integration.test.ts is near the cap.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, test } from "node:test";
import type { Page } from "playwright-core";
import { formsBrowser, until } from "./forms-browser.test.helper";

const h = formsBrowser("sova-dialog-frame-", { width: 900, height: 500 });
let page: Page;
let s: typeof h.s;
/** The stand-in's one model isn't a long list: a second stand-in provider with 40 models, on the same
    stand-in port (no turn runs here), read by the server at its next boot. */
const LONG = 40;
before(async () => {
  ({ page, s } = h);
  if (h.skip) return;
  const file = join(s.agentDir, "models.json");
  const models = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, { models: unknown[] }> };
  const mock = models.providers.mock!;
  models.providers["mock-long"] = { ...mock, models: Array.from({ length: LONG }, (_, i) => ({ id: `long-${String(i + 1).padStart(2, "0")}`, contextWindow: 100000, maxTokens: 4000 })) };
  writeFileSync(file, JSON.stringify(models, null, 2));
  await s.restart();
}, { timeout: 60_000 });

type Rect = { top: number; bottom: number; left: number; right: number; height: number };

/** Polls until the open panel's markup reads the same three times running (a tab loads on its own time). */
async function settled(what: string): Promise<void> {
  let last = "";
  let same = 0;
  await until(`${what} settles`, async () => {
    const now = await page.evaluate(() => {
      const p = document.querySelector(".settings-modal .settings-panel");
      return p ? `${p.id}:${p.innerHTML.length}` : "";
    });
    same = now && now === last ? same + 1 : 0;
    last = now;
    return same >= 2;
  }, 20_000);
}

/** Opens every folded part of the open panel: details, and Models' provider heads. */
async function unfold(): Promise<void> {
  await page.evaluate(() => {
    const p = document.querySelector(".settings-modal .settings-panel");
    if (!p) return;
    for (const d of p.querySelectorAll("details:not([open])")) (d as HTMLDetailsElement).open = true;
    for (const b of p.querySelectorAll(".model-policy-provider button[aria-expanded='false']")) (b as HTMLButtonElement).click();
  });
}

async function openSettings(tab: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(`${s.base}/#/settings/${tab}`);
  await page.locator(`.settings-modal #settings-panel-${tab}`).waitFor({ timeout: 30_000 });
  await settled(tab);
}

/** The frame's geometry: its own scroll, its box, head, foot and panel, and the blank under the foot. */
const frame = () =>
  page.evaluate(() => {
    const m = document.querySelector(".settings-modal") as HTMLElement;
    const r = (e: Element | null): Rect => {
      const b = e!.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height) };
    };
    const panel = m.querySelector(".settings-panel") as HTMLElement;
    return { scrollTop: m.scrollTop, modal: r(m), head: r(m.querySelector(".modal-head")), foot: r(m.querySelector(".settings-foot")), panel: r(panel), panelScrollTop: panel.scrollTop, borderBottom: parseFloat(getComputedStyle(m).borderBottomWidth) };
  });

const inside = (inner: Rect, outer: Rect) => inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;

describe("Settings: clicking or focusing a control never moves the dialog's frame", { timeout: 280_000, skip: h.skip }, () => {
  test("Mouse: a switch low in Models' long list, clicked, scrolls only the list; head and foot stay put, no blank under the foot", async () => {
    await openSettings("models");
    await unfold();
    await settled("models, providers open");
    const before = await frame();
    assert.equal(before.scrollTop, 0, "the frame opened scrolled");
    const rows = page.locator("#settings-panel-models label.toggle");
    const n = await rows.count();
    assert.ok(n > LONG, `Models has ${n} switches with its providers open: too few to run below the fold`);
    // The last enabled switch: what the user reaches by scrolling the list, then clicks.
    let i = n - 1;
    while (i > 0 && !(await rows.nth(i).locator("input").isEnabled())) i--;
    const row = rows.nth(i);
    const input = row.locator("input");
    const was = await input.isChecked();
    await row.click();
    await until("the clicked switch moves", async () => (await input.isChecked()) !== was);
    const after = await frame();
    assert.equal(after.scrollTop, 0, `clicking a low switch scrolled the dialog's frame by ${after.scrollTop}px`);
    assert.deepEqual(after.head, before.head, "the head moved");
    assert.deepEqual(after.foot, before.foot, "the foot moved");
    assert.ok(Math.abs(after.modal.bottom - after.borderBottom - after.foot.bottom) <= 1, `a blank ${after.modal.bottom - after.foot.bottom}px under the foot`);
    const rowRect = await row.evaluate((e) => {
      const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height) };
    });
    assert.ok(inside(rowRect, after.panel), `the clicked row ${JSON.stringify(rowRect)} isn't inside the panel ${JSON.stringify(after.panel)}`);
  });

  test("Keyboard: focusing the last switch scrolls the list to its row, not the frame; the hidden box sits on its row", async () => {
    await openSettings("models");
    await unfold();
    await settled("models, providers open");
    const before = await frame();
    const input = page.locator("#settings-panel-models label.toggle input").last();
    // focus() reveals the element as Tab does: the browser scrolls whatever it must to show it.
    await input.focus();
    await until("the last switch has focus", async () => input.evaluate((e) => document.activeElement === e));
    const after = await frame();
    assert.equal(after.scrollTop, 0, `focusing the last switch scrolled the dialog's frame by ${after.scrollTop}px`);
    assert.notEqual(after.panelScrollTop, before.panelScrollTop, "focusing the last switch didn't scroll the list to it");
    const got = await input.evaluate((e) => {
      const rect = (n: Element) => {
        const b = n.getBoundingClientRect();
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), height: Math.round(b.height) };
      };
      return { input: rect(e), row: rect(e.closest("label.toggle")!) };
    });
    assert.ok(inside(got.row, after.panel), `the focused row ${JSON.stringify(got.row)} isn't inside the panel ${JSON.stringify(after.panel)}`);
    assert.ok(inside(got.input, got.row), `the hidden box ${JSON.stringify(got.input)} isn't on its row ${JSON.stringify(got.row)}`);
  });

  test("Every tab: the frame can't be scrolled, and focusing its last checkbox or radio leaves the frame at the top with the box inside the list", async () => {
    await openSettings("general");
    const tabs = await page.evaluate(() => [...document.querySelectorAll(".settings-modal .settings-tab")].map((t) => t.id.replace(/^settings-tab-/, "")));
    assert.ok(tabs.length >= 15, `only ${tabs.length} tabs: ${tabs.join(", ")}`);
    const seen: string[] = [];
    for (const tab of tabs) {
      await page.locator(`#settings-tab-${tab}`).click();
      await page.locator(`.settings-modal #settings-panel-${tab}`).waitFor({ timeout: 15_000 });
      await settled(tab);
      await unfold();
      await settled(`${tab}, unfolded`);
      const r = await page.evaluate(() => {
        const m = document.querySelector(".settings-modal") as HTMLElement;
        const p = m.querySelector(".settings-panel") as HTMLElement;
        // A script's scroll of the frame: a frame that can scroll at all takes it.
        m.scrollTop = 10_000;
        const scrolled = m.scrollTop;
        m.scrollTop = 0;
        const boxes = [...p.querySelectorAll("input[type=checkbox], input[type=radio]")] as HTMLInputElement[];
        const last = boxes.at(-1);
        if (!last) return { scrolled, boxes: 0 };
        last.focus();
        const pr = p.getBoundingClientRect();
        const ir = last.getBoundingClientRect();
        return { scrolled, boxes: boxes.length, focused: document.activeElement === last, scrollTop: m.scrollTop, inPanel: ir.top >= pr.top - 1 && ir.bottom <= pr.bottom + 1, box: Math.round(ir.top), panel: [Math.round(pr.top), Math.round(pr.bottom)] };
      });
      assert.equal(r.scrolled, 0, `${tab}: a script scrolled the frame to ${r.scrolled}px`);
      if (!r.boxes) continue;
      seen.push(tab);
      if (r.focused) {
        assert.equal(r.scrollTop, 0, `${tab}: focusing its last box scrolled the frame by ${r.scrollTop}px`);
        assert.ok(r.inPanel, `${tab}: its focused last box sits at ${r.box}, outside the list ${JSON.stringify(r.panel)}`);
      }
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    }
    assert.ok(seen.includes("models") && seen.includes("overseer"), `the sweep never reached a box on Models and Overseer (${seen.join(", ")})`);
  });
});
