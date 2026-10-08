#!/usr/bin/env node
// pnpm run screens [-- --shot <id> ...] [--all] [--keep] [--node] [--no-browser]
//
// Check the story, seed a fresh throwaway root, start the director and a hermetic Sova on it, play
// each live session to its holds and photograph the shots there (dark theme), with the leak gate
// before every one. Writes lossless WebP masters to site/src/assets/screens/ and their
// manifest.json (alt, size, slot, input hash). Stops everything it started; removes the root
// unless --keep.
//
//   --shot <id>   only these shots (repeatable); the manifest keeps the others' entries
//   --all         rewrite every image even when its input hash is unchanged
//   --node        run the server on Node instead of Bun
//   --no-browser  play the live sessions over the REST API only and report the director's state:
//                 a check of story + director + Sova where no browser can start

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, loadStory, REPO, whereIn } from "./load-story.mjs";
import { actionOf, text } from "./story-check.mjs";
import { FREEZE_CSS, saveDebug, leakGate, leakPatterns, makeRoot, OUT_DIR, removeRoot, sleep, startBrowser, startDirector, startServer, TOKEN, contextOptions, waitFor, writeJson } from "./harness.mjs";
import { loadAlignModule, seed, titleStatic } from "./seed.mjs";
import { fileSha, inputHashes } from "./hashes.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const only = args.flatMap((a, i) => (args[i - 1] === "--shot" ? [a] : []));
const MANIFEST = join(OUT_DIR, "manifest.json");

const { plan, story, warnings } = await loadStory().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
for (const w of warnings) console.warn(`warning: ${w.pointer}: ${w.message}`);
await loadAlignModule();

for (const id of only) if (!plan.shots.some((s) => s.id === id)) throw new Error(`no shot "${id}" in story.json`);
const wanted = plan.shots.filter((s) => !only.length || only.includes(s.id));

// ---- input hashes: a shot is retaken only when what it shows could have changed --------------

const hashes = inputHashes(story, plan);
const inputHash = (shot) => hashes[shot.id];
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { shots: {} };
const todo = wanted.filter((s) => flag("--all") || flag("--no-browser") || manifest.shots?.[s.id]?.hash !== inputHash(s) || !existsSync(join(OUT_DIR, manifest.shots[s.id].file)));
if (!todo.length) {
  console.log("every shot is up to date (input hashes match manifest.json); --all retakes them");
  process.exit(0);
}
console.log(`shots to take: ${todo.map((s) => s.id).join(", ")}`);

// ---- the run ----------------------------------------------------------------------------------

