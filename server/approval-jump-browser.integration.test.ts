// A new chat's screen holds still through a decision (§chat.context-approval), in a real browser against a
// throwaway server: a project with several skills waiting (asking mode), a new chat, System context open
// and scrolled down to a row. Approve on it saves to the folder's list, which rebuilds the chat: its socket
// says hello again and the page reads the setup again. Afterwards the clicked row is the same element at
// the same place on screen, and the view didn't move. Before the fix the hello cleared the chat's profile
// (the page lost its height) and the empty screen's "read from the top" ran again: the view went to the
// top. In the "forms" harness (build, hermetic server, Chrome, a signed-in page); Chrome or Chromium must
// be installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assertOwnRepo, formsBrowser, until } from "./forms-browser.test.helper";

const h = formsBrowser("sova-approval-jump-browser-", { width: 1280, height: 720 });

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${h.s.base}${path}`, { method, headers: { "x-sova-token": h.s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: (await r.json()) as any };
};

/** A project of its own with eight skills and a context file, registered. */
async function project(): Promise<string> {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "jump-proj-"));
  for (const s of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]) {
    mkdirSync(join(root, ".agents", "skills", s), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: The ${s} skill.\n---\n# ${s}\nBody of ${s}.\n`);
  }
  writeFileSync(join(root, "AGENTS.md"), "# Agents\nRules.\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "init");
  assertOwnRepo(root);
  assert.equal((await api("POST", "/api/projects", { root, name: "jumpproj" })).status, 201);
  return root;
}

describe("a new chat's decision in a browser", { timeout: 240_000, skip: h.skip }, () => {
  test("Approve while scrolled down: the clicked row stays the same element, where it was, through the hello and the re-read", async () => {
    const { page, s } = h;
    const root = await project();
    assert.equal((await api("PUT", "/api/settings/context-approval", { allowWithoutAsking: false })).status, 200);
    const ses = (await api("POST", "/api/sessions", { cwd: root })).body as { id: string; path: string };

    // In order, as they come: each hello on the chat's socket, and each read of its setup answered.
    const seen: ("hello" | "read")[] = [];
    page.on("websocket", (ws) => ws.on("framereceived", (f) => void (typeof f.payload === "string" && f.payload.includes('"type":"hello"') && seen.push("hello"))));
    page.on("response", (r) => void (r.url().includes("/api/sessions/context?") && seen.push("read")));
    await page.goto("about:blank");
    // By its id: a chat before its first message isn't on the list yet.
    await page.goto(`${s.base}/#/sid/${encodeURIComponent(ses.id)}`);
    await page.locator(".setup-card").waitFor({ timeout: 30_000 }).catch(async (e) => {
      throw new Error(`${e}\nURL ${page.url()}\n${(await page.locator("body").innerText()).slice(0, 1500)}`);
    });
    // By its label: inside the closed System context fold it isn't in the accessibility tree yet.
    const button = page.locator('button[aria-label="Approve delta"]');
    await button.waitFor({ state: "attached", timeout: 30_000 });
    if (!(await page.locator("details.setup-context").evaluate((d) => (d as HTMLDetailsElement).open))) await page.locator("summary.setup-context-head").click();
    await button.waitFor({ timeout: 15_000 });
    await until("the chat's first hello", async () => seen.includes("hello"), 30_000);

    await button.evaluate((b) => b.scrollIntoView({ block: "center" }));
    const pane = page.locator(".transcript.pane");
    const row = await button.evaluateHandle((b) => b.closest("li.setup-row")!);
    const read = () => Promise.all([pane.evaluate((e) => e.scrollTop), row.evaluate((r) => Math.round((r as HTMLElement).getBoundingClientRect().top))]);
    const [topBefore, rowBefore] = await read();
    assert.ok(topBefore > 200, `scrolled well down (scrollTop ${topBefore})`);

    const saved = page.waitForResponse((r) => r.url().includes("/api/folder-approvals") && r.request().method() === "PUT", { timeout: 60_000 });
    const mark = seen.length;
    await button.click();
    assert.equal((await saved).status(), 200);
    // The rebuild's hello, then a read of the setup that started after it, then the page settled.
    await until("the rebuild's hello, then a read after it", async () => {
      const after = seen.slice(mark);
      const hello = after.indexOf("hello");
      return hello >= 0 && after.indexOf("read", hello) > hello;
    }, 30_000, async () => JSON.stringify(seen.slice(mark)));
    await until("the decision saved: its buttons gone, Saving… cleared", async () => (await button.count()) === 0 && !(await page.locator(".composer-reason").innerText()).includes("Saving"), 30_000);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const [topAfter, rowAfter] = await read();
    // Measured 1019 → 1026: the composer's line under the pane changes the pane's height, and the
    // browser keeps what is on screen in place. The jump was to 0; the row's place on screen is exact.
    assert.ok(Math.abs(topAfter - topBefore) <= 16, `the view jumped: scrollTop ${topBefore} → ${topAfter}`);
    const now = await page.locator("li.setup-row", { has: page.locator(".setup-open", { hasText: /^delta$/ }) }).evaluate((r) => Math.round(r.getBoundingClientRect().top));
    assert.ok(Math.abs(now - rowBefore) <= 2, `the clicked row moved on screen: ${rowBefore} → ${now} (scrollTop ${topBefore} → ${topAfter})`);
    assert.equal(await row.evaluate((r) => r.isConnected), true, "the clicked row was rebuilt: its element is gone");
    assert.ok(Math.abs(rowAfter - rowBefore) <= 2, `the clicked row's element moved: ${rowBefore} → ${rowAfter}`);
    console.log(`held: scrollTop ${topBefore} → ${topAfter}, clicked row at ${rowBefore} → ${rowAfter}`);
  });
});
