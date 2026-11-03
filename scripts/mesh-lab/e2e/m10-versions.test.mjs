// M10 — hosts on different builds (§mesh/compatibility): real hosts, real images, a real browser. Each
// host runs a commit of its own (lab swap), and every scenario asserts both what the page shows and
// what the host holding the session does when the page is bypassed.
//
// Before it:  node scripts/mesh-lab/e2e/versions-builds.mjs make     (throwaway refs lab/al_1-*)
//             scripts/mesh-lab/lab up --hosts 3 --no-frontdoor --no-publicfront && scripts/mesh-lab/lab pair a,b,c
//             scripts/mesh-lab/lab e2e m10-versions
// After it:   versions-builds.mjs delete, lab destroy.
//
// Needs Playwright like m6-links-browser (PLAYWRIGHT_MODULE, CHROMIUM_BIN). Spends a few short
// glm-5.3 turns. Takes the lab LOCK; leaves a, b and c on base and paired, and deletes nothing.
// Screenshots: SHOTS (default .sova/spec/drafts/al_1-shots), one desktop and one phone per state.
//
// Resync: a lab host has no .git and no deploy recipe, so armResync gives the newer host a git history
// of the builds and a stand-in for scripts/mesh-vps/deploy.sh that only records its arguments; the
// harness then runs the update itself with `lab swap`. What that proves: the offer, the job, the wait
// on the hello and the state afterwards. It doesn't prove deploy.sh over ssh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { provenanceOf } from "../lab.mjs";
import { container, hostUrl, lab, labTokenHeaders, laptopFetch, readAgentFile, requireLab, sh, STATE, waitFor, writeAgentFile } from "./lib.mjs";
import { link, linksFile, MODEL, releaseLock, send, takeLock, unlink } from "./links-lib.mjs";
import { commitOf, list } from "./versions-builds.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const PW = process.env.PLAYWRIGHT_MODULE ?? join(REPO, ".claude/skills/playwright/scripts/node_modules/playwright/index.mjs");
const SHOTS = process.env.SHOTS ?? join(REPO, ".sova/spec/drafts/al_1-shots");
const COMPOSER_HEADER = "X-Sova-Composer";
const A = "a";
const B = "b";
const LABEL = { a: "Host A", b: "Host B", c: "Host C" };
const BAD_WORDS = [/\bother version/i, /can't be reached/i];

function chromiumBin() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((x, y) => Number(y.slice(9)) - Number(x.slice(9)));
  for (const d of builds) for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (existsSync(join(cache, d, sub))) return join(cache, d, sub);
  return undefined;
}

let cfg;
let browser;
const tabs = [];
/** The build each host runs now, by name. */
const running = {};

// ---- builds ------------------------------------------------------------------------------------

const numbersOf = (name) => {
  const r = spawnSync("git", ["-C", REPO, "show", `${commitOf(name)}:shared/wire-areas.json`], { encoding: "utf8" });
  if (r.status !== 0) return null; // legacy: lists no areas
  const m = JSON.parse(r.stdout);
  return { sessions: m.sessions.version, transcript: m.transcript.version, composer: m.composer.version, peer: m.peer.version };
};
const composerOf = (host) => numbersOf(running[host])?.composer ?? 1;
const peerOf = async (from, id) => (await (await laptopFetch(from, "/api/mesh")).json()).peers?.find((p) => p.id === id);

/** Only what a hello actually said counts: `from` lists `to` with `to`'s numbers, so a cached probe of the old build can't pass. */
const seesBuild = (from, to) =>
  waitFor(
    async () => {
      const p = await peerOf(from, to);
      const want = numbersOf(running[to]);
      if (!p || (p.state !== "up" && p.state !== "skewed")) return null;
      if (p.hello?.commit && p.hello.commit !== commitOf(running[to])) return null;
      return want ? JSON.stringify(p.areas) === JSON.stringify(want) && p : !p.areas && p;
    },
    { timeoutMs: 90000, intervalMs: 1000, what: `${from} sees ${to} on ${running[to]}` },
  );

/** Each host on its named build, from git archive and clean, or the test stops there. */
async function builds(want) {
  for (const [host, name] of Object.entries(want)) {
    const commit = commitOf(name);
    assert.ok(commit, `no ref for build ${name}: versions-builds.mjs make`);
    if (provenanceOf(host)?.commit !== commit) lab("swap", host, commit);
    running[host] = name;
    const p = provenanceOf(host);
    assert.equal(p?.commit, commit, `${host} runs ${name}`);
    assert.equal(p?.source, "git archive", `${host} is from git archive`);
    assert.deepEqual(p?.dirty, [], `${host} is clean`);
  }
  const hosts = Object.keys(want);
  for (const from of hosts) for (const to of hosts) if (from !== to) await seesBuild(from, to);
}

// ---- requests ----------------------------------------------------------------------------------

