import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpNote, McpProjectServers, McpRowState, SetupMcp } from "../../shared/mcp";
import {
  type AddFields,
  canSend,
  chatNoteText,
  editedServer,
  errorLineText,
  isReservedName,
  mcpFlips,
  mcpToolWords,
  newServer,
  noteOnHost,
  NO_CHECK,
  projectGroups,
  refusedLines,
  RESERVED_ROW,
  rowFacts,
  setupLine,
  setupOffLine,
  setupShows,
  stateTone,
  stateWord,
  toolCountLabel,
} from "./mcp";

const fields = (over: Partial<AddFields> = {}): AddFields => ({ address: "", command: "", paste: "", secret: "", secretName: "", ...over });

test("a row's facts: its kind and a digit count, with 1 tool in the singular", () => {
  assert.equal(rowFacts({ kind: "address", toolCount: 6 }), "Address · 6 tools");
  assert.equal(rowFacts({ kind: "command", toolCount: 1 }), "Command · 1 tool");
  assert.equal(toolCountLabel(0), "0 tools");
});

test("every state has its word, and Off and No Check yet carry no tone", () => {
  const words: Record<McpRowState, string> = { waiting: "Waiting for You", off: "Off", "needs-sign-in": "Needs Sign-in", failed: "Failed", connected: "Connected", "no-check": "No Check yet" };
  for (const [s, w] of Object.entries(words)) assert.equal(stateWord(s as McpRowState), w);
  assert.equal(stateTone("failed"), "error");
  assert.equal(stateTone("connected"), "success");
  assert.equal(stateTone("off"), undefined);
  assert.equal(stateTone("no-check"), undefined);
});

test("sova is reserved in any case, and a name that merely holds it isn't", () => {
  for (const n of ["sova", "SOVA", " Sova "]) assert.equal(isReservedName(n), true);
  for (const n of ["sovereign", "my-sova", ""]) assert.equal(isReservedName(n), false);
  assert.equal(canSend("address", fields({ address: "https://x" }), "Sova"), false);
});

test("a refused entry says why, and a missing secret is left to its own field", () => {
  assert.deepEqual(refusedLines(undefined), []);
  assert.deepEqual(refusedLines({ why: "reserved" }), [RESERVED_ROW]);
  assert.deepEqual(refusedLines({ why: "bad-value", names: ["HOME"] }), ["HOME isn't a saved secret, so this server won't start."]);
});

test("an error line says which chat, and how it ran", () => {
  assert.equal(errorLineText({ line: "boom" }), "boom");
  assert.equal(errorLineText({ line: "boom", chat: "Fix it" }), "In Fix it: boom");
  assert.equal(errorLineText({ line: "boom", chat: "Fix it", where: "sandbox" }), "In Fix it, inside its sandbox: boom");
  assert.equal(errorLineText({ line: "boom", chat: "w1", where: "write-only" }), "In w1, under write-only confinement: boom");
});

test("Add and Check: a command's secret needs its name, an address's doesn't, and an empty secret sends none", () => {
  assert.equal(canSend("command", fields({ command: "npx x", secret: "v" }), "a"), false);
  assert.equal(canSend("command", fields({ command: "npx x", secret: "v", secretName: "KEY" }), "a"), true);
  assert.equal(canSend("address", fields({ address: "https://x", secret: "v" }), "a"), true);
  assert.equal(canSend("paste", fields(), "a"), false);
  assert.equal(canSend("address", fields({ address: "https://x" }), ""), false);
  assert.equal(canSend("address", fields({ address: "https://x" }), null), true, "Edit has no name to check");
  assert.deepEqual(newServer("address", " a ", fields({ address: " https://x " })), { way: "address", name: "a", address: "https://x" });
  assert.deepEqual(newServer("command", "a", fields({ command: "npx x", secret: "v", secretName: " KEY " })), { way: "command", name: "a", command: "npx x", secret: "v", secretName: "KEY" });
  assert.deepEqual(newServer("command", "a", fields({ command: "npx x", secretName: "KEY" })), { way: "command", name: "a", command: "npx x" }, "no secret, no name for one");
  assert.deepEqual(newServer("paste", "a", fields({ paste: "{}", secret: "stale" })), { way: "paste", name: "a", text: "{}" }, "a Secret typed on another tab never leaves with a paste");
  assert.deepEqual(editedServer("address", fields({ address: "https://x" })), { address: "https://x" });
});

