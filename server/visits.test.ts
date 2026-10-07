// Run: pnpm exec tsx --test server/visits.test.ts. §app.baton/visits: the visit log, its
// continuation rule, caps, previews, refusals, restart, and what it never records. A throwaway
// PI_CODING_AGENT_DIR and workspace in the OS temp dir; ~/.pi untouched.
// The share listener end to end (the log through real HTTP and WebSocket hops): visits.integration.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import WebSocket from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-visits-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
// A stub share page: the shell route answers 503 when there is no build, and records nothing.
process.env.SOVA_SHARE_DIST = join(root, "dist-share");
mkdirSync(process.env.SOVA_SHARE_DIST);
writeFileSync(join(process.env.SOVA_SHARE_DIST, "index.html"), "<!doctype html><title>stub</title>");

const orgs = await import("./orgs");
const baton = await import("./baton");
const links = await import("./baton-links");
const visits = await import("./visits");
const { createShareServer } = await import("./share/listener");

after(() => rmSync(root, { recursive: true, force: true }));

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SLACK = "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)";
const HEADLESS = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.0.0 Safari/537.36";
const tab = (c: string) => c.repeat(22);

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony", role: "IT" });
const maria = await orgs.addPerson(org.id, { name: "Maria", role: "Payroll" });
const file = join(orgs.orgDir(org.id), visits.VISITS_FILE);
const lines = (): Record<string, unknown>[] => {
  try {
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const startBaton = async (title: string, to = tony.id) => {
  const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to, publicTitle: title, goal: "g" });
  return { ...c, link: links.findLink(c.token!)! };
};

test("classify: a coarse family, previewers and scanners apart, never the raw string", () => {
  assert.deepEqual(visits.classify(IPHONE), { device: "Safari · iPhone", kind: "person" });
  assert.deepEqual(visits.classify(WINDOWS), { device: "Chrome · Windows", kind: "person" });
  assert.deepEqual(visits.classify("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"), { device: "Firefox · Linux", kind: "person" });
  assert.deepEqual(visits.classify(SLACK), { device: "Slack", kind: "preview" });
  assert.deepEqual(visits.classify("WhatsApp/2.23.20.0 A"), { device: "WhatsApp", kind: "preview" });
  assert.deepEqual(visits.classify("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0"), {
    device: "iMessage",
    kind: "preview",
  });
  assert.deepEqual(visits.classify(HEADLESS), { device: "Security scanner", kind: "bot" });
  assert.deepEqual(visits.classify("curl/8.9.1"), { device: "Script", kind: "bot" });
  // Node's built-in fetch sends exactly "node"; a versioned form reads the same.
  assert.deepEqual(visits.classify("node"), { device: "Script", kind: "bot" });
  assert.deepEqual(visits.classify("node/22"), { device: "Script", kind: "bot" });
  assert.equal(visits.classify("nodeish-browser/1.0").kind, "person", "only the bare name or name/version is Node");
  assert.deepEqual(visits.classify(""), { device: "Browser", kind: "person" });
  // A phone model with "bot" inside its name is not a bot.
  assert.equal(visits.classify("Mozilla/5.0 (Linux; Android 13; CUBOT X30) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36").kind, "person");
});

