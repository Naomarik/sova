#!/usr/bin/env node
// E2E: the Overseer's Approvals & Schedules live in its head, not its composer (§app.overseer/approvals,
// §app.overseer/head-layout, §chat.schedules/where-shown), and the composer's run-status row has two
// ends (§app.overseer/confirm).
//
// Drives a hermetic server — `pnpm run dev:hermetic` in THIS worktree (`pnpm run build` first), with
// SOVA_SCHEDULE_TICK_MS=2000 so the keeper is quick — through the playwright skill's own browser
// (start-browser.sh: an isolated Chromium on a freshly claimed CDP port, stopped at the end). It
// seeds, inside that server's agent dir only: a throwaway git project (in the OS temp dir) whose
// playbook has a `when:` line, so the keeper lists a schedule that needs approval; and, in the
// hermetic Overseer's own file, one input, one open card (c_1) and one standing rule (r_1) adopted
// from it with one use. No model runs and no prompt is sent. The script refuses a server whose
// files live anywhere but the expected agent dir, and never one under ~/.pi.
//
//   pnpm run build && SOVA_SCHEDULE_TICK_MS=2000 pnpm run dev:hermetic    # in one terminal
//   node scripts/e2e/overseer-schedules-menu.mjs                         # in another
//
// Env: SOVA_E2E_PORT (default 4810); SOVA_E2E_AGENT, the server's agent dir when it isn't
// <worktree>/.agent (a sandbox that mounts .agent read-only runs a copy elsewhere; still never
// ~/.pi); SOVA_E2E_SHOTS, a folder for screenshots; SOVA_E2E_CHROMIUM, a Chromium binary to launch
// directly when start-browser.sh cannot run (its state lives in /tmp). The playwright skill needs its node_modules
// (`npm ci` in .claude/skills/playwright/scripts, or a symlink to another checkout's).
//
// Not driven here: a turn's end (it needs a model). The dot follows the chat's one autonomy reading,
// which ChatView also refreshes at each turn's end; the script checks that the head makes no reading
// of its own (one /api/overseer/autonomy request per poll) and that the dot follows that poll.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tokenHeaders } from "../sova-token.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const AGENT = resolve(process.env.SOVA_E2E_AGENT ?? join(ROOT, ".agent"));
const PORT = Number(process.env.SOVA_E2E_PORT ?? 4810);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SOVA_E2E_SHOTS ?? null;
const SKILL = join(ROOT, ".claude/skills/playwright/scripts");

let passed = 0;
const failures = [];
let failShot = async () => {};
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    try {
      await failShot(name);
    } catch {}
    console.log(`  FAIL ${name}\n       ${String(err?.message ?? err).split("\n").join("\n       ")}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
const eq = (actual, expected, what) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const api = async (path, init) => {
  const r = await fetch(`${BASE}${path}`, { ...init, headers: { ...tokenHeaders(AGENT), "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${r.status} ${await r.text().catch(() => "")}`);
  return r.json();
};

// ---- preflight: the server is this worktree's hermetic one ----
const realPi = resolve(homedir(), ".pi");
if (AGENT === realPi || AGENT.startsWith(realPi + "/")) {
  console.error(`preflight: ${AGENT} is under ~/.pi: refusing to seed the real state`);
  process.exit(2);
}
try {
  const d = await api("/api/settings/decisions");
  assert(d.file.startsWith(AGENT + "/"), `the server on ${PORT} writes ${d.file}, not into ${AGENT}: start this worktree's hermetic server (pnpm run dev:hermetic), or name its dir in SOVA_E2E_AGENT`);
} catch (err) {
  console.error(`preflight: ${err.message}`);
  process.exit(2);
}
if (!existsSync(join(SKILL, "node_modules", "playwright"))) {
  console.error(`preflight: no playwright in ${SKILL}/node_modules — run npm ci there, or symlink another checkout's`);
  process.exit(2);
}

