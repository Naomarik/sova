// The merge thread's Run Logs chip in a real browser (§app.merge-queue/run-logs), against a throwaway server:
// a served project, its merge thread's chat and 18 finished runs are seeded on disk. Clean Logs… shows its
// confirmation in place (the step swap removes the focused button, and Chrome reports focus leaving to nowhere,
// which once closed the popover), focus moves to Cancel, Cancel returns, Escape closes from either step and
// gives focus back to the chip, a click outside closes it, the chip is named "Run logs <size>" with its label
// hidden on a phone width, and a clean shows one toast. In the "forms" harness: build, hermetic server, Chrome,
// a signed-in page. Chrome or Chromium must be installed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { formsBrowser, until } from "./forms-browser.test.helper";

const h = formsBrowser("sova-run-logs-chip-browser-", { width: 390, height: 844 });

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${h.s.base}${path}`, { method, headers: { "x-sova-token": h.s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, body: (await r.json()) as any };
};

/** A served project (checks declared, on the Projects list), its merge thread's chat and 18 finished runs. */
async function seed(): Promise<{ sid: string; path: string }> {
  const { s } = h;
  const proj = join(s.scratch, "run-logs-proj");
  mkdirSync(join(proj, ".sova"), { recursive: true });
  writeFileSync(join(proj, ".sova", "project.json"), JSON.stringify({ version: 1, merge: { checks: [{ id: "unit", label: "Unit", run: ["true"], timeout: 60 }] } }));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: proj, stdio: "pipe" });
  git("init", "-q", "-b", "master");
  git("add", ".");
  git("commit", "-qm", "init");

  const state = join(s.agentDir, "sova");
  const runs = join(state, "merge-queue", createHash("sha256").update(proj).digest("hex").slice(0, 16), "runs");
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  for (let i = 0; i < 18; i++) {
    const at = t0 + i * 3_600_000;
    const id = `mr_${at.toString(36)}${i.toString(16).padStart(8, "0")}`;
    mkdirSync(join(runs, id, "logs"), { recursive: true });
    writeFileSync(join(runs, id, "logs", "01-check_unit.log"), `${"a log line of the unit check\n".repeat(4000)}`);
    const run = { id, entry: "mq_x", project: "p", branch: "feat/x", base: "a".repeat(40), commit: "b".repeat(40), steps: [{ id: "check:unit", kind: "check", label: "Unit", result: "passed", log: "logs/01-check_unit.log" }], checks: [], verdict: "passed", startedAt: new Date(at).toISOString(), endedAt: new Date(at + 60_000).toISOString() };
    writeFileSync(join(runs, id, "run.json"), JSON.stringify(run));
  }

  const sid = randomUUID();
  const now = Date.now();
  const iso = (k: number) => new Date(now - 60_000 + k * 1000).toISOString();
  const dir = join(s.agentDir, "sessions", `--${proj.replace(/^\//, "").replace(/\//g, "-")}--`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${iso(0).replace(/[:.]/g, "-")}_${sid}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: sid, timestamp: iso(0), cwd: proj },
    { type: "custom", customType: "sova-profile", data: { v: 1, profile: { id: "merge-thread", label: "Merge thread", icon: "git-merge", source: "sova" } }, id: "e1", parentId: null, timestamp: iso(1) },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "You are the merge thread." }], timestamp: now - 50_000 }, id: "e2", parentId: "e1", timestamp: iso(2) },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  writeFileSync(join(state, "merge-queue", "threads.json"), JSON.stringify({ version: 1, threads: { [proj]: { sessionId: sid, startedAt: now - 60_000 } } }));
  assert.equal((await api("POST", "/api/projects", { root: proj, name: "RunLogs" })).status, 201);
  await until("the chat answers as the merge thread", async () => (await api("GET", `/api/merge-queue/run-logs?session=${sid}`)).body?.cleanable?.runs === 8, 30_000);
  return { sid, path };
}

describe("the Run Logs chip in a browser", { timeout: 240_000, skip: h.skip }, () => {
  test("Clean Logs… confirms in place; Cancel, Escape and a click outside; one toast after a clean", async () => {
    const { page, s } = h;
    const { path } = await seed();
    const active = () => page.evaluate(() => `${(document.activeElement?.textContent ?? "").trim()}|${document.activeElement?.className ?? ""}`);
    await page.goto(`${s.base}/#/s/${encodeURIComponent(path)}`);
    const chip = page.locator("header .run-logs-chip").first();
    await chip.waitFor({ timeout: 30_000 });

    // On a phone width the label is hidden; the name still says what the chip is.
    assert.equal(await page.locator(".run-logs-chip-label").first().isVisible(), false, "the label is hidden at 390px");
    assert.match((await chip.getAttribute("aria-label")) ?? "", /^Run logs \d+(\.\d+)? (B|KB|MB|GB)$/);

    await chip.click();
    await page.locator(".run-logs-popover").waitFor();
    await page.getByRole("button", { name: "Clean Logs…" }).click();
    await until("the confirmation shows", async () => (await page.locator(".run-logs-confirm").count()) === 1);
    // Focus moves in one task after the swap; the popover must still be there once it has settled.
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".run-logs-popover").count(), 1, "the popover stays open");
    assert.match(await active(), /^Cancel\|/);

    await page.getByRole("button", { name: "Cancel" }).click();
    await until("back on the first step", async () => (await page.locator(".run-logs-confirm").count()) === 0);
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".run-logs-popover").count(), 1, "Cancel keeps the popover open");
    assert.match(await active(), /^Clean Logs…\|/);

    // The keyboard: Enter confirms in place, Escape closes and gives focus back to the chip.
    await page.keyboard.press("Enter");
    await until("the confirmation by keyboard", async () => (await page.locator(".run-logs-confirm").count()) === 1);
    await page.keyboard.press("Escape");
    await until("Escape closes from the confirmation", async () => (await page.locator(".run-logs-popover").count()) === 0);
    assert.match(await active(), /run-logs-chip/);
    await page.keyboard.press("Enter");
    await page.locator(".run-logs-popover").waitFor();
    await page.keyboard.press("Escape");
    await until("Escape closes from the first step", async () => (await page.locator(".run-logs-popover").count()) === 0);

    await chip.click();
    await page.locator(".run-logs-popover").waitFor();
    await page.mouse.click(195, 600);
    await until("a click outside closes it", async () => (await page.locator(".run-logs-popover").count()) === 0);

    // The clean itself: one toast, the chip's size drops, focus back on the chip.
    const before = await chip.getAttribute("aria-label");
    await chip.click();
    await page.getByRole("button", { name: "Clean Logs…" }).click();
    await page.locator(".run-logs-confirm").waitFor();
    await page.getByRole("button", { name: "Clean Logs", exact: true }).click();
    await page.locator(".toast", { hasText: "Cleaned the logs of 8 runs" }).first().waitFor({ timeout: 15_000 });
    await until("the chip's size drops", async () => (await chip.getAttribute("aria-label")) !== before);
    assert.equal(await page.locator(".toast-stack .toast").count(), 1, "one toast");
    assert.match(await active(), /run-logs-chip/);
  });
});
