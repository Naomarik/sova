// M6 (browser) — the Agents tab's "Remotely linked agents" in a real browser (§mesh.links/agents-pane):
// the page is served by host A and views a session on host B whose link partner is on host C.
//   a. the nodeId mapping: C's row names C by A's own label for it, and its transcript is read
//      through A's own peer id for C (A's peers.json gives C an id and label B doesn't use);
//   b. "not reachable from here": A doesn't list C (removed from A's peers.json only);
//   c. "host offline": A lists C, and C's Sova is stopped.
// Screenshots: ~/.cache/mesh-links-lab-*.png. Needs Playwright: the playwright skill's install
// (.claude/skills/playwright/scripts/node_modules, or PLAYWRIGHT_MODULE=<path to playwright/index.mjs>) and a
// Chromium (CHROMIUM_BIN, else the newest in Playwright's cache).
//   LAB_STATE=… scripts/mesh-lab/lab e2e m6-links-browser
// Takes the lab LOCK; restores A's peers.json (lab pair a,b,c), C's Sova and ends its link at the end.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chaos, hostUrl, lab, labTokenHeaders, readAgentFile, requireLab, waitFor, writeAgentFile } from "./lib.mjs";
import { api, byId, link, newSession, prompt, releaseLock, send, takeLock, unlink, waitIdle, waitInbox } from "./links-lib.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const PW = process.env.PLAYWRIGHT_MODULE ?? join(REPO, ".claude/skills/playwright/scripts/node_modules/playwright/index.mjs");
const SHOTS = join(homedir(), ".cache");
/** Chromium as the playwright skill's start-browser.sh finds it: CHROMIUM_BIN, else the newest in
    Playwright's cache (the module's own pinned build may not be downloaded). */
function chromiumBin() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((x, y) => Number(y.slice(9)) - Number(x.slice(9)));
  for (const d of builds) for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (existsSync(join(cache, d, sub))) return join(cache, d, sub);
  return undefined;
}
/** A's own id and label for C: neither is what B calls it, so only the nodeId can map the row. */
const C_ID_ON_A = "c-seen-from-a";
const C_LABEL_ON_A = "C as A names it";

let cfg;
let A, B, C;
let browser, page;
let sB, sC, linkId;
let peersA; // A's peers.json as found
const sockets = [];

const titled = (host, path, title) => api(host, "/api/sessions/title", { method: "POST", body: { path, title } });
const setPeersA = async (doc) => {
  writeAgentFile(A, "sova/peers.json", JSON.stringify(doc, null, 2) + "\n");
  chaos.sovaRestart(A);
  await waitFor(async () => (await api(A, "/api/mesh")).json?.peers?.some((p) => p.id === B && p.state === "up"), { timeoutMs: 60000, what: `${A} back up with ${B} up` });
};
const shot = (name) => page.screenshot({ path: join(SHOTS, `mesh-links-lab-${name}.png`) });

/** Open B's session on A's page, and its Agents tab: a fresh document every time (a goto that only
    changes the hash would keep the old page and its sockets), with the socket log reset. */