// ---- seed: a project whose playbook has a schedule ----
const project = mkdtempSync(join(tmpdir(), "sova-e2e-osm-"));
execFileSync("git", ["init", "-q", project]);
const playbookDir = join(project, ".sova", "playbooks", "nightly-check");
mkdirSync(playbookDir, { recursive: true });
writeFileSync(
  join(playbookDir, "PLAYBOOK.md"),
  "---\ntitle: Nightly check\ndescription: A throwaway schedule for the e2e.\nprofile: default\nwhen: every 6h\n---\n\n# Nightly check\n\nSay hello.\n",
);
const schedulesNow = async () => (await api("/api/schedules")).schedules.filter((s) => s.root === project);
await api(`/api/playbooks?cwd=${encodeURIComponent(project)}`); // the catalog registers it (Needs approval)
let schedule = (await schedulesNow())[0];
const cleanup = async () => {
  try {
    for (const s of await schedulesNow()) if (s.state === "active" || s.state === "paused") await api("/api/schedules/revoke", { method: "POST", body: JSON.stringify({ id: s.id }) }).catch(() => {});
  } catch {}
  rmSync(project, { recursive: true, force: true });
};

// ---- seed: the Overseer's file holds an input, an open card and a rule from it ----
// A fresh conversation every run (the hermetic Overseer only): live rules carry over a clear, so
// they are revoked first, and the seed lands in a file that holds nothing else.
for (const p of (await api("/api/overseer/autonomy")).permits.filter((x) => x.status === "live")) {
  await api("/api/overseer/autonomy/revoke", { method: "POST", body: JSON.stringify({ id: p.id }) });
}
const info = await api("/api/overseer/clear", { method: "POST" });
const ovPath = info.path;
assert(ovPath.startsWith(AGENT + "/"), `the Overseer's file ${ovPath} is outside ${AGENT}`);
{
  const lines = readFileSync(ovPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let parent = lines.at(-1).id ?? null;
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const ts = Date.parse(at);
  const put = (entry) => {
    const id = Math.random().toString(16).slice(2, 10);
    appendFileSync(ovPath, JSON.stringify({ ...entry, id, parentId: parent, timestamp: at }) + "\n");
    parent = id;
  };
  const card = {
    id: "c_1",
    title: "Keep the nightly check going?",
    options: [{ label: "Not Now" }, { label: "Always", reply: "Always send continue after a reset", rule: { text: "Send continue to a session after its usage limit resets", acts: ["sova_send"], anySession: true } }],
    items: [],
    phase: "open",
    rev: 1,
    createdAt: at,
    updatedAt: at,
  };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  put({ type: "message", message: { role: "user", content: [{ type: "text", text: "Should the nightly check keep going?" }], timestamp: ts } });
  // A long answer first, so the card sits a screen or more below the thread's top.
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. The nightly check looked at its sessions and found nothing new.`).join("\n\n");
  put({ type: "message", message: { role: "assistant", content: [{ type: "text", text: long }], api: "anthropic-messages", provider: "anthropic", model: "e2e", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: ts } });
  put({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I can keep it going: c_1 asks." }, { type: "toolCall", id: "call_osm_e2e", name: "sova_card", arguments: { ops: [{ op: "create", title: card.title }] } }], api: "anthropic-messages", provider: "anthropic", model: "e2e", usage, stopReason: "toolUse", timestamp: ts } });
  put({ type: "message", message: { role: "toolResult", toolCallId: "call_osm_e2e", toolName: "sova_card", content: [{ type: "text", text: "c_1 created" }], details: { v: 1, card, changes: [{ kind: "created" }], line: "created" }, isError: false, timestamp: ts } });
  put({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Asked in c_1." }], api: "anthropic-messages", provider: "anthropic", model: "e2e", usage, stopReason: "stop", timestamp: ts } });
  put({ type: "custom", customType: "overseer-rule", data: { v: 1, id: "r_1", card: "c_1", option: "b", label: "Always", createdAt: at, message: "m1", text: "Send continue to a session after its usage limit resets", acts: ["sova_send"], sessions: "any" } });
  put({ type: "custom", customType: "overseer-grant-use", data: { v: 1, id: "r_1", tool: "sova_send", sessions: [], toolCallId: "call_osm_e2e", at } });
  // Past the server's recent-write guard (120 s), so the page opens the chat, not a read-only watch.
  const old = new Date(Date.now() - 300_000);
  utimesSync(ovPath, old, old);
}

const skillRequire = createRequire(join(SKILL, "package.json"));
const { chromium } = skillRequire("playwright");
// SOVA_E2E_CHROMIUM=<binary>: launch it directly (temp profile under TMPDIR) instead of
// start-browser.sh, whose port claims and profiles live in /tmp, for a sandbox where /tmp is read-only.
const DIRECT = process.env.SOVA_E2E_CHROMIUM ?? null;
let cdpPort = null;
if (!DIRECT) try {
  const started = execFileSync(join(SKILL, "start-browser.sh"), ["--headless"], { cwd: SKILL, stdio: ["ignore", "pipe", "pipe"] }).toString();
  cdpPort = /PW_PORT=(\d+)/.exec(started)?.[1];
  if (!cdpPort) throw new Error(`start-browser.sh printed no PW_PORT:\n${started}`);
} catch (err) {
  await cleanup();
  throw err;
}
let browser = null;

try {
  browser = DIRECT ? await chromium.launch({ executablePath: DIRECT, headless: true }) : await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: "dark", extraHTTPHeaders: tokenHeaders(AGENT) });
  const page = await context.newPage();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const shot = async (name) => {
    if (!SHOTS) return;
    await page.waitForTimeout(350); // past the popover's fade-in
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  };
  failShot = async (name) => shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, "-")}`);
  let autonomyReads = 0;
  page.on("request", (r) => r.url().includes("/api/overseer/autonomy") && autonomyReads++);
  await page.goto(`${BASE}/`);
  await page.evaluate(async () => {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await r.unregister();
    for (const k of (await caches?.keys?.()) ?? []) await caches.delete(k);
  });
  await page.goto(`${BASE}/#/overseer`);
  await page.reload();
  const size = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    eq(await page.evaluate(() => innerWidth), w, "viewport width");
  };
  await size(390, 844);

  const head = page.locator(".overseer-page-head");
  const more = head.locator(".overseer-more");
  const schedulesBtn = head.locator(".overseer-schedules");
  const row = page.locator(".composer .run-status");
  const openPanel = page.locator(".action-menu:popover-open");
  /** The seed is an append the server didn't make, so the chat may open read-only: take it, as the
      page's own Chat Anyway does (this hermetic file has no other writer). */
  const takeChat = async () => {
    const anyway = page.getByRole("button", { name: "Chat Anyway" });
    await Promise.race([anyway.waitFor({ timeout: 15000 }), row.waitFor({ timeout: 15000 })]).catch(() => {});
    if (await anyway.isVisible().catch(() => false)) await anyway.click();
  };
  await check("the Overseer opens with its composer", async () => {
    await head.waitFor({ state: "visible", timeout: 30000 });
    await takeChat();
    await row.waitFor({ state: "visible", timeout: 30000 });
  });

  await check("the seeded schedule needs approval", async () => {
    for (let i = 0; i < 20 && !schedule; i++) {
      await page.waitForTimeout(500);
      schedule = (await schedulesNow())[0];
    }
    assert(schedule, "the keeper lists no schedule for the seeded project");
    eq(schedule.state, "needs-approval", "its state");
  });
  // The page's first autonomy read may predate the seed; the 15 s poll or a reload picks it up.
  await page.reload();
  await takeChat();
  await row.waitFor({ state: "visible", timeout: 30000 });
  await size(390, 844);
  await page.waitForFunction(() => !!document.querySelector(".overseer-more .overseer-attention-dot"), null, { timeout: 20000 }).catch(() => {});

  await check("no permits or schedules badge in the composer's status line", async () => {
    eq(await row.locator(".run-status-permits").count(), 0, "permits chips");
    const text = await row.innerText();
    assert(!/schedule|approval|rule/i.test(text), `the status line says: ${JSON.stringify(text)}`);
  });

  /** The row's laid-out children, left to right, with their boxes. */
  const rowParts = () =>
    row.evaluate((p) =>
      [...p.children]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).display !== "none")
        .map((el) => ({ cls: el.className, text: el.textContent.trim(), left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, end: p.getBoundingClientRect().right })),
    );
  const checkEnds = async (what) => {
    const parts = await rowParts();
    const right = parts.filter((x) => /run-status-(running|cards|align|inputs)/.test(x.cls));
    assert(right.length >= 2, `${what}: expected the card chip and inputs on the right, got ${JSON.stringify(parts.map((x) => x.text))}`);
    assert(/run-status-inputs/.test(right.at(-1).cls), `${what}: the last part is ${JSON.stringify(right.at(-1).text)}, not inputs`);
    assert(Math.abs(right.at(-1).right - right.at(-1).end) <= 1, `${what}: inputs ends ${right.at(-1).end - right.at(-1).right}px short of the row's end`);
    for (let i = 1; i < right.length; i++) {
      const gap = right[i].left - right[i - 1].right;
      assert(gap <= 12, `${what}: ${gap}px between ${JSON.stringify(right[i - 1].text)} and ${JSON.stringify(right[i].text)}: something floats mid-row`);
    }
    eq(await row.locator(".run-status-lead").count(), 1, `${what}: the parts taking the auto margin`);
  };
  await check("390: the status line's right cluster is contiguous, inputs last at the row's end", () => checkEnds("390"));
  await row.screenshot({ path: SHOTS ? join(SHOTS, "390-status-line.png") : undefined }).catch(() => {});

  await check("390: ⋯ carries the dot and says why", async () => {
    await more.locator(".overseer-attention-dot").waitFor({ state: "visible", timeout: 20000 });
    eq(await more.getAttribute("aria-label"), "Overseer actions, 1 schedule needs approval", "⋯'s name");
  });
  await shot("390-head-dot");

  await check("390: ⋯'s first row is Approvals & Schedules…, noting what needs you", async () => {
    await more.click();
    await openPanel.waitFor({ state: "visible", timeout: 5000 });
    const first = openPanel.getByRole("menuitem").first();
    eq(await first.locator(".popover-item-label").innerText(), "Approvals & Schedules…", "first row");
    eq(await first.locator(".popover-item-desc").innerText(), "1 needs approval", "its note");
  });
  await shot("390-more-menu-waiting");

  await check("390: the row opens the screen: the rule, its use, the schedule and Approve Schedule", async () => {
    await openPanel.getByRole("menuitem", { name: /^Approvals & Schedules/ }).click();
    await openPanel.locator(".permits-body").waitFor({ state: "visible", timeout: 5000 });
    assert(await openPanel.getByRole("region", { name: /^r_1/ }).isVisible(), "r_1's section");
    assert(await openPanel.getByRole("button", { name: "Approve Schedule" }).isVisible(), "Approve Schedule");
    assert(await openPanel.getByRole("button", { name: "Revoke Rule" }).isVisible(), "Revoke Rule");
  });
  await shot("390-approvals-screen-waiting");

  await check("390: a card link closes the menu, then scrolls the conversation to the card", async () => {
    // Scroll the thread to its top, so the card is off screen and only the jump can bring it back.
    const card = page.locator('[data-card-id="c_1"]').last();
    const inView = async () => {
      const b = await card.boundingBox();
      return !!b && b.y + b.height > 0 && b.y < 844;
    };
    await page.keyboard.press("Escape");
    await card.evaluate((el) => {
      let s = el.parentElement;
      while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      s?.scrollTo(0, 0);
    });
    await page.waitForTimeout(400);
    assert(!(await inView()), "the card is still on screen after scrolling the thread to its top");
    await more.click();
    await openPanel.getByRole("menuitem", { name: /^Approvals & Schedules/ }).click();
    await openPanel.getByRole("button", { name: "c_1 b" }).click();
    await page.waitForTimeout(600);
    eq(await page.locator(".action-menu:popover-open").count(), 0, "menus open after the jump");
    assert(await inView(), `the card is off screen after the jump: ${JSON.stringify(await card.boundingBox())}`);
  });

  await check("390: an act link closes the menu, then scrolls to the act", async () => {
    await more.click();
    await openPanel.getByRole("menuitem", { name: /^Approvals & Schedules/ }).click();
    await openPanel.locator(".permit-uses .permit-link").first().click();
    await page.waitForTimeout(600);
    eq(await page.locator(".action-menu:popover-open").count(), 0, "menus open after the jump");
  });

  // ---- wide: Schedules ▾ next to History, no ⋯ ----
  await size(1280, 800);
  await check("1280: Schedules ▾ sits on the row with the dot; ⋯ is gone", async () => {
    assert(await schedulesBtn.isVisible(), "Schedules ▾ visible");
    assert(!(await more.isVisible()), "⋯ hidden");
    assert(await schedulesBtn.locator(".overseer-attention-dot").isVisible(), "its dot");
    eq(await schedulesBtn.getAttribute("aria-label"), "Approvals and schedules, 1 schedule needs approval", "its name");
  });
  await shot("1280-head-dot");
  await check("1280: Schedules ▾ opens the same screen as a dropdown", async () => {
    await schedulesBtn.click();
    await openPanel.locator(".permits-body").waitFor({ state: "visible", timeout: 5000 });
    assert(await openPanel.getByRole("button", { name: "Approve Schedule" }).isVisible(), "Approve Schedule");
  });
  await shot("1280-schedules-dropdown-waiting");

  await check("Approve Schedule clears the dot at once (no 15 s wait)", async () => {
    const t0 = Date.now();
    await openPanel.getByRole("button", { name: "Approve Schedule" }).click();
    await schedulesBtn.locator(".overseer-attention-dot").waitFor({ state: "detached", timeout: 5000 });
    assert(Date.now() - t0 < 5000, "took too long");
    eq(await schedulesBtn.getAttribute("aria-label"), "Approvals and schedules", "its name after");
    eq((await schedulesNow())[0]?.state, "active", "the schedule's state");
  });
  await shot("1280-schedules-dropdown-approved");
  await page.keyboard.press("Escape");
  await check("1280: the status line has the same two ends", () => checkEnds("1280"));
  await row.screenshot({ path: SHOTS ? join(SHOTS, "1280-status-line.png") : undefined }).catch(() => {});

  /** Every control in the head lies inside its box and the head doesn't scroll sideways. */
  const noClip = async (w) => {
    await size(w, 800);
    const r = await head.evaluate((h) => {
      const box = h.getBoundingClientRect();
      const out = [...h.querySelectorAll(":scope > *")]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).display !== "none")
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.left < box.left - 0.5 || b.right > box.right + 0.5;
        })
        .map((el) => el.className);
      const title = h.querySelector(".session-head-title");
      return { scroll: h.scrollWidth - h.clientWidth, out, titleCut: title ? title.scrollWidth > title.clientWidth + 0.5 : null };
    });
    assert(r.scroll <= 0 && !r.out.length && !r.titleCut, `${w}px: ${JSON.stringify(r)}`);
  };
  for (const w of [1600, 1000, 950, 920, 900, 899, 700, 390, 344, 320]) await check(`head fits at a ${w}px window (no clip, title whole)`, () => noClip(w));
  // The tiers go by the head's own width: find windows that put the HEAD at 900–1000px.
  await check("head fits with Schedules ▾ on the row while the head itself is 900–1000px wide", async () => {
    const seen = [];
    for (let w = 1100; w <= 1500; w += 20) {
      await noClip(w);
      const hw = await head.evaluate((h) => h.getBoundingClientRect().width - parseFloat(getComputedStyle(h).paddingLeft) - parseFloat(getComputedStyle(h).paddingRight));
      if (hw >= 900 && hw <= 1000) {
        assert(await schedulesBtn.isVisible(), `Schedules ▾ hidden at a ${hw}px head`);
        seen.push(Math.round(hw));
      }
    }
    assert(seen.length >= 2, `no window put the head at 900–1000px (${JSON.stringify(seen)})`);
    console.log(`       head widths checked: ${seen.join(", ")}`);
  });
  await size(1280, 800);

  await size(390, 844);
  await check("390: after approval, ⋯ has no dot and its row notes the counts", async () => {
    assert((await more.locator(".overseer-attention-dot").count()) === 0, "no dot");
    eq(await more.getAttribute("aria-label"), "Overseer actions", "⋯'s name");
    await more.click();
    const n = (await api("/api/schedules")).schedules.length;
    eq(await openPanel.getByRole("menuitem").first().locator(".popover-item-desc").innerText(), `1 rule · ${n} schedule${n === 1 ? "" : "s"}`, "its note");
  });
  await shot("390-more-menu-approved");
  await openPanel.getByRole("menuitem", { name: /^Approvals & Schedules/ }).click();
  await shot("390-approvals-screen-approved");
  await page.keyboard.press("Escape");

  await check("the head reads no autonomy of its own, and its dot follows the chat's 15 s poll", async () => {
    // Revoked outside the page: the schedule needs approval again, and only the poll can tell.
    await api("/api/schedules/revoke", { method: "POST", body: JSON.stringify({ id: schedule.id }) });
    const before = autonomyReads;
    const t0 = Date.now();
    await more.locator(".overseer-attention-dot").waitFor({ state: "visible", timeout: 17000 });
    const waited = Date.now() - t0;
    await page.waitForTimeout(16000 - Math.min(waited, 16000));
    const reads = autonomyReads - before;
    assert(reads >= 1 && reads <= 2, `${reads} autonomy reads in 16 s: the head is polling too, or nothing is`);
  });
  await shot("390-head-dot-after-poll");

  await check("an earlier conversation's head has neither the row nor Schedules ▾", async () => {
    // A clear makes this conversation an earlier one (the hermetic Overseer only).
    const was = (await api("/api/overseer")).id;
    await api("/api/overseer/clear", { method: "POST" });
    await page.goto(`${BASE}/#/overseer/h/${encodeURIComponent(was)}`);
    await size(390, 844);
    await head.getByRole("heading", { name: "Earlier Overseer Conversation" }).waitFor({ timeout: 20000 });
    eq(await more.getAttribute("aria-label"), "Overseer actions", "⋯'s name");
    await more.click();
    eq(await openPanel.getByRole("menuitem").allInnerTexts().then((t) => t.map((x) => x.split("\n")[0])), ["History…"], "⋯'s rows");
    await page.keyboard.press("Escape");
    await size(1280, 800);
    eq(await head.locator(".overseer-schedules").count(), 0, "Schedules ▾ on the earlier head");
  });
  await shot("1280-earlier-conversation-head");
} finally {
  await browser?.close().catch(() => {});
  try {
    if (cdpPort) execFileSync(join(SKILL, "stop-browser.sh"), [], { cwd: SKILL, env: { ...process.env, PW_PORT: cdpPort }, stdio: "ignore" });
  } catch {}
  await cleanup();
}

console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `: ${failures.join("; ")}` : ""}`);
process.exit(failures.length ? 1 : 0);