/** A request as `stated` says: a number, or null for none at all. Default: the serving host's own. */
async function call(host, path, { method = "GET", body, stated, timeoutMs = 30000 } = {}) {
  const n = stated === undefined ? composerOf(host) : stated;
  const res = await laptopFetch(host, path, {
    method,
    timeoutMs,
    headers: { ...(n === null ? {} : { [COMPOSER_HEADER]: String(n) }), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const okJson = (r, what) => {
  assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
};
/** A held session on `host` (its runtime opened by configure), to link or to run a turn in. */
async function session(host, stated) {
  const s = okJson(await call(host, "/api/sessions", { method: "POST", body: { cwd: "/root/work" }, stated }), `${host}: create`);
  okJson(await call(host, "/api/sessions/configure", { method: "POST", body: { path: s.path, model: MODEL }, stated, timeoutMs: 60000 }), `${host}: configure`);
  return s;
}
const fixture = async (host) => {
  const rows = okJson(await call(host, "/api/sessions"), `${host}: list`);
  const s = (Array.isArray(rows) ? rows : rows.sessions).find((r) => JSON.stringify(r).includes("fixture session on lab host"));
  assert.ok(s, `${host} has its fixture session`);
  return s;
};

/** Assert the plain sentence of a refusal over REST: 409, code wire-version, nothing else. */
function refusedRest(r, sentence, what) {
  assert.equal(r.status, 409, `${what}: ${r.status} ${r.text.slice(0, 300)}`);
  assert.equal(r.json?.code, "wire-version", what);
  assert.match(r.json.error, sentence, what);
}
const RELOAD = (host) => new RegExp(`older than ${host}\\. Reload the page to send here`);
const NEEDS_UPDATE = (host) => new RegExp(`${host} needs an update before it can take sends from this page`, "i");

/** /ws/chat as a page has it (`composer` null: states none), directly or through `via`'s proxy. */
function chat(node, path, { composer, via } = {}) {
  const frames = [];
  const q = `path=${encodeURIComponent(path)}${composer === null ? "" : `&composer=${composer ?? composerOf(via ?? node)}`}`;
  const base = hostUrl(via ?? node).replace(/^http/, "ws");
  const ws = new WebSocket(`${base}${via ? `/peer/${node}` : ""}/ws/chat?${q}`, { headers: labTokenHeaders() });
  ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  const hello = waitFor(() => frames.some((f) => f.type === "hello"), { timeoutMs: 30000, intervalMs: 100, what: `chat hello from ${node}` });
  return {
    frames,
    hello,
    open: () => ws.readyState === WebSocket.OPEN,
    send: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    waitFrame: (pred, what, timeoutMs = 20000, from = 0) => waitFor(() => frames.slice(from).find(pred), { timeoutMs, intervalMs: 100, what }),
    waitEvent: (pred, what, timeoutMs = 180000) => waitFor(() => frames.some((f) => f.type === "event" && pred(f.event ?? {})), { timeoutMs, intervalMs: 200, what }),
  };
}
async function refusedFrame(c, msg, sentence, what) {
  const from = c.frames.length;
  c.send(msg);
  const f = await c.waitFrame((x) => x.type === "error" && x.code === "refused", `${what}: a refused frame`, 20000, from);
  assert.match(f.message, sentence, what);
  assert.ok(c.open(), `${what}: the socket stays open`);
}

// ---- the page ----------------------------------------------------------------------------------

async function tab(host, hash = "#/mesh") {
  const ctx = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: labTokenHeaders(), viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  tabs.push(ctx);
  await page.goto(`${hostUrl(host)}/${hash}`);
  return page;
}
const closeTabs = async () => {
  for (const c of tabs.splice(0)) await c.close().catch(() => {});
};
const sessionHash = (s, host) => `#/s/${encodeURIComponent(s.path)}${host ? `?host=${host}` : ""}`;

/** One desktop and one phone picture of what the page shows now; the width is read back, not assumed. */
async function shots(page, name) {
  mkdirSync(SHOTS, { recursive: true });
  for (const [label, width, height] of [["desktop", 1440, 900], ["phone", 390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => innerWidth), width, `${name}: viewport ${label}`);
    await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

const meshRow = (page, id) => page.locator(`[data-testid="mesh-host-row"][data-host-id="${id}"]`);
const WORD = { works: null, "read-only": "read only", display: "display may be wrong", update: "update needed" };

/** The Mesh page, on `page`: the state attribute, the word, no forbidden words; returns the row's text. */
async function meshSays(page, id, state) {
  await page.evaluate(() => (location.hash = "#/mesh"));
  await waitFor(async () => (await meshRow(page, id).getAttribute("data-host-state", { timeout: 2000 })) === state, { timeoutMs: 45000, what: `Mesh page says ${id} is ${state}` });
  const text = await meshRow(page, id).innerText();
  for (const bad of BAD_WORDS) assert.doesNotMatch(text, bad, `Mesh row: ${text}`);
  if (WORD[state]) assert.match(text.toLowerCase(), new RegExp(WORD[state]), `Mesh row says it: ${text}`);
  else for (const w of Object.values(WORD)) if (w) assert.ok(!text.toLowerCase().includes(w), `no reduced word on a host that works fully: ${text}`);
  return text;
}
/** The host menu's row: state, word, dot tone (amber is host-filter-skewed), and the Resync button's presence. */
async function menuSays(page, id, state, { resync }) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => (location.hash = "#/"));
  const trigger = page.locator(".host-menu-trigger");
  await trigger.click({ timeout: 15000 });
  const row = page.locator(`[data-testid="host-menu-row"][data-host-id="${id}"]`);
  await waitFor(async () => (await row.getAttribute("data-host-state", { timeout: 2000 })) === state, { timeoutMs: 30000, what: `host menu says ${id} is ${state}` });
  const amber = await row.locator(".chip-dot.host-filter-skewed").count();
  assert.equal(amber, state === "works" ? 0 : 1, `amber dot in the host menu for ${state}`);
  if (WORD[state]) assert.match((await row.innerText()).toLowerCase(), new RegExp(WORD[state]));
  if (resync !== undefined)
    await waitFor(async () => (await row.getByRole("menuitem", { name: `Resync ${LABEL[id]}` }).count()) === (resync ? 1 : 0), { timeoutMs: 15000, what: `Resync ${resync ? "offered" : "not offered"} in the host menu` });
  const text = await row.innerText();
  await page.keyboard.press("Escape");
  return text;
}
/** The session row's mark in the list: state attribute, the word, and the warn class only when reduced. */
async function rowSays(page, id, state) {
  await page.evaluate(() => (location.hash = "#/"));
  const mark = page.locator(`[data-testid="session-row-host"]`, { hasText: LABEL[id] }).first();
  await mark.waitFor({ timeout: 45000 });
  await waitFor(async () => (await mark.getAttribute("data-host-state")) === state, { timeoutMs: 30000, what: `row says ${state}` });
  const text = (await mark.innerText()).toLowerCase();
  if (WORD[state]) assert.ok(text.includes(WORD[state]), `row word: ${text}`);
  else assert.equal(await mark.locator(".chip-dot").count(), 0, "no mark on a row of a host that works fully");
}
async function headSays(page, state) {
  const mark = page.locator('[data-testid="session-host-mark"]').first();
  await mark.waitFor({ timeout: 30000 });
  await waitFor(async () => (await mark.getAttribute("data-host-state")) === state, { timeoutMs: 30000, what: `head says ${state}` });
  assert.equal(await mark.locator(".host-filter-skewed").count(), state === "works" ? 0 : 1, "amber dot in the head");
}
/** What New Session's Host choice says of a host: its option's state, disabled or not, and its word. */
async function pickerSays(page, id, state, { canPick }) {
  await page.evaluate(() => (location.hash = "#/"));
  await page.getByRole("button", { name: /New Session/i }).first().click({ timeout: 15000 });
  const opt = page.locator(`#ns-host option[value="${id}"]`);
  await opt.waitFor({ state: "attached", timeout: 15000 });
  assert.equal(await opt.getAttribute("data-host-state"), state, "picker state");
  assert.equal(await opt.isDisabled(), !canPick, `picker: ${id} ${canPick ? "can" : "can't"} be chosen`);
  const text = (await opt.innerText()).toLowerCase();
  if (WORD[state]) assert.ok(text.includes(WORD[state]), `picker word: ${text}`);
  else for (const w of Object.values(WORD)) if (w) assert.ok(!text.includes(w), `picker: ${text}`);
  await page.keyboard.press("Escape");
}
const composerOn = (page) => page.locator("form.composer-inner").count();
const stopOn = (page) => page.getByRole("button", { name: "Stop", exact: true }).count();
async function typeAndSend(page, text) {
  const box = page.locator("textarea.composer-input").first();
  await box.fill(text);
  await box.press("Enter");
}

// ---- Resync ------------------------------------------------------------------------------------

/** Give `newer` what a real checkout has (the builds' history, a recipe for `older`) and a stand-in deploy. */
async function armResync(newer, older) {
  const file = join(STATE, "versions.bundle");
  if (!existsSync(file)) {
    const made = spawnSync("git", ["-C", REPO, "bundle", "create", file, "--branches=lab/al_1-*"], { encoding: "utf8" });
    assert.equal(made.status, 0, made.stderr);
  }
  const copied = spawnSync("docker", ["cp", file, `${container(newer)}:/tmp/lab.bundle`], { encoding: "utf8" });
  assert.equal(copied.status, 0, copied.stderr);
  const commit = provenanceOf(newer).commit;
  const stand = `#!/usr/bin/env bash\\necho "$*" > /tmp/lab-resync-request\\necho "lab stand-in for deploy.sh: $*"\\n`;
  const r = sh(
    newer,
    `set -e; cd /sova; git init -q . 2>/dev/null; git fetch -q /tmp/lab.bundle 'refs/heads/*:refs/remotes/lab/*'; git update-ref refs/heads/lab-run ${commit}; git symbolic-ref HEAD refs/heads/lab-run; git read-tree ${commit}; git ls-files -d -z | xargs -0 -r git update-index --assume-unchanged
     git update-index --refresh -q || true
     printf '${stand}' > scripts/mesh-vps/deploy.sh; git update-index --assume-unchanged scripts/mesh-vps/deploy.sh; printf 'VPS_ID=${older}\\n' > scripts/mesh-vps/local.env
     git status --porcelain --untracked-files=no | head -20 > /tmp/lab-dirty; rm -f /tmp/lab-resync-request`,
    { timeoutMs: 120000 },
  );
  assert.equal(r.code, 0, `armResync: ${r.err}`);
  // A tree the image changed from the commit (the lab's own build files): those aren't the product's.
  sh(newer, `cd /sova; git status --porcelain --untracked-files=no | sed 's/^...//' | tr '\\n' '\\0' | xargs -0 -r git update-index --assume-unchanged`);
  assert.equal(sh(newer, "cd /sova; git status --porcelain --untracked-files=no").out, "", "the host's checkout is clean at its commit");
  writeAgentFile(newer, "sova/mesh-resync.json", `${JSON.stringify({ hosts: { [older]: { kind: "vps", args: [] } } })}\n`);
  lab("sova-restart", newer);
  await seesBuild(newer, older);
}

/** The confirm sheet's primary action, then the stand-in's request, then the real update, then the job's end. */
async function resyncThroughSheet(page, newer, older, buildName) {
  await page.locator('[aria-modal="true"][aria-labelledby="mesh-resync-title"]').waitFor({ timeout: 15000 });
  await page.locator('[aria-modal="true"][aria-labelledby="mesh-resync-title"] .button-primary').click();
  const asked = await waitFor(() => sh(newer, "cat /tmp/lab-resync-request 2>/dev/null").out, { timeoutMs: 30000, what: "the deploy script ran" });
  const commit = commitOf(buildName);
  assert.match(asked, new RegExp(`--rev ${commit}\\b`), "the deploy names this host's own commit");
  lab("swap", older, commit);
  running[older] = buildName;
  await waitFor(async () => (await (await laptopFetch(newer, "/api/mesh/resync")).json()).hosts.find((h) => h.id === older)?.job?.state === "done", { timeoutMs: 200000, intervalMs: 2000, what: "the resync job's end" });
}

// ---- lifecycle ---------------------------------------------------------------------------------

before(async () => {
  cfg = requireLab();
  const refs = list();
  assert.ok(refs.base, "versions-builds.mjs make first");
  assert.equal(refs.base, spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(), "lab/al_1-base is HEAD: rerun make");
  if (!existsSync(PW)) throw new Error(`Playwright not found at ${PW}`);
  const { chromium } = await import(pathToFileURL(PW).href);
  browser = await chromium.launch({ headless: true, executablePath: chromiumBin() });
  await takeLock("versions");
  await builds({ a: "base", b: "base" });
  lab("pair", "a,b,c");
  await builds({ a: "base", b: "base" });
});
after(async () => {
  await closeTabs();
  await browser?.close().catch(() => {});
  try {
    await builds({ a: "base", b: "base" });
    lab("pair", "a,b,c");
  } catch (e) {
    console.error(`restore: ${e.message}`);
  }
  releaseLock();
});

// ---- 1 ------------------------------------------------------------------------------------------

describe("1. another build, nothing in the areas changed: Works fully", () => {
  after(closeTabs);
  test("the fingerprints differ, no amber, 'on another build' on the Mesh page and host menu, Resync from the newer host", async () => {
    await builds({ a: "base", b: "unrelated" });
    const peer = await peerOf(A, B);
    assert.equal(peer.state, "up");
    assert.notEqual(peer.hello.protocol, (await peerOf(B, A)).hello.protocol, "the protocol hash really differs");
    await armResync(B, A);

    const onA = await tab(A);
    assert.match(await meshSays(onA, B, "works"), /On another build/);
    assert.match(await menuSays(onA, B, "works", { resync: false }), /another build/i);
    await rowSays(onA, B, "works");
    await shots(onA, "1-works-another-build-older-side");
    const onB = await tab(B);
    assert.match(await meshSays(onB, A, "works"), /On another build: 1 commit behind/);
    assert.match(await menuSays(onB, A, "works", { resync: true }), /another build/i);
    await shots(onB, "1-works-another-build-newer-side");

    const s = await fixture(B);
    await onA.goto(`${hostUrl(A)}/${sessionHash(s, B)}`);
    await onA.locator("form.composer-inner").waitFor({ timeout: 30000 });
    await headSays(onA, "works");
    assert.equal(await onA.locator('[data-testid="host-send-notice"],[data-testid="host-display-bar"],[data-testid="host-update-page"]').count(), 0, "nothing in the way");
  });
  test("a send through the proxy is taken", async () => {
    const s = await session(B, 1);
    const r = await call(A, `/peer/${B}/api/sessions/prompt`, { method: "POST", body: { path: s.path, text: "Reply with the single word: ok" }, stated: 1 });
    assert.equal(r.status, 200, r.text);
  });
});

// ---- 2 ------------------------------------------------------------------------------------------

describe("2. a host that lists no areas", () => {
  after(closeTabs);
  test("legacy on the same fingerprint works fully", async () => {
    await builds({ a: "base", b: "legacy" });
    assert.equal((await peerOf(A, B)).state, "up");
    const page = await tab(A);
    await meshSays(page, B, "works");
    await shots(page, "2-legacy-same-fingerprint");
    await armResync(A, B);
    await menuSays(page, B, "works", { resync: true }); // a matching hash on an older commit gets Resync too
  });

  test("legacy on another build: Update needed, the right words, sync and links as today, and Resync brings it over", async () => {
    await builds({ a: "base-merged", b: "base" });
    const sa = await session(A);
    const sb = await session(B);
    const made = await link(A, [{ session: sa.id }, { host: B, session: sb.id }]);
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const s = await fixture(B);

    await builds({ a: "base-merged", b: "legacy-skewed" });
    assert.equal((await peerOf(A, B)).state, "skewed");
    await armResync(A, B);
    const page = await tab(A);
    assert.match(await meshSays(page, B, "update"), /another version/i);
    await menuSays(page, B, "update", { resync: true });
    await rowSays(page, B, "update");
    await pickerSays(page, B, "update", { canPick: false });
    await page.goto(`${hostUrl(A)}/${sessionHash(s, B)}`);
    const gate = page.locator('[data-testid="host-update-page"]');
    await gate.waitFor({ timeout: 30000 });
    const words = await gate.innerText();
    assert.match(words, /Host B runs another version of Sova/);
    assert.match(words, /opens once the two match/);
    for (const bad of BAD_WORDS) assert.doesNotMatch(await page.locator("body").innerText(), bad);
    await shots(page, "2-legacy-update-needed");

    // Sync, and a link already made, stay as they were.
    const fav = await laptopFetch(A, "/api/models/favorite", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: `lab/m10-${Date.now()}`, favorite: true }) });
    assert.ok(fav.status < 300, `favorite: ${fav.status}`);
    const want = readAgentFile(A, "model-favorites.json");
    await waitFor(() => readAgentFile(B, "model-favorites.json") === want, { timeoutMs: 60000, what: "sync still reaches a host that lists no areas" });
    const sent = await send(A, sa.id, "A note across builds. No reply needed.");
    assert.notEqual(sent.json?.deliveries?.[0]?.state, "refused", `an existing link stays as it was: ${JSON.stringify(sent.json)}`);
    await unlink(A, made.json.link.id);

    await meshSays(page, B, "update");
    await page.evaluate(() => (location.hash = "#/"));
    await page.locator(".host-menu-trigger").click();
    await page.getByRole("menuitem", { name: "Resync Host B" }).click();
    await resyncThroughSheet(page, A, B, "base-merged");
    await seesBuild(A, B);
    await page.reload();
    await meshSays(page, B, "works");
    assert.ok((await peerOf(A, B)).areas, "it lists its areas now");
  });
});

// ---- 3 ------------------------------------------------------------------------------------------

describe("3. writing differs: Read only, both ways", () => {
  let s, turn;
  before(async () => {
    await builds({ a: "base", b: "base" });
    // A session with history on each side, made while both can still make one.
    await builds({ a: "base", b: "composer" });
    s = await session(B); // stated: b's own number
  });
  after(closeTabs);

  test("the page on the lower side: chat opens, stays live through a reply, no composer, the notice names the behind host", async () => {
    const page = await tab(A);
    await meshSays(page, B, "read-only");
    await menuSays(page, B, "read-only", { resync: false });
    await rowSays(page, B, "read-only");
    await pickerSays(page, B, "read-only", { canPick: false });

    // A session lists once it has a message: b's own page sends it, with b's number.
    const marker = `m10-live-${Date.now().toString(36)}`;
    turn = chat(B, s.path);
    await turn.hello;
    turn.send({ type: "set_model", ref: MODEL });
    await page.goto(`${hostUrl(A)}/${sessionHash(s, B)}`);
    const notice = page.locator('[data-testid="host-send-notice"]');
    await notice.waitFor({ timeout: 30000 });
    assert.equal(await notice.getAttribute("data-host-state"), "read-only");
    const words = await notice.innerText();
    assert.match(words, /Nothing can be sent to Host B from this page, Stop included/);
    assert.match(words, /You can still read and watch/);
    assert.match(words, /Host A is behind/, "the side with the lower writing number");
    assert.equal(await notice.getByRole("button", { name: /Resync/ }).count(), 0, "b is newer: no Resync from a");
    assert.equal(await composerOn(page), 0, "the composer is gone");
    await headSays(page, "read-only");

    turn.send({ type: "prompt", text: `Use the bash tool to run exactly \`sleep 20\`, then reply with the single word ${marker}.`, clientId: `${marker}-1` });
    await turn.waitEvent((e) => e.type === "tool_execution_start" && e.toolName === "bash", "b's bash call");
    await page.getByText("sleep 20").first().waitFor({ timeout: 30000 });
    assert.equal(await stopOn(page), 0, "no Stop while a reply runs");
    assert.equal(await composerOn(page), 0, "still no composer while a reply runs");
    await shots(page, "3-read-only-reply-running");

    // Bypass the page while the reply runs: a raw Stop and a raw send, REST and socket.
    const raw = chat(B, s.path, { via: A, composer: 1 });
    await raw.hello;
    await refusedFrame(raw, { type: "abort" }, RELOAD("Host B"), "raw Stop through the proxy");
    await refusedFrame(raw, { type: "prompt", text: "raw send", clientId: "m10-raw" }, RELOAD("Host B"), "raw send through the proxy");
    raw.close();
    refusedRest(await call(A, `/peer/${B}/api/sessions/prompt`, { method: "POST", body: { path: s.path, text: "raw send" }, stated: 1 }), RELOAD("Host B"), "REST prompt through the proxy");
    refusedRest(await call(A, `/peer/${B}/api/sessions`, { method: "POST", body: { cwd: "/root/work" }, stated: 1 }), RELOAD("Host B"), "new session through the proxy");
    refusedRest(await call(A, `/peer/${B}/api/chat/action`, { method: "POST", body: { path: s.path, action: "lab" }, stated: 1 }), RELOAD("Host B"), "in-chat action through the proxy");

    await page.getByText(marker, { exact: true }).first().waitFor({ timeout: 120000 });
    assert.ok(!(await page.getByText("raw send").count()), "nothing raw landed");
  });

  test("the page on the higher side: the notice names the other host, Resync is offered, a raw send says that host needs an update", async () => {
    await armResync(B, A);
    const lower = await fixture(A);
    const page = await tab(B);
    await meshSays(page, A, "read-only");
    await menuSays(page, A, "read-only", { resync: true });
    await page.goto(`${hostUrl(B)}/${sessionHash(lower, A)}`);
    const notice = page.locator('[data-testid="host-send-notice"]');
    await notice.waitFor({ timeout: 30000 });
    assert.match(await notice.innerText(), /Host A is behind/);
    await notice.getByRole("button", { name: "Resync Host A" }).waitFor({ timeout: 15000 });
    await shots(page, "3-read-only-higher-side");
    refusedRest(await call(B, `/peer/${A}/api/sessions/prompt`, { method: "POST", body: { path: lower.path, text: "raw" }, stated: 2 }), NEEDS_UPDATE("Host A"), "REST from the higher side");
    const raw = chat(A, lower.path, { via: B, composer: 2 });
    await raw.hello;
    await refusedFrame(raw, { type: "abort" }, NEEDS_UPDATE("Host A"), "raw Stop from the higher side");
    raw.close();
  });

  test("link messages still work, both ways", async () => {
    const onA = await session(A);
    const onB = await session(B);
    const made = await link(A, [{ session: onA.id }, { host: B, session: onB.id }]);
    assert.equal(made.status, 200, JSON.stringify(made.json));
    for (const [from, sid] of [[A, onA.id], [B, onB.id]]) {
      const r = await send(from, sid, "A note across builds. No reply needed.");
      assert.notEqual(r.json?.deliveries?.[0]?.state, "refused", `${from}: ${JSON.stringify(r.json)}`);
      assert.equal(r.status, 200, `${from}: ${JSON.stringify(r.json)}`);
    }
    await unlink(A, made.json.link.id);
  });

  test("the Overseer can read that host and can't send to it or create a session on it", async () => {
    const saved = okJson(await call(A, "/api/settings/overseer"), "Overseer settings").settings;
    okJson(await call(A, "/api/settings/overseer", { method: "PUT", body: { ...saved, model: MODEL, thinking: "low", proactivity: "off" } }), "set the Overseer's model");
    try {
      okJson(await call(A, "/api/overseer/clear", { method: "POST" }), "clear");
      const c = chat(A, (await call(A, "/api/overseer")).json.path);
      await c.hello;
      const target = await fixture(B);
      c.send({
        type: "prompt",
        text: `Make exactly these two tool calls, in order. First sova_read_session with session "${target.id}" and host "b". Then sova_create_session with host "b", cwd "/root/work", title "m10 overseer", prompt "Reply ok". Then stop.`,
        clientId: "m10-overseer",
      });
      const ended = (name) => c.frames.filter((f) => f.type === "event" && f.event?.type === "tool_execution_end" && f.event.toolName === name).pop()?.event;
      await waitFor(() => ended("sova_read_session"), { timeoutMs: 180000, what: "the Overseer's read" });
      await waitFor(() => ended("sova_create_session"), { timeoutMs: 180000, what: "the Overseer's create" });
      assert.match(JSON.stringify(ended("sova_read_session")), /fixture session on lab host b/, "it reads a Read only host");
      assert.match(JSON.stringify(ended("sova_create_session")), /Host B \(b\) runs another version of Sova/, "refused, naming the host");
      c.close();
      assert.equal(JSON.stringify(okJson(await call(B, "/api/sessions"), "b's list")).includes("m10 overseer"), false, "nothing was created on b");
    } finally {
      await call(A, "/api/settings/overseer", { method: "PUT", body: saved });
    }
  });
});

// ---- 4 ------------------------------------------------------------------------------------------

describe("4. reading differs: Display may be wrong", () => {
  after(closeTabs);
  test("the chat draws under a warning bar, sending is off, both sides", async () => {
    await builds({ a: "base", b: "transcript" });
    await armResync(B, A);
    const s = await fixture(B);
    const page = await tab(A);
    await meshSays(page, B, "display");
    await menuSays(page, B, "display", { resync: false });
    await rowSays(page, B, "display");
    await pickerSays(page, B, "display", { canPick: false });
    await page.goto(`${hostUrl(A)}/${sessionHash(s, B)}`);
    const bar = page.locator('[data-testid="host-display-bar"]');
    await bar.waitFor({ timeout: 30000 });
    assert.match(await bar.innerText(), /This chat may not show correctly/);
    assert.match(await bar.innerText(), /Host A is behind/);
    await page.getByText(/fixture session on lab host b/).first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator('[data-testid="host-send-notice"]').getAttribute("data-host-state"), "display");
    assert.equal(await composerOn(page), 0);
    await headSays(page, "display");
    await shots(page, "4-display-may-be-wrong");

    const lower = await fixture(A);
    const onB = await tab(B);
    await meshSays(onB, A, "display");
    await onB.goto(`${hostUrl(B)}/${sessionHash(lower, A)}`);
    const barB = onB.locator('[data-testid="host-display-bar"]');
    await barB.waitFor({ timeout: 30000 });
    assert.match(await barB.innerText(), /Host A is behind/);
    await barB.getByRole("button", { name: "Resync Host A" }).waitFor({ timeout: 15000 });
    await shots(onB, "4-display-higher-side");
  });
});

