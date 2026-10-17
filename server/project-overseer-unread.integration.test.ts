// Run: pnpm test:int -- server/project-overseer-unread.integration.test.ts. A project overseer's count of
// unseen replies (SessionSummary.unreadReplies, §app.overseer/seen) is the same on the session list, on a
// single-row refresh and on the project overseer page. A throwaway PI_CODING_AGENT_DIR, an org workspace
// and a project root in the OS temp dir; ~/.pi is never touched. No model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-unread-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

await import("./testing/in-process-chats");
const orgs = await import("./orgs");
const po = await import("./project-overseer");
const { getSessionSummary, listSessions } = await import("./sessions-index");
const { markSeen, readSeen } = await import("./seen");
const { settled } = await import("./workspace-git");
const { sessionsChanged } = await import("./list-generation");
const { disposeAllChats } = await import("./chat-manager");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

let n = 0;
/** Appends a user message and `replies` finished replies (with a tool step before each), newer than `t0`. */
function appendTurn(path: string, replies: number, t0: number): void {
  let leaf = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!).id as string;
  const lines: string[] = [];
  const add = (message: Record<string, unknown>, t: number) => {
    const id = `t${String(++n).padStart(7, "0")}`;
    lines.push(JSON.stringify({ type: "message", id, parentId: leaf, timestamp: new Date(t).toISOString(), message: { ...message, timestamp: t } }));
    leaf = id;
  };
  let t = t0;
  add({ role: "user", content: [{ type: "text", text: "how is it going?" }] }, (t += 10));
  for (let i = 0; i < replies; i++) {
    add({ role: "assistant", content: [{ type: "text", text: "a step" }], stopReason: "toolUse" }, (t += 10));
    add({ role: "assistant", content: [{ type: "text", text: `reply ${i}` }], stopReason: "stop" }, (t += 10));
  }
  appendFileSync(path, lines.map((l) => `${l}\n`).join(""));
}

test("the list, a single-row refresh and the project overseer page carry the same unseen-reply count", async () => {
  const org = await orgs.createOrg({ name: "Amal", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "AmalMoney", root: join(root, "proj") });
  const made = await po.ensureProjectOverseer(project.id);

  // Opening it stamps it seen; a stamp never goes backwards, so the replies come after it.
  markSeen(made.id);
  const seenAt = readSeen()[made.id]!;
  appendTurn(made.path, 2, seenAt + 1_000);

  const listed = (await listSessions()).find((s) => s.id === made.id);
  assert.ok(listed, "the overseer's conversation is listed");
  assert.equal(listed.unread, true);
  assert.equal(listed.unreadReplies, 2);
  const one = await getSessionSummary(listed.path);
  assert.equal(one?.unread, true);
  assert.equal(one?.unreadReplies, 2, "a single-row refresh keeps the count");
  assert.equal((await po.projectOverseerInfo(project.id)).unread, 2, "the page's count is the same");

  // More replies: every reader follows.
  appendTurn(made.path, 3, seenAt + 2_000);
  assert.equal((await getSessionSummary(listed.path))?.unreadReplies, 5);
  sessionsChanged(); // a listing is reused for 1 s (§app.session-list/listing-reuse): build a new one
  assert.equal((await listSessions()).find((s) => s.id === made.id)?.unreadReplies, 5);

  // Seen again: neither unread nor counted, on the list and on a refresh.
  markSeen(made.id, seenAt + 60_000);
  const read = await getSessionSummary(listed.path);
  assert.equal(read?.unread, undefined);
  assert.equal(read?.unreadReplies, undefined);
  assert.equal((await listSessions()).find((s) => s.id === made.id)?.unreadReplies, undefined);
});

test("an ordinary session never carries the count", async () => {
  const rows = await listSessions();
  for (const s of rows) if (!s.projectOverseer) assert.equal(s.unreadReplies, undefined, s.path);
});