async function openAgents() {
  await page.goto("about:blank");
  sockets.length = 0;
  await page.goto(`${hostUrl(A)}/#/s/${encodeURIComponent(sB.path)}?host=${B}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await page.getByRole("button", { name: "Session details" }).first().click({ timeout: 20000 });
  } catch (e) {
    await shot("failed-open");
    throw new Error(`${e.message}\npage at ${page.url()} shows: ${(await page.locator("body").innerText()).slice(0, 1500)}`);
  }
  await page.getByRole("tab", { name: "Agents" }).click({ timeout: 10000 });
  await page.getByRole("heading", { name: /Remotely linked agents/ }).waitFor({ timeout: 30000 });
}
/** The linked-agents section's only row (B's member is linked to C's alone); its title is asserted
    where it matters, so a row that lost its name can't pass for C's. */
const rowOfC = () => page.locator(".subagents-group", { has: page.getByRole("heading", { name: /Remotely linked agents/ }) }).locator(".subagent-row");

before(async () => {
  cfg = requireLab();
  assert.ok(cfg.hosts.length >= 3, "M6 browser needs 3 hosts");
  [A, B, C] = cfg.hosts;
  if (!existsSync(PW)) throw new Error(`Playwright not found at ${PW}: install the playwright skill or set PLAYWRIGHT_MODULE`);
  const { chromium } = await import(pathToFileURL(PW).href);
  browser = await chromium.launch({ headless: true, executablePath: chromiumBin() });
  const ctx = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: labTokenHeaders() });
  page = await ctx.newPage();
  page.on("websocket", (ws) => sockets.push(ws.url()));
  await takeLock("frontend");
  peersA = JSON.parse(readAgentFile(A, "sova/peers.json") ?? "null");
  assert.ok(peersA?.peers?.some((p) => p.id === C), `${A} lists ${C} (lab pair ${cfg.hosts.slice(0, 3).join(",")})`);

  sB = await newSession(B);
  sC = await newSession(C);
  // A session lists (and so opens by URL) once it has a message: one short turn on B's member.
  assert.equal((await prompt(B, sB.path, "Reply with the single word: ready")).status, 200);
  await waitIdle(B, sB.id);
  await titled(B, sB.path, "Member on B");
  await titled(C, sC.path, "Partner on C");
  const made = await link(B, [{ session: sB.id }, { host: C, session: sC.id }]);
  assert.equal(made.status, 200, JSON.stringify(made.json));
  linkId = made.json.link.id;
  // One message each way, so the thread has both directions (each wakes the other: glm-5.3 turns).
  const out = await send(B, sB.id, "Hello from B. No reply needed.");
  assert.equal(out.status, 200, JSON.stringify(out.json));
  await waitInbox(B, sB.id, (r) => r.some((x) => x.dir === "out"), { what: "B's sent message in its inbox" });
});

after(async () => {
  try {
    await browser?.close();
  } catch {}
  try {
    chaos.sovaStart(C);
  } catch {}
  try {
    if (linkId) await unlink(B, linkId);
  } catch {}
  // The harness's own sessions go to the archive, so reruns don't pile them up in the lists.
  for (const [host, s] of [[B, sB], [C, sC]]) if (s) await api(host, "/api/sessions/archive", { method: "POST", body: { path: s.path, archived: true } }).catch(() => {});
  try {
    // A's peers.json as the lab writes it, and every host restarted on it
    lab("pair", cfg.hosts.slice(0, 3).join(","));
  } catch (e) {
    if (peersA) await setPeersA(peersA).catch(() => {});
    console.error(`restore: ${e.message}`);
  }
  releaseLock();
});

describe("Remotely linked agents, page on A, session on B, partner on C", () => {
  test("a. the row maps C's nodeId to A's own peer id and label, and reads C's transcript through it", async () => {
    const renamed = structuredClone(peersA);
    const c = renamed.peers.find((p) => p.id === C);
    c.id = C_ID_ON_A;
    c.label = C_LABEL_ON_A;
    await setPeersA(renamed);
    // B reports the row with ITS id and label for C: only the nodeId can lead A's page to C.
    const insight = await api(A, `/peer/${B}/api/insights/session?path=${encodeURIComponent(sB.path)}`);
    const row = insight.json?.links?.find((r) => r.sessionId === sC.id);
    assert.ok(row, `B's insight lists C's member: ${JSON.stringify(insight.json?.links)}`);
    assert.equal(row.nodeId, c.nodeId, "the row carries C's nodeId");
    assert.notEqual(row.hostId, C_ID_ON_A, "B's id for C is not A's");

    await openAgents();
    await rowOfC().waitFor({ timeout: 30000 });
    assert.equal(await rowOfC().count(), 1, "one linked row: C's member");
    assert.match(await rowOfC().innerText(), /Partner on C/);
    assert.match(await rowOfC().innerText(), new RegExp(C_LABEL_ON_A), "A's label for C, not B's");
    await rowOfC().click();
    await page.getByRole("region", { name: "Messages with Partner on C" }).getByText("Hello from B").waitFor({ timeout: 30000 });
    await page.getByRole("region", { name: "Partner on C transcript" }).waitFor({ timeout: 30000 });
    await waitFor(() => sockets.some((u) => u.includes(`/peer/${C_ID_ON_A}/ws/watch`)), { timeoutMs: 15000, what: `a watch socket through /peer/${C_ID_ON_A}` });
    // C's own transcript, through A: the turns B's message woke are there, and the link message
    // itself renders nothing (C's only user messages are link messages, so no "You" row at all).
    const cView = page.getByRole("region", { name: "Partner on C transcript" });
    await cView.getByRole("article").first().waitFor({ timeout: 30000 });
    assert.equal(await cView.getByRole("article", { name: /^You\b/ }).count(), 0, "no You row: the link message renders nothing");
    await shot("mapped");
  });

  test("b. A doesn't list C: the row says C isn't reachable from here, and the thread still shows", async () => {
    const without = structuredClone(peersA);
    without.peers = without.peers.filter((p) => p.id !== C);
    await setPeersA(without);
    await openAgents();
    await rowOfC().click({ timeout: 30000 });
    await page.getByText(/isn't reachable from here/).waitFor({ timeout: 30000 });
    await page.getByRole("region", { name: "Messages with Partner on C" }).getByText("Hello from B").waitFor({ timeout: 30000 });
    assert.ok(!sockets.some((u) => u.includes("/ws/watch?path=")), `no transcript watch socket opened: ${sockets.join(" ")}`);
    await shot("unreachable");
  });

  test("c. A lists C and C's Sova is stopped: the row goes offline and the view says host offline", async () => {
    await setPeersA(peersA);
    chaos.sovaStop(C);
    // B's by-id hop to C fails: the row reads offline once B's short cache runs out.
    await waitFor(async () => (await byId(B, sB.id)) && (await api(B, `/api/insights/session?path=${encodeURIComponent(sB.path)}`)).json?.links?.find((r) => r.sessionId === sC.id)?.state === "offline", {
      timeoutMs: 60000,
      intervalMs: 2000,
      what: "B reports C's member offline",
    });
    await openAgents();
    await rowOfC().click({ timeout: 30000 });
    await waitFor(async () => /Offline/i.test(await rowOfC().innerText()), { timeoutMs: 30000, what: "the row's Offline chip" });
    await page.getByText("Host offline.").waitFor({ timeout: 30000 });
    // The thread as last known (found by its box: its label carries the title, asserted last).
    await page.locator(".link-thread").getByText("Hello from B").waitFor({ timeout: 30000 });
    await shot("offline");
    // Offline, the row still names the member (§mesh.links/agents-pane: the row shows the title).
    assert.match(await rowOfC().innerText(), /Partner on C/, "the offline row keeps the member's title");
    chaos.sovaStart(C);
  });
});