const root = makeRoot();
const stops = [];
let failed = false;
try {
  const director = await startDirector(root, { chunkMs: 4 });
  stops.push(director.stop);
  const seeded = await seed(plan, root, { directorPort: director.port });
  const server = await startServer(root, { node: flag("--node") });
  stops.push(server.stop);
  await titleStatic(server, plan, seeded);
  console.log(`root ${root}\nserver ${server.base}, director ${director.url}`);

  const patterns = leakPatterns(root);
  let browser = null;
  if (!flag("--no-browser")) {
    browser = await startBrowser();
    stops.push(browser.stop);
  }
  const results = {};

  const sessionPath = new Map(Object.entries(seeded.sessions)); // story id -> file path
  const shotsAt = (session, at) => todo.filter((s) => s.session === session && s.at === at);
  const take = async (shot) => {
    if (!browser) return console.log(`  (no browser) would shoot ${shot.id}`);
    results[shot.id] = await shoot(browser.browser, server, shot, { sessionPath, patterns, root });
    console.log(`  shot ${shot.id}: ${results[shot.id].width}x${results[shot.id].height}`);
  };

  // Static sessions and pages first, while nothing is live.
  for (const shot of todo.filter((s) => s.at === "start")) await take(shot);

  // Each live session in story order, its holds in the order the story reaches them.
  for (const s of plan.sessions.filter((x) => x.live)) {
    const mine = todo.filter((x) => x.session === s.id);
    if (!mine.length) continue;
    console.log(`playing ${s.id}`);
    const created = await server.call("POST", "/api/sessions", { cwd: seeded.repo });
    sessionPath.set(s.id, created.path);
    await director.api.pace(4);
    await fetch(`${director.url}/bind`, { method: "POST", body: JSON.stringify({ id: s.id, uuid: created.id }) });
    await server.call("POST", "/api/sessions/configure", {
      path: created.path,
      model: s.model,
      ...(s.effort ? { thinking: s.effort } : {}),
      mode: s.modes.includes("delegate") ? "delegate" : "normal",
      minorModes: s.modes.filter((m) => m !== "delegate"),
    });
    await server.call("POST", "/api/sessions/title", { path: created.path, title: s.title });
    await server.call("POST", `/api/sandbox?path=${encodeURIComponent(created.path)}`, { state: "off" }).catch((e) => console.warn(`  sandbox off: ${e.message}`));

    for (const ev of events(s.id)) {
      if (ev.user !== undefined) {
        await server.call("POST", "/api/sessions/prompt", { path: created.path, text: ev.user });
        continue;
      }
      await director.api.reached(ev.hold, 180_000);
      await sleep(400);
      console.log(`  at ${ev.hold}: ${JSON.stringify((await director.api.state()).scenes)}`);
      for (const shot of shotsAt(s.id, ev.hold)) await take(shot);
      await director.api.release(ev.hold);
    }
    await director.api.idle(s.id, 180_000);
    await waitFor(async () => !(await server.call("GET", "/api/sessions")).find((x) => x.path === created.path)?.streaming, { timeout: 30_000, what: `${s.id} to finish its turn` }).catch(() => {});
    await sleep(800);
    for (const shot of shotsAt(s.id, "end")) await take(shot);
    const st = await director.api.state();
    const failedCalls = [...st.errors.map((e) => `  ${e.where}: ${e.tool}: ${e.message}`), ...toolErrors(seeded.agent)];
    if (failedCalls.length) throw new Error(`a scripted tool call failed:\n${[...new Set(failedCalls)].join("\n")}`);
  }

  // The Overseer: its model set, its first message typed on its page, then its end shot.
  const oshots = todo.filter((s) => s.session === "overseer");
  if (oshots.length && plan.overseer && browser) {
    await server.call("PUT", "/api/settings/overseer", { ...(await server.call("GET", "/api/settings/overseer")).settings, model: plan.overseer.model, thinking: plan.overseer.effort });
    const ctx = await newContext(browser.browser, "compact");
    const page = await open(ctx, server, "#/overseer");
    await typeAndSend(page, plan.scenes.find((x) => x.id === "overseer").users[0].text, 0);
    await director.api.idle("overseer", 120_000);
    await sleep(1500);
    await ctx.close();
    for (const shot of oshots) await take(shot);
  } else if (oshots.length) console.log("  (no browser) the Overseer is played only in the browser: skipped");

  const st = await director.api.state();
  console.log(`director: ${JSON.stringify(st.scenes)}; unmatched ${st.unmatched.length}; side calls ${st.side}`);
  if (st.unmatched.length) console.warn(`unmatched requests: ${JSON.stringify(st.unmatched)}`);
  const failedCalls = [...st.errors.map((e) => `  ${e.where}: ${e.tool}: ${e.message}`), ...toolErrors(seeded.agent)];
  if (failedCalls.length) throw new Error(`a scripted tool call failed:\n${[...new Set(failedCalls)].join("\n")}`);

  if (browser) {
    // The manifest: every shot of the story, the ones not retaken kept as they were.
    const next = { _generated: "by site/scripts/screens (pnpm run screens); edit story.json instead", shots: {}, slots: plan.pageShots, ...(manifest.video ? { video: manifest.video } : {}) };
    for (const shot of plan.shots) {
      const r = results[shot.id];
      if (r) next.shots[shot.id] = { file: r.file, width: r.width, height: r.height, viewport: shot.viewport, alt: shot.alt, hash: inputHash(shot), sha: r.sha, bytes: r.bytes };
      else if (manifest.shots?.[shot.id]) next.shots[shot.id] = { ...manifest.shots[shot.id], alt: shot.alt };
    }
    writeJson(MANIFEST, next);
    console.log(`wrote ${Object.keys(results).length} image(s) and ${MANIFEST.slice(REPO.length + 1)}`);
  }
} catch (e) {
  failed = true;
  console.error(`\ncapture failed: ${e.stack ?? e.message}`);
  console.error(`logs: ${join(root, "logs")}${flag("--keep") ? "" : " (pass --keep to keep them)"}`);
} finally {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  if (!flag("--keep")) removeRoot(root);
  else console.log(`kept ${root}`);
}
process.exit(failed ? 1 : 0);

