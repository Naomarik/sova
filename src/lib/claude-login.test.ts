import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatClaudeLogin, ClaudeAccountsInfo, ClaudeLoginRow, ClaudePoolInfo, ClaudePoolLogin } from "../../shared/protocol";
import { composerLogin, loginMenu, resendNote } from "./claude-login";
import { stampTime } from "./format";

const login = (over: Partial<ChatClaudeLogin> = {}): ChatClaudeLogin => ({ id: "l-0000000a", name: "a@example.com", email: "a@example.com", planLabel: "Max 20x", recorded: true, several: true, ...over });

test("the indicator shows the chat's login on a Claude Code model when the host has several", () => {
  const shown = composerLogin(login(), "claude-code-cli/opus");
  assert.equal(shown?.text, "a@example.com");
  assert.equal(shown?.short, "a");
  assert.match(shown!.title, /^This chat runs on this Claude login: a@example.com · Max 20x\./);
  assert.equal(shown?.label, "Claude login: a@example.com");
  assert.match(composerLogin(login({ recorded: false }), "claude-code-cli/opus")!.title, /^This chat starts on this Claude login/);
  assert.match(composerLogin(login({ name: "Work" }), "claude-code-cli/opus")!.title, /: Work · a@example.com · Max 20x\./, "a label names it besides the email");
  assert.equal(composerLogin(login({ email: undefined, name: "default" }), "claude-code-cli/opus")?.text, "default");
});

test("no indicator off Claude Code, with a single login, or without a login", () => {
  assert.equal(composerLogin(login(), "zai/glm-5.3"), null);
  assert.equal(composerLogin(login(), null), null);
  assert.equal(composerLogin(login({ several: false }), "claude-code-cli/opus"), null);
  assert.equal(composerLogin(null, "claude-code-cli/opus"), null);
});

// ---- The login panel (§app.claude-logins/switch-login, /switch-queue, /switch-cost) --------------

const NOW = 1_800_000_000_000;
const id = (who: string, account: string) => ({ accountUuid: account, email: `${who}@example.com` });
const here = (loginId: string, identity: ReturnType<typeof id> | null, over: Partial<ClaudeLoginRow> = {}): ClaudeLoginRow => ({
  id: loginId, identity, enabled: true, standing: { state: "ready" }, signedIn: true, addedAt: Number.parseInt(loginId.slice(2), 16) || 0, ...over,
});
const OWN = here("default", { accountUuid: "acct-own", email: "own@example.com" });
const L = (n: number) => `l-0000000${n}`;
const flat = (groups: ReturnType<typeof loginMenu>) => groups.map((g) => [g.label, g.rows.map((r) => [r.name, r.meta, r.reason === null ? "pick" : "no", r.checked ? "checked" : ""].join("|"))]);

test("mesh off: every login here by account, the own login last; each unusable one says why; another device's is listed there", () => {
  const info: ClaudeAccountsInfo = {
    device: { id: "local", label: "This device" },
    logins: [
      here(L(1), id("a", "acct-1")),
      here(L(3), id("a", "acct-1"), { enabled: false }),
      here(L(5), id("a", "acct-1"), { signedIn: false }),
      here(L(2), id("b", "acct-2"), { standing: { state: "limited", until: NOW + 3_600_000 } }),
      here(L(4), id("b", "acct-2"), { standing: { state: "auth" } }),
      OWN,
    ],
    // With the mesh off a login kept here (`device: null`) is listed in both: once is enough.
    elsewhere: [{ id: L(6), device: "vps", identity: id("c", "acct-3") }, { id: L(1), device: null, identity: id("a", "acct-1") }],
    flow: null,
  };
  const groups = loginMenu(info, login({ id: L(1) }), false, NOW);
  assert.deepEqual(flat(groups), [
    ["a@example.com", ["Login 1||pick|checked", "Login 2|Off|no|", "Login 3|Not signed in|no|"]],
    ["b@example.com", [`Login 1|Limited until ${stampTime(NOW + 3_600_000, NOW)}|no|`, "Login 2|Sign in again|no|"]],
    ["c@example.com", ["Login 1|On vps|no|"]],
    ["This device", ["Claude Code's own login|own@example.com|pick|"]],
  ]);
  const unknown = loginMenu({ ...info, logins: [here(L(7), null), OWN], elsewhere: [] }, null, false, NOW);
  assert.equal(unknown[0]!.label, "Unknown account");
});

