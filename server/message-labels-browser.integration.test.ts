// Message labels end to end in a real browser (§app/message-labels), against a throwaway server, with no
// provider set: the switch off, a typed message shows no Your Messages; turned on in Settings → Decisions, a
// message typed and sent from the composer shows under Not Labelled in the session pane's Time Spent tab,
// with the seconds the page counted. Turned off again, the whole section goes. In the "forms" harness:
// build, hermetic server, Chrome, a signed-in page. Chrome or Chromium must be installed.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formsBrowser, until } from "./forms-browser.test.helper";

const h = formsBrowser("sova-message-labels-browser-");

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${h.s.base}${path}`, { method, headers: { "x-sova-token": h.s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: (await r.json()) as any };
};
const record = async (path: string) => (await api("GET", `/api/time-spent?path=${encodeURIComponent(path)}`)).body;

/** A new chat open in the page, with a message typed and sent from its composer. */
async function sendTyped(text: string): Promise<string> {
  const { page, s } = h;
  const ses = (await api("POST", "/api/sessions", { cwd: s.work })).body as { path: string };
  // A chat joins the list with its first message, which is the program's here and not typed.
  assert.equal((await api("POST", "/api/sessions/prompt", { path: ses.path, text: "hello there" })).status < 300, true);
  await until("the first reply on disk", async () => (await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}`)).body.items?.some((i: any) => i.kind === "assistant-text"), 30_000);
  await page.goto("about:blank");
  await page.goto(`${s.base}/#/s/${encodeURIComponent(ses.path)}`);
  const box = page.getByPlaceholder("Enter sends");
  await box.waitFor({ timeout: 30_000 });
  await box.click();
  await box.pressSequentially(text);
  await box.press("Enter");
  await page.locator(".entry", { hasText: text }).first().waitFor({ timeout: 30_000 });
  return ses.path;
}
async function showTimeTab() {
  const { page } = h;
  await page.locator(".session-details-open").first().click();
  await page.locator("#session-tab-time").click();
  await page.locator("[data-time-you]").waitFor({ timeout: 30_000 });
}

describe("message labels in a browser", { timeout: 240_000, skip: h.skip }, () => {
  test("off: no Your Messages; on in Settings: a sent message is under Not Labelled; off again: the section goes", async () => {
    const { page, s } = h;
    await sendTyped("Before the switch went on.");
    await showTimeTab();
    assert.equal(await page.getByText("Your Messages").count(), 0, "off by default");

    await page.goto("about:blank");
    await page.goto(`${s.base}/#/settings/decisions`);
    const dialog = page.locator('[role="dialog"]:has(#settings-foot-status)');
    await dialog.waitFor({ timeout: 30_000 });
    const box = dialog.getByRole("checkbox", { name: /Label your messages/ });
    await box.waitFor({ state: "attached", timeout: 15_000 });
    assert.equal(await box.isChecked(), false, "off until turned on");
    await box.evaluate((e) => (e.closest("label") as HTMLElement).click());
    await dialog.getByRole("button", { name: "Save Changes", exact: true }).click();
    await until("the switch saved", async () => (await api("GET", "/api/settings/decisions")).body.settings.features.messageLabels === true);

    const words = "Move the discount above the tax line, please.";
    const path = await sendTyped(words);
    await showTimeTab();
    // Input keeps the page counting; the server has the seconds at the page's next report.
    const row = page.locator('button[data-time-row="not-labelled"]');
    await until("the message under Not Labelled", async () => {
      await page.mouse.move(400 + Math.random() * 40, 300);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      return (await row.count()) === 1;
    }, 60_000);
    assert.equal(await page.getByText("Your Messages", { exact: true }).count(), 1);
    await row.click();
    assert.match((await page.locator("[data-time-message]").allInnerTexts()).join("\n"), /Move the discount above the tax line/);
    assert.equal(await page.locator("[data-time-labelled-by]").count(), 0, "nobody labelled it");
    const read = await record(path);
    assert.deepEqual(read.messages.rows.map((r: any) => r.key), ["not-labelled"]);

    const settings = (await api("GET", "/api/settings/decisions")).body.settings;
    assert.equal((await api("PUT", "/api/settings/decisions", { ...settings, features: { ...settings.features, messageLabels: false } })).status, 200);
    await until("the section gone", async () => {
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      return (await page.getByText("Your Messages", { exact: true }).count()) === 0;
    });
    assert.equal((await record(path)).messages, undefined);
  });
});