// ---- 5 ------------------------------------------------------------------------------------------

for (const bumped of ["sessions", "peer"]) {
  describe(`5. ${bumped} differs: Update needed`, () => {
    after(closeTabs);
    test("the session won't open, a link message is refused at once and not held, the link survives, sync stops", async () => {
      await builds({ a: "base", b: "base", c: "base" });
      const sa = await session(A);
      const sb = await session(B);
      const made = await link(A, [{ session: sa.id }, { host: B, session: sb.id }]);
      assert.equal(made.status, 200, JSON.stringify(made.json));
      const s = await fixture(B);
      await builds({ a: "base", b: bumped, c: "base" });
      const page = await tab(A);
      await meshSays(page, B, "update");
      await rowSays(page, B, "update");
      await pickerSays(page, B, "update", { canPick: false });
      await page.goto(`${hostUrl(A)}/${sessionHash(s, B)}`);
      await page.locator('[data-testid="host-update-page"]').waitFor({ timeout: 30000 });
      for (const bad of BAD_WORDS) assert.doesNotMatch(await page.locator("body").innerText(), bad);
      await shots(page, `5-update-needed-${bumped}`);

      okJson(await call(B, "/api/sessions/configure", { method: "POST", body: { path: sb.path, model: MODEL }, timeoutMs: 60000 }), "hold b's member again");
      for (const [from, sid] of [[A, sa.id], [B, sb.id]]) {
        const t0 = Date.now();
        const r = await send(from, sid, "Across an Update needed host. No reply needed.");
        const d = r.json?.deliveries?.[0];
        assert.ok(Date.now() - t0 < 10000, `${from}: at once`);
        assert.equal(d?.state, "refused", `${from}: not held: ${JSON.stringify(r.json)}`);
        assert.match(d.message, /another version of Sova|needs an update/, JSON.stringify(d));
        const kept = linksFile(from).links.find((l) => l.id === made.json.link.id);
        assert.equal(kept?.endedAt, undefined, `${from}: the link survives`);
      }

      const marker = `lab/m10-sync-${bumped}-${Date.now()}`;
      const fav = await laptopFetch(A, "/api/models/favorite", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref: marker, favorite: true }) });
      assert.ok(fav.status < 300);
      // c matches a, so its copy says the sync went out; only then can b's lack of one mean anything.
      // Back on matching builds, the same link carries a message and the favorite arrives on b: the
      // absences above are the state's doing, not a broken link or a broken sync.
      await waitFor(() => (readAgentFile("c", "model-favorites.json") ?? "").includes(marker), { timeoutMs: 60000, what: "the favorite reaches c" });
      assert.ok(!(readAgentFile(B, "model-favorites.json") ?? "").includes(marker), "no sync while Update needed");
      await builds({ a: "base", b: "base", c: "base" });
      await waitFor(() => (readAgentFile(B, "model-favorites.json") ?? "").includes(marker), { timeoutMs: 60000, what: "sync resumes once the numbers match" });
      await call(B, "/api/sessions/configure", { method: "POST", body: { path: sb.path, model: MODEL }, timeoutMs: 60000 });
      const again = await send(A, sa.id, "Matching again. No reply needed.");
      assert.notEqual(again.json?.deliveries?.[0]?.state, "refused", JSON.stringify(again.json));
      await unlink(A, made.json.link.id);
    });
  });
}

