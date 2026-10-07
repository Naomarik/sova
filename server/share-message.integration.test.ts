// Run: node scripts/run-tests.mjs server/share-message.integration.test.ts. The share listener's
// hardening over a real loopback socket: an oversized frame, a body that never arrives, a sweep
// closing a link that stops reading. A throwaway PI_CODING_AGENT_DIR and workspace in the OS temp
// dir; ~/.pi untouched. The share message path in process is share-message.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import WebSocket from "ws";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-msg-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const links = await import("./baton-links");
const { disposeAllChats } = await import("./chat-manager");
const { createShareServer } = await import("./share/listener");
const { sweepWatchers } = await import("./share/hub");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
const start = (to: string | string[], extra: Record<string, unknown> = {}) => baton.createBaton({ orgId: org.id, projectId: project.id, to, publicTitle: "Hosting", goal: "Find the server", ...extra });

/** Resolves once `ready` holds, checked every 10 ms; throws after 10 s (a hang guard, not a bound). */
async function until(ready: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (const end = Date.now() + 10_000; !(await ready()); await new Promise((r) => setTimeout(r, 10)))
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
}

describe("the share listener", async () => {
  const server = createShareServer({ headersMs: 300, requestMs: 300, checkMs: 50 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  after(() => {
    server.close();
    server.closeAllConnections();
  });
  const open = async (token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/h?token=${token}`);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("error", () => {});
    await new Promise((r) => ws.on("open", r));
    return { ws, closed };
  };

  test("an oversized frame closes the socket without an uncaught exception", async () => {
    const caught: unknown[] = [];
    const onUncaught = (err: unknown) => caught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      const { ws, closed } = await open((await start(tony.id)).token!);
      ws.send("x".repeat(5000));
      assert.equal(await closed, 1009);
      // The server has dropped the connection: its handling of the frame is over.
      await until(() => new Promise<boolean>((r) => server.getConnections((_e, n) => r(n === 0))), "the listener's connections closed");
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    assert.deepEqual(caught, []);
  });

  test("a body that never arrives is answered 408 at the request timeout, not five minutes later", async () => {
    const token = (await start(tony.id)).token!; // a real link: the route waits for the body
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write(`POST /api/h/${token}/message HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\n`);
      });
      let data = "";
      sock.on("data", (d) => (data += d));
      sock.on("close", () => resolve(data));
      sock.on("error", reject);
      // A hang guard only: the 408 itself is the request timeout (300 ms here) firing, which a
      // server waiting out the default five minutes would never send within it.
      setTimeout(() => (sock.destroy(), resolve(data)), 30_000);
    });
    assert.match(reply, /^HTTP\/1\.1 408/);
  });

  test("an open socket on a link that stops reading is closed by the sweep, without waiting for a change", async () => {
    const c = await start(tony.id);
    const { closed } = await open(c.token!);
    assert.equal(sweepWatchers(), 0, "a live link stays");
    links.revokeLinks((l) => l.sessionId === c.sessionId);
    assert.equal(sweepWatchers(), 1);
    assert.equal(await closed, 4410);
  });
});
