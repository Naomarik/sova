// The Project Assistant closes and reopens the owner's requests only on their yes in the current turn
// (§app.project-assistant/tools, /closing): owner_requests' per-conversation handles, the first call changing nothing
// and naming the requests back, the second acting only when the owner's own message (never the operator's) came right
// after that ask and is the newest, done and declined never reopened, several closed at once, recorded as the
// assistant's for the owner. A throwaway workspace; closing's side effects stood in; no model runs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BATON_SENT_ENTRY, OPERATOR } from "../shared/baton";
import type { HEntry, ToolSpec } from "../shared/harness";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-assistant-close-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "site"), { recursive: true });
const orgs = await import("./orgs");
const owner = await import("./owner");
const store = await import("./project-assistant-store");
const close = await import("./owner-request-close");
const { assistantRequestTools, ownerAnsweredAsk, requestHandle } = await import("./assistant-request-tools");
after(() => {
  close.setCloseDepsForTest(null);
  rmSync(root, { recursive: true, force: true });
});
close.setCloseDepsForTest({ cancelHeldStart: async () => 0, endFeatureChat: async () => {}, note: async () => true });

const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const omar = await orgs.addPerson(org.id, { name: "Omar Haddad", role: "Founder" });
await owner.setOwner(org.id, omar.id);
const proj = await orgs.addProject(org.id, { name: "Archery website", root: join(root, "site") });
const sessionId = "assistant-session-1";

/** A conversation's branch, built up as a turn would: user messages (marked as the owner's or the operator's), tool results. */
let branch: HEntry[] = [];
let n = 0;
const user = (by: "owner" | "operator", text = "yes") => {
  const id = `u${++n}`;
  branch.push({ kind: "user", id, parentId: null, blocks: [{ type: "text", text }] } as HEntry);
  if (by === "owner") branch.push({ kind: "state", id: `m${n}`, parentId: id, key: BATON_SENT_ENTRY, data: { v: 1, targetId: id, by: omar.id } } as HEntry);
  else branch.push({ kind: "state", id: `m${n}`, parentId: id, key: BATON_SENT_ENTRY, data: { v: 1, targetId: id, by: OPERATOR } } as HEntry);
};
const tools = assistantRequestTools({ orgId: org.id, sessionId, owner: () => ({ id: omar.id, name: omar.name }), projects: () => [{ id: proj.id, name: proj.name }], branch: () => branch });
const tool = (name: string) => tools.find((t) => t.name === name) as ToolSpec;
/** Run a tool as the model would, its result landing in the branch. */
async function call(name: string, params: Record<string, unknown>) {
  const out = (await tool(name).execute("c1", params as never, undefined, undefined, { branch: () => branch } as never)) as { content: { text: string }[]; details: Record<string, unknown> };
  branch.push({ kind: "tool-result", id: `t${++n}`, parentId: null, tool: name, blocks: [], details: out.details } as HEntry);
  return out;
}
const file = (title: string) => store.fileRequest(org.id, { projectId: proj.id, kind: "bug", title, text: "x" });

test("owner_requests names each request by a handle of this conversation, never its id", async () => {
  const r = file("The bow page is slow");
  const text = (await call("owner_requests", {})).content[0]!.text;
  assert.ok(text.includes(`[${requestHandle(sessionId, r.id)}] The bow page is slow`), text);
  assert.ok(!text.includes(r.id), "no request id");
  assert.notEqual(requestHandle(sessionId, r.id), requestHandle("another-session", r.id), "per conversation");
});

test("close: the first call closes nothing and names it back; the owner's yes next makes the second call close it", async () => {
  branch = [];
  const r = file("Wrong prices");
  const h = requestHandle(sessionId, r.id);
  const ask = await call("close_request", { requests: [h] });
  assert.match(ask.content[0]!.text, /^Nothing is closed yet\. Ask the owner[\s\S]*"Wrong prices" \(Archery website, with the team\)/);
  assert.equal(store.findRequest(org.id, r.id)?.status, "with-team");
  // Called again in the same turn, with no message from the owner since: still nothing.
  assert.match((await call("close_request", { requests: [h] })).content[0]!.text, /^Nothing is closed yet/);
  user("owner", "Yes, close it");
  const done = await call("close_request", { requests: [h] });
  assert.match(done.content[0]!.text, /^Closed:/);
  const after = store.findRequest(org.id, r.id)!;
  assert.deepEqual([after.status, after.closed?.by], ["closed", { kind: "assistant", personId: omar.id }]);
});

test("the operator's message is no yes; neither is an answer two messages back, nor an ask for other requests", async () => {
  branch = [];
  const a = file("A");
  const b = file("B");
  const [ha, hb] = [requestHandle(sessionId, a.id), requestHandle(sessionId, b.id)];
  await call("close_request", { requests: [ha] });
  user("operator", "yes");
  assert.match((await call("close_request", { requests: [ha] })).content[0]!.text, /^Nothing is closed yet/, "the operator's yes");
  user("owner", "yes");
  user("owner", "actually wait");
  assert.equal(ownerAnsweredAsk(branch, "close_request", "close", [ha]), false, "the newest message isn't the one right after the ask");
  await call("close_request", { requests: [ha] });
  user("owner", "yes");
  assert.equal(ownerAnsweredAsk(branch, "close_request", "close", [ha, hb]), false, "asked about A only");
  // Several at once: asked about both, then a yes closes both.
  await call("close_request", { requests: [ha, hb] });
  user("owner", "yes, both");
  assert.match((await call("close_request", { requests: [hb, ha] })).content[0]!.text, /^Closed:/);
  assert.deepEqual([store.findRequest(org.id, a.id)?.status, store.findRequest(org.id, b.id)?.status], ["closed", "closed"]);
});

test("reopen: only a request the owner closed, on their yes; done and declined are the team's", async () => {
  branch = [];
  const r = file("Gift cards");
  store.closeRequestLine(org.id, r.id, { kind: "owner", personId: omar.id });
  const h = requestHandle(sessionId, r.id);
  assert.match((await call("reopen_request", { request: h })).content[0]!.text, /^Nothing is reopened yet/);
  user("owner", "yes please");
  assert.match((await call("reopen_request", { request: h })).content[0]!.text, /^Reopened: "Gift cards", now with the team/);
  const d = file("Done one");
  store.setRequestStatus(org.id, d.id, "done");
  await assert.rejects(() => call("reopen_request", { request: requestHandle(sessionId, d.id) }), /only the team changes that/);
  await assert.rejects(() => call("close_request", { requests: [requestHandle(sessionId, d.id)] }), /Not open, so not closed/);
  await assert.rejects(() => call("close_request", { requests: ["req-nothere"] }), /none of the owner's requests/);
});