describe("the continuation rule", async () => {
  const { link } = await startBaton("Continuation");
  const t0 = Date.UTC(2026, 8, 27, 9, 0);
  const min = 60_000;
  let first = "";

  test("an open starts a visit; the same tab continues it without a new line inside the throttle", () => {
    first = visits.recordOpen(link, { tab: tab("A"), userAgent: IPHONE, now: t0 })!;
    assert.match(first, /^v_/);
    assert.equal(visits.recordOpen(link, { tab: tab("A"), userAgent: IPHONE, now: t0 + min }), first, "a reload");
    assert.deepEqual(
      lines().map((l) => l.kind),
      ["visit"],
    );
    assert.equal(visits.recordOpen(link, { tab: tab("A"), userAgent: IPHONE, now: t0 + 6 * min }), first);
    assert.deepEqual(
      lines().map((l) => l.kind),
      ["visit", "seen"],
      "a seen line once 5 minutes passed",
    );
  });

  test("after a restart, the same tab finds its visit again, even past the window", () => {
    visits.resetVisitState();
    assert.equal(visits.recordOpen(link, { tab: tab("A"), userAgent: IPHONE, now: t0 + 30 * min }), first);
  });

  test("no tab (or a bad one) continues inside the window from the same device, else starts anew", () => {
    assert.equal(visits.recordOpen(link, { userAgent: IPHONE, now: t0 + 35 * min }), first, "no v, 5 min after last seen");
    assert.equal(visits.recordOpen(link, { tab: "../bad", userAgent: IPHONE, now: t0 + 36 * min }), first, "a malformed v is ignored");
    const other = visits.recordOpen(link, { tab: tab("B"), userAgent: WINDOWS, now: t0 + 37 * min });
    assert.notEqual(other, first, "another device is another visit");
    const later = visits.recordOpen(link, { userAgent: IPHONE, now: t0 + 60 * min });
    assert.notEqual(later, first, "past the window: a new visit");
  });

  test("a new tab inside the window binds to the visit, so it survives a restart too", () => {
    const t = t0 + 120 * min;
    const v = visits.recordOpen(link, { tab: tab("C"), userAgent: IPHONE, now: t })!;
    assert.equal(visits.recordOpen(link, { tab: tab("D"), userAgent: IPHONE, now: t + min }), v);
    visits.resetVisitState();
    assert.equal(visits.recordOpen(link, { tab: tab("D"), userAgent: IPHONE, now: t + 40 * min }), v);
  });

  test("a scanner is its own visit (bot), never merged with the person's", () => {
    const t = t0 + 200 * min;
    const person = visits.recordOpen(link, { tab: tab("E"), userAgent: IPHONE, now: t })!;
    const bot = visits.recordOpen(link, { userAgent: HEADLESS, now: t + 1000 })!;
    assert.notEqual(bot, person);
    const row = visits.readVisits(org.id, tony.id).find((v) => v.id === bot)!;
    assert.equal(row.bot, true);
    assert.equal(row.device, "Security scanner");
  });

  test("sockets continue, never start; close and the shutdown flush write last seen", () => {
    const t = t0 + 300 * min;
    assert.equal(visits.socketOpened(link, { tab: tab("F"), userAgent: WINDOWS, now: t }), null, "no visit to continue");
    const v = visits.recordOpen(link, { tab: tab("F"), userAgent: WINDOWS, now: t })!;
    const h = visits.socketOpened(link, { tab: tab("F"), userAgent: WINDOWS, now: t + 1000 })!;
    assert.equal(h.id, v);
    const before = lines().length;
    assert.equal(visits.flushOpenVisits(t + 3 * min), 1, "an open socket is seen at the flush");
    visits.socketClosed(h, t + 4 * min);
    assert.equal(lines().length, before + 2);
    const row = visits.readVisits(org.id, tony.id).find((x) => x.id === v)!;
    assert.equal(row.lastSeenAt, new Date(t + 4 * min).toISOString());
    assert.equal(visits.flushOpenVisits(t + 10 * min), 0, "nothing open, nothing pending");
  });
});

describe("previews, refusals and the cap", () => {
  test("a known previewer's shell fetch is a preview line (once per window), never a visit", async () => {
    const { link } = await startBaton("Previewed");
    const t = Date.UTC(2026, 8, 27, 10, 0);
    assert.equal(visits.recordShellFetch(link, SLACK, t), true);
    assert.equal(visits.recordShellFetch(link, IPHONE, t), false, "a browser's shell fetch records nothing");
    visits.recordShellFetch(link, SLACK, t + 60_000);
    assert.equal(visits.recordOpen(link, { userAgent: SLACK, now: t + 120_000 }), null, "a previewer on the API is not a visit either");
    const mine = visits.readVisits(org.id, tony.id).filter((v) => v.sessionId === link.sessionId);
    assert.deepEqual(
      mine.map((v) => [v.kind, v.device]),
      [["preview", "Slack"]],
    );
  });

  test("a refusal is recorded once per window", async () => {
    const { link } = await startBaton("Refused");
    const t = Date.UTC(2026, 8, 27, 11, 0);
    assert.equal(visits.recordRefused(link, IPHONE, t), true);
    assert.equal(visits.recordRefused(link, IPHONE, t + 60_000), false);
    assert.equal(visits.recordRefused(link, IPHONE, t + 11 * 60_000), true);
  });

  test("20 new visits, previews or refusals per link per day, then one capped line; a continued visit is never capped", async () => {
    const { link } = await startBaton("Capped");
    const t0 = Date.UTC(2026, 8, 28, 0, 0);
    const step = 11 * 60_000;
    let last = "";
    visits.recordShellFetch(link, SLACK, t0);
    for (let i = 1; i < 20; i++) last = visits.recordOpen(link, { tab: tab(String.fromCharCode(65 + i)), userAgent: IPHONE, now: t0 + i * step })!;
    assert.ok(last);
    assert.equal(visits.recordOpen(link, { tab: tab("x"), userAgent: IPHONE, now: t0 + 20 * step }), null);
    assert.equal(visits.recordRefused(link, IPHONE, t0 + 21 * step), false);
    assert.equal(visits.recordOpen(link, { tab: tab("T"), userAgent: IPHONE, now: t0 + 19 * step + 60_000 }), last, "continuing is not capped");
    const mine = lines().filter((l) => l.sessionId === link.sessionId);
    assert.equal(mine.filter((l) => l.kind === "capped").length, 1);
    assert.equal(mine.filter((l) => l.kind === "visit").length, 19);
    const nextDay = Date.UTC(2026, 8, 29, 0, 5);
    assert.ok(visits.recordOpen(link, { tab: tab("y"), userAgent: IPHONE, now: nextDay }), "a new day");
  });
});