test("mesh on: held logins, free ones at the keeper to borrow, and where every other one is", () => {
  const pooled = (loginId: string, identity: ReturnType<typeof id>, holder: Partial<ClaudePoolLogin["holder"]>, over: Partial<ClaudePoolLogin> = {}): ClaudePoolLogin => ({
    id: loginId, identity, addedAt: Number.parseInt(loginId.slice(2), 16), enabled: true, pin: null, standing: { state: "ready" },
    holder: { device: "keeper", label: "Keeper", free: true, stuck: false, since: 1, ...holder }, ...over,
  });
  const pool: ClaudePoolInfo = {
    self: "desk",
    keeper: { id: "keeper", label: "Keeper", up: true },
    devices: [
      { id: "desk", label: "Desk", self: true, up: true, logins: [L(1)] },
      { id: "vps", label: "VPS", self: false, up: true, logins: [L(3)] },
      { id: "keeper", label: "Keeper", self: false, up: true, logins: [] },
    ],
    logins: [
      pooled(L(1), id("a", "acct-1"), { device: "desk", label: "Desk", free: false }, { moving: { op: "leave", state: "draining" } }),
      pooled(L(2), id("b", "acct-2"), {}),
      pooled(L(3), id("a", "acct-1"), { device: "vps", label: "VPS", free: false }),
      pooled(L(4), id("b", "acct-2"), { device: "vps", label: "VPS", free: false, stuck: true }),
      pooled(L(5), id("c", "acct-3"), {}, { pin: "vps" }),
      pooled(L(6), id("c", "acct-3"), {}, { standing: { state: "limited", until: NOW + 60_000 } }),
      pooled(L(7), id("c", "acct-3"), {}, { enabled: false }),
    ],
  };
  const info: ClaudeAccountsInfo = { device: { id: "desk", label: "Desk" }, logins: [here(L(1), id("a", "acct-1")), OWN], elsewhere: [], flow: null, pool };
  const groups = loginMenu(info, login({ id: "default" }), false, NOW);
  assert.deepEqual(flat(groups), [
    ["a@example.com", ["Login 1|Leaving this device|no|", "Login 2|On VPS|no|"]],
    ["b@example.com", ["Login 1|Borrow|pick|", "Login 2|Stuck on VPS|no|"]],
    ["c@example.com", ["Login 1|Pinned to VPS|no|", `Login 2|Limited until ${stampTime(NOW + 60_000, NOW)}|no|`, "Login 3|Off|no|"]],
    ["This device", ["Claude Code's own login|own@example.com|pick|checked"]],
  ]);
  assert.equal(groups[1]!.rows[0]!.borrow, true);
  const down = loginMenu({ ...info, pool: { ...pool, keeper: { ...pool.keeper, up: false } } }, null, false, NOW);
  assert.equal(down[1]!.rows[0]!.meta, "Keeper offline", "nothing can be borrowed while the keeper is offline");
  // A pick of the free one: borrowing while idle, after the reply while one runs.
  const waiting = login({ id: "default", pending: { id: L(2), name: "b@example.com" } });
  assert.equal(loginMenu(info, waiting, false, NOW)[1]!.rows[0]!.meta, "Borrowing…");
  assert.equal(loginMenu(info, waiting, true, NOW)[1]!.rows[0]!.meta, "After this reply");
  assert.equal(loginMenu(info, waiting, true, NOW)[1]!.rows[0]!.pending, true);
});

test("the label shows a waiting pick after a live dot, and says it goes after the reply", () => {
  const waiting = login({ pending: { id: "l-0000000b", name: "b@example.com" } });
  const shown = composerLogin(waiting, "claude-code-cli/opus", true)!;
  assert.deepEqual([shown.text, shown.short, shown.pending], ["b@example.com", "b", true]);
  assert.equal(shown.title, "Switching to b@example.com after this reply. Open to cancel.");
  assert.equal(composerLogin(waiting, "claude-code-cli/opus", false)!.title, "Switching to b@example.com.", "idle: it is landing now");
  assert.equal(composerLogin(login(), "claude-code-cli/opus", true)!.pending, false);
});

test("the resend note: the last context fill as ~n tokens, no number after a compaction, nothing before a reply", () => {
  assert.equal(resendNote({ tokens: 84_213, window: 200_000 })?.text, "Switching resends ~84k tokens without cache");
  assert.equal(resendNote({ tokens: 1_200_000, window: null })?.text, "Switching resends ~1.2M tokens without cache");
  assert.match(resendNote({ tokens: 8_400, window: 200_000 })!.title, /^An estimate from the last reply's context/);
  assert.equal(resendNote("compacted")?.text, "Switching resends this chat without cache");
  assert.equal(resendNote(null), null, "no reply yet");
  assert.equal(resendNote(undefined), null, "not known yet");
  assert.equal(resendNote({ tokens: 0, window: 200_000 }), null);
});
