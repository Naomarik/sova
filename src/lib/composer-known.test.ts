import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ChatClaudeLogin, HeldChatState, SandboxInfo, SessionSummary } from "../../shared/protocol";
import { composerSeen, forgetComposers, knownComposer, listFetchedAt, rememberComposer, sameKnown, stampListRows } from "./composer-known";

type Row = Pick<SessionSummary, "model" | "busy" | "activity" | "chat">;
const row = (over: Partial<Row> = {}): Row => ({ model: "zai/glm-5.3", busy: false, ...over });
const held = (over: Partial<HeldChatState> = {}): HeldChatState => ({
  model: "claude-code-cli/opus",
  thinking: "high",
  mode: "delegate",
  minorModes: ["align"],
  strict: false,
  applies: "now",
  ...over,
});

beforeEach(forgetComposers);

test("a model changed in the chat after the list was fetched wins over the list's (the switch-away-and-back case)", () => {
  const t1 = 1_000;
  const t2 = 2_000;
  rememberComposer("k", { model: "Y" }, t2);
  assert.equal(knownComposer(composerSeen("k"), row({ model: "X" }), t1).model, "Y");
});

test("a list fetched after the tab last saw the chat wins over what it saw", () => {
  rememberComposer("k", { model: "Y", thinking: "low", running: true, mode: { mode: "normal", minorModes: [], strict: false } }, 1_000);
  const k = knownComposer(composerSeen("k"), row({ model: "X", busy: false, chat: held({ model: "X" }) }), 2_000);
  assert.equal(k.model, "X");
  assert.equal(k.thinking, "high");
  assert.equal(k.running, false);
  assert.deepEqual(k.mode, { mode: "delegate", minorModes: ["align"], strict: false, applies: "now" });
});

test("recency is per field: an older remembered field gives way while a newer one wins", () => {
  rememberComposer("k", { running: true }, 500);
  rememberComposer("k", { model: "Y" }, 3_000);
  const k = knownComposer(composerSeen("k"), row({ model: "X", busy: false }), 2_000);
  assert.equal(k.model, "Y");
  assert.equal(k.running, false);
});

test("a held chat's model supersedes the file tail's", () => {
  assert.equal(knownComposer(undefined, row({ model: "tail/old", chat: held({ model: "claude-code-cli/opus" }) }), 1).model, "claude-code-cli/opus");
});

test("a list row's mode says how a switch applies; a remembered one doesn't", () => {
  assert.equal(knownComposer(undefined, row({ busy: true, chat: held({ applies: "after-turn" }) }), 1).mode?.applies, "after-turn");
  rememberComposer("k", { mode: { mode: "delegate", minorModes: [], strict: false, applies: "after-turn" } }, 5);
  assert.equal(knownComposer(composerSeen("k"), undefined, undefined).mode?.applies, undefined);
});

test("an older server's row (no `chat`): model and running from the row, mode and thinking only from what the tab saw", () => {
  const bare = knownComposer(undefined, row({ model: "X", busy: true }), 1_000);
  assert.deepEqual(bare, { model: "X", thinking: null, mode: null, running: true, sandbox: null, login: null });
  rememberComposer("k", { thinking: "medium", mode: { mode: "delegate", minorModes: ["spec"], strict: true, applies: "after-turn" } }, 500);
  const k = knownComposer(composerSeen("k"), row({ model: "X" }), 1_000);
  assert.equal(k.thinking, "medium", "the row says nothing about it, so even an older memory stands");
  assert.deepEqual(k.mode, { mode: "delegate", minorModes: ["spec"], strict: true }, "a remembered mode carries no `applies`");
});

test("nothing known: the placeholders' nulls, and no turn", () => {
  assert.deepEqual(knownComposer(undefined, undefined, undefined), { model: null, thinking: null, mode: null, running: false, sandbox: null, login: null });
  assert.equal(knownComposer(undefined, row({ model: null }), 1).model, null);
});

test("a row nobody stamped (a link's summary, a just-created session) loses to anything remembered", () => {
  rememberComposer("k", { model: "Y" }, 1);
  assert.equal(knownComposer(composerSeen("k"), row({ model: "X" }), undefined).model, "Y");
});

test("running: a held chat's `busy` alone; otherwise a live record's working activity counts too", () => {
  assert.equal(knownComposer(undefined, row({ busy: false, activity: { state: "working" }, chat: held() }), 1).running, false);
  assert.equal(knownComposer(undefined, row({ busy: false, activity: { state: "working" } }), 1).running, true);
  assert.equal(knownComposer(undefined, row({ busy: true, chat: held() }), 1).running, true);
});

test("a null model or thinking level from the socket remembers nothing; a later value overwrites", () => {
  rememberComposer("k", { model: "A" }, 1);
  rememberComposer("k", { model: null, thinking: null }, 2);
  assert.equal(composerSeen("k")?.model?.value, "A");
  assert.equal(composerSeen("k")?.thinking, undefined);
  rememberComposer("k", { model: "B" }, 3);
  assert.deepEqual(composerSeen("k")?.model, { value: "B", at: 3 });
});