test("a project's groups: a checkout with no file drops out, and a broken one stays", () => {
  const c = (folder: string, file: "missing" | "ok" | "broken", n = 0): McpProjectServers["checkouts"][number] => ({ folder, file, servers: Array(n).fill({}) });
  assert.deepEqual(projectGroups({ checkouts: [c("a", "missing"), c("b", "missing")] }), []);
  assert.deepEqual(projectGroups({ checkouts: [c("a", "missing"), c("b", "ok", 1), c("c", "broken")] }).map((x) => x.folder), ["b", "c"]);
});

const row = (over: Partial<SetupMcp["rows"][number]>): SetupMcp["rows"][number] => ({ name: "docs", source: "computer", on: true, newChats: true, ...over });

test("the card sends only what differs from New Chats, in both directions, and leaves a row with no switch alone", () => {
  const m: SetupMcp = { rows: [row({ name: "a" }), row({ name: "b", on: false, newChats: false }), row({ name: "c", on: false, off: "waiting" })] };
  assert.deepEqual(mcpFlips(m), { offMcp: [], onMcp: [] });
  assert.deepEqual(mcpFlips(m, { name: "a", on: false }), { offMcp: ["a"], onMcp: [] });
  assert.deepEqual(mcpFlips(m, { name: "b", on: true }), { offMcp: [], onMcp: ["b"] });
  assert.deepEqual(mcpFlips({ rows: [row({ name: "a", on: false }), row({ name: "b", on: true, newChats: false })] }, { name: "a", on: true }), { offMcp: [], onMcp: ["b"] }, "a flip keeps the chat's other choices");
  assert.deepEqual(mcpFlips(undefined), { offMcp: [], onMcp: [] });
});

test("a setup row with no switch says why, naming where to approve it", () => {
  assert.equal(setupOffLine(row({})), null);
  assert.equal(setupOffLine(row({ off: "waiting" })), "Waiting for You. Approve it in Settings → MCP Servers.");
  assert.equal(setupOffLine(row({ off: "waiting", source: "project" })), "Waiting for You. Approve it on the project page.");
  assert.equal(setupOffLine(row({ off: "no-check" })), NO_CHECK);
  assert.equal(setupOffLine(row({ off: "sandbox" })), "Address servers stay off while the sandbox is On.");
  assert.equal(setupOffLine(row({ off: "address-in-chat" })), "Address servers don't run in chats yet.");
});

test("the group: one line for remote and a profile, none at all with no servers", () => {
  assert.equal(setupLine({ line: { why: "remote", target: "box" }, rows: [] }), "MCP servers don't run in remote chats: they would run here while this chat's files are on box.");
  assert.equal(setupLine({ line: { why: "profile", profile: "Reader" }, rows: [] }), "Reader removes MCP servers.");
  assert.equal(setupLine({ rows: [row({})] }), null);
  assert.equal(setupShows(undefined), false);
  assert.equal(setupShows({ rows: [] }), false);
  assert.equal(setupShows({ rows: [], notProject: true }), true);
});

test("a chat's note reads each way a server can fail", () => {
  const n = (o: Partial<McpNote>): McpNote => ({ server: "docs", how: "failed", ...o });
  assert.equal(chatNoteText(n({ reason: "no key" })), "docs failed: no key.");
  assert.equal(chatNoteText(n({ reason: "no key." })), "docs failed: no key.", "never two full stops");
  assert.equal(chatNoteText(n({ how: "sandbox" })), "docs failed inside this chat's sandbox. It may need something the sandbox blocks.");
  assert.equal(chatNoteText(n({ how: "write-only", worker: "w1" })), "docs failed under w1's write-only confinement. It may need to write outside its worktree.");
  assert.equal(chatNoteText(n({ how: "address-under-on" })), "docs is off while the sandbox is On.");
  assert.equal(chatNoteText(n({ how: "changed" })), "docs changed and is waiting for your approval.");
  assert.equal(chatNoteText(n({ how: "other-computer", host: "desk" })), "docs failed on desk. Check it in Sova on desk.");
});

test("a note in a peer's chat names that computer and links nowhere; a note here is left as it came", () => {
  const n: McpNote = { server: "docs", how: "sandbox", link: { to: "settings", id: "x" } };
  assert.equal(noteOnHost(n, null), n);
  const there = noteOnHost(n, "desk");
  assert.equal(chatNoteText(there), "docs failed on desk. Check it in Sova on desk.");
  assert.equal(there.link, undefined);
});

test("a server's tool row reads its server and its tool", () => {
  assert.equal(mcpToolWords({ server: "docs", tool: "search" }), "docs · search");
});
