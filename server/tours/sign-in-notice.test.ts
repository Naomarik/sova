// A recording waiting for a sign-in marks its chat and tells its agent once (§app.tours/sites); a chat
// Sova can't prompt (open in a terminal) gets only the mark, and is never written to.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { parseWakeNudge, wakeTitle } from "../../shared/wake";
import type { AttentionRow } from "../attention";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-tour-sign-in-notice-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
after(() => rmSync(agentDir, { recursive: true, force: true }));
// Every module that computes a state path is imported only now, so all of them land in agentDir (a static
// import is evaluated before the line above, and would read the runner's own agent dir).
const { setTourSignInWaits, tourSignInNoticeText, tourSignInNotifier, tourSignInWaits } = await import("./sign-in-notice");
const { sessionItems } = await import("../attention");
const { LIVE_DIR } = await import("../paths");

const ORIGIN = "https://app.example";
const event = (over: Record<string, unknown> = {}) => ({ sessionId: "s1", tourId: "tour-a", jobId: "job-a", origin: ORIGIN, fields: ["username", "password"], ...over });
const flush = () => new Promise(r => setTimeout(r, 20));

test("the notice is a tour wake, never a user prompt, naming only the site and what's needed", () => {
  const text = tourSignInNoticeText(3, event());
  const wake = parseWakeNudge(text);
  assert.deepEqual(wake, { id: "t3", tour: true, reason: `Sign in to ${ORIGIN} on the tour card.` });
  assert.equal(wakeTitle(wake!), "Tour sign-in");
  assert.equal(parseWakeNudge(tourSignInNoticeText(4, event({ fields: ["code"] })))?.reason, `Enter the sign-in code for ${ORIGIN} on the tour card.`);
  assert.equal(parseWakeNudge(`Hi\n${text}`), null, "only a tag opening the message counts");
  assert.match(text, /tour card in this chat/);
});

test("each entry into needs-sign-in prompts its chat once, keyed so a repeat is delivered once", async () => {
  const sent: { path: string; text: string; key: string }[] = [];
  const notify = tourSignInNotifier({ pathOf: async id => (id === "s1" ? "/sessions/s1.jsonl" : null), prompt: async (path, text, key) => (sent.push({ path, text, key }), { ok: true }) });
  notify(event());
  notify(event({ fields: ["code"] }));
  notify(event({ sessionId: "gone", jobId: "job-b" }));
  notify(event({ jobId: "../x" }));
  await flush();
  assert.deepEqual(sent.map(s => [s.path, s.key]), [["/sessions/s1.jsonl", "tour-sign-in:job-a:1"], ["/sessions/s1.jsonl", "tour-sign-in:job-a:2"]]);
  assert.match(sent[1]!.text, /sign-in code/);
});

test("a chat open in a terminal is never written to: the prompt is refused, logged, not retried", async () => {
  const dir = join(agentDir, "sessions", "--tmp-tour--");
  mkdirSync(dir, { recursive: true });
  // The stand-in terminal's live record is the test's own, in the test's agent dir.
  assert.equal(LIVE_DIR, join(agentDir, "sessions", "live"), "setup: live records are read from this test's agent dir");
  mkdirSync(LIVE_DIR, { recursive: true });
  const path = join(dir, "2026-10-15T00-00-00-000Z_s-live.jsonl");
  writeFileSync(path, [{ type: "session", version: 3, id: "s-live", timestamp: "2026-10-15T00:00:00.000Z", cwd: agentDir }, { type: "message", id: "u1", parentId: null, timestamp: "2026-10-15T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } }].map(e => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(LIVE_DIR, "p-other.json"), JSON.stringify({ heartbeat: Date.now(), session: { sessionFile: path, pid: process.ppid, mode: "tui", status: "idle" }, presence: { status: "idle", workerCounts: { total: 0, working: 0, waiting: 0, done: 0, error: 0, killed: 0 } } }));
  const before = readFileSync(path, "utf8");
  // Precondition: the stand-in terminal's record reads as live here. If it doesn't (a runner whose parent pid
  // this process can't see), the refusal below would come from somewhere else and prove nothing.
  const { readLiveRecords } = await import("../live");
  assert.ok(readLiveRecords().some(r => r.sessionFile === path), `precondition: the terminal record (pid ${process.ppid}) reads as live`);
  const { promptSession } = await import("../session-prompt");
  const logs: string[] = []; let prompts = 0;
  const notify = tourSignInNotifier({ pathOf: async () => path, prompt: (p, text, key) => (prompts++, promptSession(p, text, undefined, "followUp", undefined, key)), log: l => logs.push(l) });
  notify(event({ sessionId: "s-live" }));
  for (let i = 0; i < 100 && !logs.length; i++) await flush();
  assert.equal(prompts, 1, "tried once, never again");
  assert.match(logs[0] ?? "", /wasn't delivered: .*open in a terminal/);
  assert.equal(readFileSync(path, "utf8"), before, "the chat's file is untouched");
});

test("the digest marks a chat whose recording waits for a sign-in, an act item with the card's words", () => {
  setTourSignInWaits(() => [
    { sessionId: "s1", origin: ORIGIN, fields: ["username", "password"], since: 2000 },
    { sessionId: "s1", origin: "https://idp.example", fields: ["code"], since: 1000 },
    { sessionId: "s2", origin: ORIGIN, fields: ["code"], since: 3000 },
  ]);
  const waits = tourSignInWaits();
  assert.deepEqual(waits.get("s1"), { origin: "https://idp.example", code: true, since: 1000 }, "the oldest wait of a chat");
  assert.equal(waits.get("s2")?.code, true);
  setTourSignInWaits(() => { throw new Error("runtime not ready"); });
  assert.equal(tourSignInWaits().size, 0, "a failing source marks nothing");
  setTourSignInWaits(undefined);
  const summary = { id: "s1", path: "/sessions/s1.jsonl", title: "Tour", cwd: "/w", lastActiveAt: "2026-10-15T00:00:00.000Z" } as unknown as SessionSummary;
  const row = (over: Partial<AttentionRow> = {}): AttentionRow => ({ summary, dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0, ...over });
  const items = sessionItems(row({ tourSignIn: { origin: ORIGIN, code: false, since: 5000 } }), 10_000, "/home/x");
  const item = items.find(i => i.kind === "tour-sign-in");
  assert.equal(item?.tier, "act");
  assert.equal(item?.since, 5000);
  assert.equal(item?.detail, `Sign in to ${ORIGIN} on the tour card.`);
  assert.equal(sessionItems(row({ tourSignIn: { origin: ORIGIN, code: true, since: 5000 } }), 10_000).find(i => i.kind === "tour-sign-in")?.detail, `Enter the sign-in code for ${ORIGIN} on the tour card.`);
  assert.equal(sessionItems(row(), 10_000).some(i => i.kind === "tour-sign-in"), false, "control: no wait, no item");
  assert.equal(sessionItems({ ...row({ tourSignIn: { origin: ORIGIN, code: false, since: 1 } }), summary: { ...summary, archived: true } as SessionSummary }, 10_000).some(i => i.kind === "tour-sign-in"), false);
});