test("the socket's word beats both (the caller's rule): knownComposer is only consulted while unsaid", () => {
  // The view reads `said ?? known`; this pins that known never invents a value the socket refuted
  // once it has been remembered as said.
  rememberComposer("k", { model: "said-now" }, 10);
  assert.equal(knownComposer(composerSeen("k"), row({ model: "listed" }), 5).model, "said-now");
});

test("rows are stamped with their list's fetch time, a reused row restamped by the next list", () => {
  const a = { path: "/a" } as SessionSummary;
  stampListRows([a], 100);
  assert.equal(listFetchedAt(a), 100);
  stampListRows([a], 200);
  assert.equal(listFetchedAt(a), 200);
  assert.equal(listFetchedAt({ path: "/b" } as SessionSummary), undefined);
  assert.equal(listFetchedAt(undefined), undefined);
});

test("sameKnown compares the mode, the sandbox and the login deeply", () => {
  const m = () => ({ mode: "delegate", minorModes: ["align"], strict: false });
  const k = (over = {}) => ({ model: "a", thinking: null, mode: m(), running: false, sandbox: sandbox(), login: login(), ...over });
  assert.ok(sameKnown(k(), k()));
  assert.ok(!sameKnown(k(), k({ mode: { ...m(), minorModes: [] } })));
  assert.ok(!sameKnown(k(), k({ sandbox: sandbox("off") })));
  assert.ok(!sameKnown(k(), k({ sandbox: null })));
  assert.ok(!sameKnown(k(), k({ login: login({ id: "default" }) })));
  assert.ok(!sameKnown(k(), k({ login: null })));
});

// ---- The sandbox shield and the Claude login ---------------------------------------------------

function sandbox(state: "off" | "subagents" | "on" = "on"): SandboxInfo {
  return { on: state === "on", state, enforcement: state === "on" ? "full" : "none", status: `Sandbox ${state}` };
}
function login(over: Partial<ChatClaudeLogin> = {}): ChatClaudeLogin {
  return { id: "l-0000000a", name: "Work", email: "work@example.com", recorded: true, several: true, ...over };
}

test("sandbox and login: the newer of the row and what the tab saw, as every field", () => {
  rememberComposer("k", { sandbox: sandbox("off"), login: login({ id: "default" }) }, 3_000);
  const newer = knownComposer(composerSeen("k"), row({ chat: held({ sandbox: sandbox("on"), login: login() }) }), 2_000);
  assert.deepEqual(newer.sandbox, sandbox("off"), "remembered after the list was fetched: the tab's wins");
  assert.equal(newer.login?.id, "default");
  const older = knownComposer(composerSeen("k"), row({ chat: held({ sandbox: sandbox("on"), login: login() }) }), 4_000);
  assert.deepEqual(older.sandbox, sandbox("on"), "a list fetched later: the row's wins");
  assert.equal(older.login?.id, "l-0000000a");
});

test("known none (null) is a value: it beats an older value, and a newer one beats it", () => {
  rememberComposer("k", { sandbox: null, login: null }, 3_000);
  assert.deepEqual(composerSeen("k")?.sandbox, { value: null, at: 3_000 }, "null is remembered");
  assert.deepEqual(composerSeen("k")?.login, { value: null, at: 3_000 });
  const k = knownComposer(composerSeen("k"), row({ chat: held({ sandbox: sandbox(), login: login() }) }), 2_000);
  assert.equal(k.sandbox, null);
  assert.equal(k.login, null);
  // The row's null, newer than what the tab saw, likewise hides a remembered shield and login.
  rememberComposer("j", { sandbox: sandbox(), login: login() }, 1_000);
  const j = knownComposer(composerSeen("j"), row({ chat: held({ sandbox: null, login: null }) }), 2_000);
  assert.equal(j.sandbox, null);
  assert.equal(j.login, null);
});

test("undefined says nothing: neither remembered nor taken from a row without the key", () => {
  rememberComposer("k", { sandbox: sandbox("subagents"), login: login() }, 1_000);
  rememberComposer("k", { sandbox: undefined, login: undefined }, 5_000);
  assert.deepEqual(composerSeen("k")?.sandbox, { value: sandbox("subagents"), at: 1_000 }, "an unsaid value overwrites nothing");
  // A held chat whose messages weren't built yet, and an older server's row: no keys, so even an
  // older memory stands, however new the list.
  const k = knownComposer(composerSeen("k"), row({ chat: held() }), 9_000);
  assert.deepEqual(k.sandbox, sandbox("subagents"));
  assert.equal(k.login?.id, "l-0000000a");
  const bare = knownComposer(composerSeen("k"), row(), 9_000);
  assert.deepEqual(bare.sandbox, sandbox("subagents"));
  assert.equal(knownComposer(undefined, row({ chat: held() }), 1).sandbox, null);
});

test("a remembered login carries no waiting pick; the row's keeps it", () => {
  const pick = { id: "default", name: "Claude Code's own login" };
  rememberComposer("k", { login: login({ pending: pick }) }, 3_000);
  assert.equal(composerSeen("k")?.login?.value?.pending, undefined);
  assert.equal("pending" in (composerSeen("k")?.login?.value ?? {}), false);
  assert.equal(knownComposer(composerSeen("k"), undefined, undefined).login?.id, "l-0000000a");
  assert.deepEqual(knownComposer(undefined, row({ chat: held({ login: login({ pending: pick }) }) }), 1).login?.pending, pick);
});