// ---- helpers ----------------------------------------------------------------------------------

/** Every scripted call that failed, read from the session files themselves (the tool result's
    isError, which the chat API never shows the director), as story.json:LINE:COL lines. */
function toolErrors(agentDir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl"))
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (!line.includes("\"isError\":true")) continue;
          let m;
          try { m = JSON.parse(line).message; } catch { continue; }
          const hit = /^call_(.+)_(\d+)_(\d+)$/.exec(m?.toolCallId ?? "");
          if (!hit) continue;
          const scene = plan.scenes.find((s) => s.id === hit[1].replace(/_/g, "-"));
          const call = scene?.replies[Number(hit[2])]?.calls[Number(hit[3])];
          const msg = (m.content ?? []).map((c) => c.text ?? "").join("").replace(/\s+/g, " ").slice(0, 300);
          out.push(`  ${call ? `${whereIn(plan, call.pointer)} ${call.pointer}` : m.toolCallId}: ${m.toolName}: ${msg}`);
        }
    }
  };
  walk(join(agentDir, "sessions"));
  return out;
}

/** A live session's user messages and holds in the order the story reaches them: its own steps,
    with each spawned worker's holds right after the spawn. A hold shared by several scenes once. */
function events(sessionId) {
  const s = story.sessions.find((x) => x.id === sessionId);
  const out = [];
  const seen = new Set();
  const hold = (h) => !seen.has(h) && (seen.add(h), out.push({ hold: h }));
  for (const step of s.script) {
    const a = actionOf(step);
    if (a === "user") out.push({ user: text(step.user) });
    if (a === "hold") hold(step.hold);
    if (a === "spawn") for (const w of [step.spawn].flat()) for (const ws of story.workers[w].script) if (actionOf(ws) === "hold") hold(ws.hold);
  }
  return out;
}

async function newContext(browser, viewport) {
  const ctx = await browser.newContext(contextOptions(plan.viewports[viewport]));
  // The Access page's pairing response, mocked: the real one names this machine's tailnet.
  await ctx.route("**/api/auth/pair", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        code: "DEMO7rQ2kX9vLmP4sT8wYc1nB6hJ3fG5dA0eZuKiOpW",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        links: [
          { label: "Phone · Tailscale", url: "https://sova.example.ts.net/#c=DEMO7rQ2kX9vLmP4sT8wYc1nB6hJ3fG5dA0eZuKiOpW" },
          { label: "This machine only", url: "http://localhost:4800/#c=DEMO7rQ2kX9vLmP4sT8wYc1nB6hJ3fG5dA0eZuKiOpW" },
        ],
      }),
    }),
  );
  return ctx;
}

/** Unlock with the run's token, then go to `hash`, at the context's viewport. */
async function open(ctx, server, hash) {
  const page = await ctx.newPage();
  await page.goto(`${server.base}/#t=${TOKEN}`, { waitUntil: "load" });
  await page.waitForTimeout(500);
  await page.evaluate((h) => (location.hash = h), hash);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);
  return page;
}