// ---- 6 ------------------------------------------------------------------------------------------

describe("6. a tab left open across an update", () => {
  after(closeTabs);
  test("no-version sends: taken at composer 1, refused above it", async () => {
    await builds({ a: "base", b: "composer" });
    const low = await session(A);
    const high = await session(B);
    const taken = await call(A, "/api/sessions/prompt", { method: "POST", body: { path: low.path, text: "Reply with the single word: ok" }, stated: null });
    assert.equal(taken.status, 200, taken.text);
    refusedRest(await call(B, "/api/sessions/prompt", { method: "POST", body: { path: high.path, text: "x" }, stated: null }), RELOAD("Host B"), "no version, composer 2");
    refusedRest(await call(B, "/api/sessions", { method: "POST", body: { cwd: "/root/work" }, stated: null }), RELOAD("Host B"), "no version, new session");
    const c = chat(B, high.path, { composer: null });
    await c.hello;
    await refusedFrame(c, { type: "prompt", text: "x", clientId: "m10-none" }, RELOAD("Host B"), "no version on the socket");
    c.close();
  });

  test("judged by what it runs: the stale tab and a fresh tab disagree, and each is right", async () => {
    await builds({ a: "base", b: "base" });
    const s = await session(A);
    const stale = await tab(A, sessionHash(s, null));
    await stale.locator("form.composer-inner").waitFor({ timeout: 30000 });
    await builds({ a: "composer", b: "base" });
    const fresh = await tab(A);
    await meshSays(fresh, B, "read-only");
    await shots(fresh, "6-fresh-tab");
    await meshSays(stale, B, "works"); // its bundle's composer 1 equals b's
    await shots(stale, "6-stale-tab");
    await stale.evaluate((h) => (location.hash = h), sessionHash(s, null));
    await stale.locator("form.composer-inner").waitFor({ timeout: 30000 });
    await typeAndSend(stale, "From a stale tab");
    await stale.getByText(/older than Host A\. Reload the page to send here/).first().waitFor({ timeout: 30000 });
    assert.equal(await stale.locator("textarea.composer-input").first().inputValue(), "From a stale tab", "the text comes back as a draft");
    await shots(stale, "6-stale-tab-refused");
  });

  test("a sender ahead of its own host, after a downgrade, is told the host needs an update", async () => {
    await builds({ a: "composer", b: "base" });
    const s = await session(A);
    const stale = await tab(A, sessionHash(s, null));
    await stale.locator("form.composer-inner").waitFor({ timeout: 30000 });
    await builds({ a: "base", b: "base" });
    await typeAndSend(stale, "From a tab ahead of its host");
    await stale.getByText(/Host A needs an update before it can take sends from this page/).first().waitFor({ timeout: 30000 });
  });

  test("with the mesh off the rule is the same, and the sentence has no host name to use", async () => {
    await builds({ a: "base" });
    lab("unpair", "a,b,c");
    try {
      const s = await session(A);
      const stale = await tab(A, sessionHash(s, null));
      await stale.locator("form.composer-inner").waitFor({ timeout: 30000 });
      lab("swap", A, commitOf("composer"));
      running[A] = "composer";
      await typeAndSend(stale, "Mesh off, stale tab");
      await stale.getByText(/older than this host\. Reload the page to send here/).first().waitFor({ timeout: 30000 });
      await shots(stale, "6-stale-tab-mesh-off");
      await stale.reload();
      await stale.locator("form.composer-inner").waitFor({ timeout: 30000 });
    } finally {
      lab("pair", "a,b,c");
    }
  });
});

