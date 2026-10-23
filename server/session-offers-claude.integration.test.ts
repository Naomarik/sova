// Blocker b1 (§chat.offers/tool): a Claude Code chat's `offer` tool is built only from the snapshot taken at
// its first build, so a later edit of the project's offers file never changes its tools, and the chat resumes
// its own Claude session instead of replaying its history (§app.claude-code-provider/continuity). Checked by
// what the model is offered: the real Claude Code bridge, driving the stand-in `claude` (scripts/fake-claude.mjs),
// which with FAKE_CLAUDE_RECORD asks the bridge's MCP server for tools/list at each turn and records each
// tool's schema and the child's argv. The control case drops the snapshot and sees the edit, and a fold:
// the check can tell the two apart. A throwaway PI_CODING_AGENT_DIR and Claude login dir; ~/.pi is never read.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-offers-cc-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const loginDir = join(root, "claude");
mkdirSync(loginDir, { recursive: true });
writeFileSync(join(loginDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }));
process.env.CLAUDE_CONFIG_DIR = loginDir;
const recordFile = join(root, "claude-record.jsonl");
process.env.FAKE_CLAUDE_RECORD = recordFile;
process.env.FAKE_CLAUDE_ONESHOT = "1";
const sessionsDir = join(agentDir, "sessions", "--offers-cc--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

// The project: a plain folder (its own project root) with an offers file.
const project = join(root, "project");
mkdirSync(join(project, ".sova"), { recursive: true });
const offer = (title: string) => ({ when: `When ${title} fits.`, title, repeat: "once-per-session", buttons: [{ label: "Go", about: `Sends go for ${title}.`, send: "go" }] });
const writeOffers = (names: string[]) => writeFileSync(join(project, ".sova", "offers.json"), JSON.stringify({ version: 1, offers: Object.fromEntries(names.map((n) => [n, offer(n)])) }));

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats, disposeHeldChat, warmChatRuntime } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { offersDir, resetOffersForTest } = await import("./session-offers");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

type Line = { argv?: string[]; tools?: string[]; schemas?: Record<string, { properties?: { offer?: { enum?: string[] } } } | null>; frame?: { message?: { content?: unknown } } };
/** Each user turn the fake heard, in order. */
const turns = (): Line[] =>
  existsSync(recordFile)
    ? readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line).filter((l) => l.frame && l.tools)
    : [];
const offerEnum = (l: Line) => l.schemas?.offer?.properties?.offer?.enum;
const sent = (l: Line) => JSON.stringify(l.frame?.message?.content ?? "");

/** A session on the claude-code-cli model, in the project, with no message yet. */
function session(id: string): string {
  const path = join(sessionsDir, `2026-10-23T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-23T00:00:00.000Z", cwd: project }),
      JSON.stringify({ type: "model_change", id: `${id}-m`, parentId: null, timestamp: "2026-10-23T00:00:00.000Z", provider: "claude-code-cli", modelId: "claude-opus-5-5" }),
    ].join("\n") + "\n",
  );
  return canonicalPath(path);
}

describe("a Claude Code chat's offer tool across a resume", async () => {
  await warmChatRuntime();

  test("the file gains an offer; the reopened chat resumes its Claude session and still offers only the first", async () => {
    writeOffers(["alpha"]);
    const path = session("01a2b3c4-0000-7000-8000-000000000001");
    let chat = await acquireChat(path, true);
    await chat.acceptPrompt("hello", undefined, "server").turn;
    const first = turns();
    assert.equal(first.length, 1, `one recorded turn: ${existsSync(recordFile) ? readFileSync(recordFile, "utf8").slice(0, 2000) : "none"}`);
    assert.ok(first[0]!.tools!.includes("offer"), `the offer tool reached the CLI: ${first[0]!.tools}`);
    assert.deepEqual(offerEnum(first[0]!), ["alpha"]);

    writeOffers(["alpha", "charlie"]);
    // Its child goes with the chat; the reopened chat's first turn starts a new child.
    await disposeHeldChat(path, "test: reopen");
    chat = await acquireChat(path, true);
    await chat.acceptPrompt("again", undefined, "server").turn;
    const second = turns()[1]!;
    assert.ok(second, "a second recorded turn");
    assert.ok(second.argv!.includes("--resume"), `the new child resumes its Claude session: ${second.argv!.join(" ")}`);
    assert.ok(!/condensed, lossy replay|started before you joined/.test(sent(second)), `no folded history: ${sent(second).slice(0, 300)}`);
    assert.ok(sent(second).includes("again"));
    assert.deepEqual(offerEnum(second), ["alpha"], "the tool still names only the snapshot's offers");
    await disposeHeldChat(path, "test: done");
  });

  test("control: with its snapshot dropped, the reopened chat sees the edit, so its tools change and it folds", async () => {
    writeOffers(["alpha"]);
    const path = session("01a2b3c4-0000-7000-8000-000000000002");
    let chat = await acquireChat(path, true);
    const before = turns().length;
    await chat.acceptPrompt("hello", undefined, "server").turn;
    assert.deepEqual(offerEnum(turns()[before]!), ["alpha"]);

    writeOffers(["alpha", "charlie"]);
    await disposeHeldChat(path, "test: reopen");
    rmSync(join(offersDir(), "01a2b3c4-0000-7000-8000-000000000002.json"), { force: true });
    resetOffersForTest();
    chat = await acquireChat(path, true);
    await chat.acceptPrompt("again", undefined, "server").turn;
    const second = turns()[before + 1]!;
    assert.deepEqual(offerEnum(second), ["alpha", "charlie"], "a new snapshot reads the file as it is now");
    assert.ok(!second.argv!.includes("--resume"), "a changed tool set never resumes");
    await disposeHeldChat(path, "test: done");
  });
});