async function typeAndSend(page, value, delay) {
  const input = page.locator("textarea.composer-input").first();
  await input.click();
  await input.pressSequentially(value, { delay });
  await page.locator(".composer-actions button[type=submit]").first().click();
}

async function shoot(browser, server, shot, { sessionPath, patterns }) {
  const ctx = await newContext(browser, shot.viewport);
  let page;
  try {
    const hash =
      shot.session === "overseer" ? "#/overseer" : shot.session === "access" ? "#/access" : `#/s/${encodeURIComponent(sessionPath.get(shot.session))}`;
    page = await open(ctx, server, hash);
    const width = await page.evaluate(() => innerWidth);
    if (width !== plan.viewports[shot.viewport].width) throw new Error(`viewport is ${width}px wide, wanted ${plan.viewports[shot.viewport].width}`);

    // The Access page: make a code (the pair route is mocked), so the shot shows its QR and link.
    if (shot.session === "access") {
      await page.getByRole("button", { name: "Make a Code" }).click({ timeout: 10_000 });
      await page.getByRole("button", { name: "Make Another Code" }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(800);
    }

    if (shot.view === "workers") {
      const trigger = page.locator("button.run-status-link:not(.run-status-align):not(.run-status-running)").first();
      await trigger.click({ timeout: 10_000 });
      const name = plan.workers[shot.worker].name;
      await page.locator(".subagent-row", { hasText: name }).first().click({ timeout: 10_000 });
      await page.waitForTimeout(1200);
    }
    if (shot.view === "changes") {
      await page.getByRole("button", { name: "Review Changes" }).last().click({ timeout: 10_000 });
      await page.locator("[role=dialog]").last().waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1500);
    }
    if (shot.scroll === "align") {
      // The card's end (its answer row) at the bottom of the view; scrolled away from the latest
      // row, the transcript shows Jump to Latest over it, so the view is taken back to the end then.
      await page.locator("article.align-doc").last().evaluate((el) => el.scrollIntoView({ block: "end" }));
      await page.waitForTimeout(600);
      const pill = page.locator(".jump-latest[data-shown]");
      if (await pill.count()) {
        await pill.first().click();
        await page.waitForTimeout(800);
      }
      if (await page.locator(".jump-latest[data-shown]").count()) throw new Error("Jump to Latest is still shown over the transcript");
    }
    if (shot.scroll === "show_changes") await page.getByRole("button", { name: "Review Changes" }).last().scrollIntoViewIfNeeded({ timeout: 10_000 });
    if (shot.compose) {
      const input = page.locator("textarea.composer-input").first();
      await input.click();
      await input.fill(shot.compose);
      await page.locator("textarea.composer-input").first().blur();
    }
    // No focus ring: whatever the page focused (a heading on navigation, the composer) is blurred.
    await page.addStyleTag({ content: `${FREEZE_CSS} :focus-visible { outline: none !important; }` });
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());

    await leakGate(page, patterns, `shot ${shot.id}`);
    const png = await page.screenshot({ type: "png", ...(shot.clip ? { clip: shot.clip } : {}) });
    const sharp = await sharpModule();
    const file = `${shot.id}.webp`;
    mkdirSync(OUT_DIR, { recursive: true });
    const img = sharp(png);
    const meta = await img.metadata();
    const webp = await img.webp({ lossless: true, effort: 6 }).toBuffer();
    writeFileSync(join(OUT_DIR, file), webp);
    return { file, width: meta.width, height: meta.height, bytes: webp.length, sha: fileSha(webp) };
  } catch (e) {
    e.message += ` (${await saveDebug(page, patterns, `${shot.id}-failed`)})`;
    throw e;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** sharp, from the site's own install (the build's image service). */
async function sharpModule() {
  const { createRequire } = await import("node:module");
  // sharp is astro's dependency, not the site's own: resolve it from astro's real path (pnpm isolates it).
  const site = createRequire(join(HERE, "..", "..", "package.json"));
  return createRequire(site.resolve("astro/package.json"))("sharp");
}