// ---- 7 ------------------------------------------------------------------------------------------

describe("7. workspace panes obey the state", () => {
  after(closeTabs);
  test("a pane of a Read only host has the notice, of an Update needed host the update page", async () => {
    await builds({ a: "base", b: "base" });
    const s = await session(B);
    okJson(await call(B, "/api/sessions/prompt", { method: "POST", body: { path: s.path, text: "Reply with the single word: ok" } }), "a first message");
    const group = okJson(await call(B, "/api/session-groups", { method: "POST", body: { name: "m10 panes" } }), "group");
    okJson(await call(B, "/api/session-groups/assign", { method: "POST", body: { path: s.path, groupId: group.id } }), "assign");
    // A's page lists a group of its own only: the same group is copied to a, so b's member fills a pane there.
    writeAgentFile(A, "sova/session-groups.json", readAgentFile(B, "sova/session-groups.json"));
    lab("sova-restart", A);
    const hash = `#/g/${encodeURIComponent(group.id)}`;

    await builds({ a: "base", b: "composer" });
    const page = await tab(A, hash);
    await page.locator('[data-testid="host-send-notice"]').waitFor({ timeout: 45000 });
    assert.equal(await composerOn(page), 0, "no composer in the pane");
    assert.equal(await page.locator(".workspace-pane-host").getAttribute("data-host-state"), "read-only");
    await shots(page, "7-pane-read-only");

    await builds({ a: "base", b: "sessions" });
    await page.goto("about:blank");
    await page.goto(`${hostUrl(A)}/${hash}`);
    await page.locator('[data-testid="host-update-page"]').waitFor({ timeout: 45000 });
    assert.equal(await composerOn(page), 0);
    await shots(page, "7-pane-update-needed");
  });
});
