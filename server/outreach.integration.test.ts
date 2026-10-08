// Run: node scripts/run-tests.mjs server/outreach.integration.test.ts
// §app/outreach with the WhatsApp sender as a real child (scripts/fake-whatsapp-sender.mjs) on its Unix
// socket: a send's round trip with its receipts, the sender going down, and Sova reaching it again
// after it restarts. Outreach's rules with the sender in-process: outreach.test.ts.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ABSENT, agent, ann, cleanup, gathering, json, logOf, org, project, root, senderOpen, sendLink, socket } from "./outreach-test-fixtures";

const { resetLocalClient } = await import("./outreach/whatsapp");
const { liveLinks } = await import("./baton-links");
const { dropTokens } = await import("./link-tokens");
const { batonById } = await import("./baton");

let fake: ChildProcess | null = null;
async function startSender(): Promise<void> {
  fake = spawn(process.execPath, [join(import.meta.dirname, "..", "scripts", "fake-whatsapp-sender.mjs")], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, SOVA_WA_FAKE_ABSENT: ABSENT },
    stdio: "ignore",
  });
  const end = Date.now() + 15_000; // a hang guard
  while (!existsSync(socket)) {
    if (Date.now() > end) throw new Error("the fake sender didn't start");
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function stopSender(): Promise<void> {
  if (!fake) return;
  const f = fake;
  fake = null;
  if (f.exitCode === null && f.signalCode === null) {
    const gone = new Promise((r) => f.once("exit", r));
    f.kill("SIGTERM");
    const t = setTimeout(() => f.kill("SIGKILL"), 2000);
    await gone;
    clearTimeout(t);
  }
  rmSync(socket, { force: true });
  resetLocalClient();
}

after(async () => {
  await stopSender();
  await cleanup();
});
process.on("exit", () => {
  fake?.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

describe("§app.outreach/send-link and /sender-route: the sender as a real child", () => {
  before(async () => {
    await startSender();
  });

  test("sent, with no kept link (one made before tokens were kept): a fresh link replaces the older ones, the log holds no number, token or text; receipts follow", async () => {
    assert.equal((await json("PUT", "/api/outreach", { sender: { local: {} } })).status, 200);
    await senderOpen();
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const firstLinks = liveLinks(sid, n).map((l) => l.hash);
    // A kept live link would be sent as it is (outreach.test.ts covers that); this is the mint path.
    dropTokens(firstLinks);
    const r = await sendLink(sid);
    assert.deepEqual(r.body, { outcome: "sent", channel: "whatsapp", name: "Ann" });
    const now = liveLinks(sid, n);
    assert.equal(now.length, 1, "one live link: the one sent");
    assert.ok(!firstLinks.includes(now[0]!.hash), "the start's link was turned off");
    const log = readFileSync(join(root, "ws", "outreach.jsonl"), "utf8");
    assert.doesNotMatch(log, /5550000100|share\.example\.com|\/h\/|asked you/);
    const sent = logOf().filter((l) => l.sessionId === sid);
    assert.deepEqual(sent.map((l) => l.event), ["sent"]);
    assert.equal(sent[0]!.by, "operator");
    // the fake answers delivered then read
    const end = Date.now() + 15_000; // the fake's receipts come 0.5 s and 1 s after the send; a hang guard
    while (logOf().filter((l) => l.sessionId === sid).length < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(logOf().filter((l) => l.sessionId === sid).map((l) => l.event), ["sent", "delivered", "read"]);
    // the person page lists it
    const page = await json("GET", `/api/orgs/${org.id}/people/${ann.id}`);
    assert.equal(page.body.sends?.[0]?.event, "read");
    assert.equal(page.body.sends?.[0]?.what, "Office hours");
  });

  test("the sender is down: failed, retryable, with why; nothing stays minted", async () => {
    await stopSender();
    const sid = await gathering(ann.id);
    const n = batonById(sid)!.row.handoffs.at(-1)!.n;
    const before = liveLinks(sid, n).map((l) => l.hash);
    const r = await sendLink(sid);
    assert.equal(r.body.outcome, "failed");
    assert.equal(r.body.code, "unreachable");
    assert.equal(r.body.retryable, true);
    assert.deepEqual(liveLinks(sid, n).map((l) => l.hash), before, "nothing new stays minted; the older link is untouched");
    const info = await json("GET", "/api/outreach");
    assert.equal(info.body.sender.state, "unreachable");
  });

  test("the sender comes back: a new child on the same socket, the setting saved, and a note goes", async () => {
    await startSender();
    // A save of the setting makes the connection afresh, so no retry gap is waited out.
    await json("PUT", "/api/outreach", { sender: { local: {} }, paused: false });
    await senderOpen();
    const r = await json("POST", "/api/outreach/send", { orgId: org.id, projectId: project.id, personId: ann.id, note: "The prototype is ready to try." });
    assert.equal(r.body.outcome, "sent", JSON.stringify(r.body));
    assert.equal(logOf().filter((l) => l.personId === ann.id).at(-1)!.event, "sent");
  });
});
