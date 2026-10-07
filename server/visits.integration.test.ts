// Run: pnpm exec tsx --test server/visits.integration.test.ts. §app.baton/visits: the visit log, its
// continuation rule, caps, previews, refusals, restart, and what it never records. A throwaway
// PI_CODING_AGENT_DIR and workspace in the OS temp dir, the share server on an ephemeral loopback
// port; ~/.pi untouched.
// The share listener end to end; the log's rules in-process are visits.test.ts.
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

describe("through the share listener", async () => {
  const c = await startBaton("Live", maria.id);
  const closed = await startBaton("Closed", maria.id);
  await baton.closeBaton(closed.sessionId);
  const server = createShareServer();
  let base = "";
  let wsBase = "";
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
  });
  after(() => {
    server.close();
    server.closeAllConnections();
  });
  const v = tab("L");
  const XFF = "203.0.113.77";

  test("open (with ?v), reconnect, previews and a turned-off link land in visits.jsonl, and nothing else does", async () => {
    const h = { "User-Agent": IPHONE, "X-Forwarded-For": XFF };
    assert.equal((await fetch(`${base}/api/h/${c.token}?v=${v}`, { headers: h })).status, 200);
    assert.equal((await fetch(`${base}/api/h/${c.token}?v=${v}`, { headers: h })).status, 200, "a reload");
    await new Promise<void>(async (resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ws/h?token=${c.token}&v=${v}`, { headers: h });
      ws.on("message", () => ws.close());
      ws.on("close", () => resolve());
      ws.on("error", reject);
    });
    // The shell answers the same for a previewer and for a token it doesn't know.
    const shell = await fetch(`${base}/h/${c.token}`, { headers: { "User-Agent": SLACK } });
    const unknown = await fetch(`${base}/h/${"Q".repeat(43)}`, { headers: { "User-Agent": SLACK } });
    assert.equal(shell.status, 200, "the stub page is served");
    assert.equal(shell.status, unknown.status);
    assert.equal(await shell.text(), await unknown.text());
    assert.equal((await fetch(`${base}/api/h/${closed.token}`, { headers: h })).status, 410);
    assert.equal((await fetch(`${base}/api/h/${"R".repeat(43)}`, { headers: h })).status, 404);
    // The socket's close handler writes the visit's "seen" line; wait for it, not for a guess.
    const seen = () => {
      const id = lines().find((l) => l.kind === "visit" && l.personId === maria.id)?.id;
      return lines().some((l) => l.kind === "seen" && l.id === id);
    };
    for (const end = Date.now() + 10_000; !seen() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    const mine = lines().filter((l) => l.personId === maria.id || (l.kind === "seen" && lines().some((x) => x.id === l.id && x.personId === maria.id)));
    const kinds = mine.map((l) => l.kind);
    assert.equal(kinds.filter((k) => k === "visit").length, 1, "one visit for the reload and the socket");
    assert.ok(kinds.includes("seen"), "the socket's close");
    assert.ok(kinds.includes("preview"));
    assert.ok(kinds.includes("refused"));
    const visit = mine.find((l) => l.kind === "visit")!;
    assert.equal(visit.tab, v);
    assert.equal(visit.device, "Safari · iPhone");
    const text = readFileSync(file, "utf8");
    for (const secret of [c.token!, closed.token!, links.hashToken(c.token!), links.hashToken(closed.token!), c.token!.slice(0, 6), XFF, "127.0.0.1", IPHONE, SLACK, "Mozilla"])
      assert.ok(!text.includes(secret), `never ${secret.slice(0, 12)}`);
  });
});
