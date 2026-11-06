// Run: pnpm test -- src/lib/provider-keys.test.ts. Settings → Accounts' provider tabs and key rows (§app/provider-keys):
// the chip words, the mask, the tab Accounts opens on, each tab's mark, Remove's words, and the reveal's 30-second hide.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderKeyRow, ProviderKeysInfo } from "../../shared/protocol";
import { chipOf, createReveal, initialAccountTab, lastCheckedText, maskKey, removeDetail, removeQuestion, REVEAL_MS, sourceText, tabMark } from "./provider-keys";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const row = (over: Partial<ProviderKeyRow> = {}): ProviderKeyRow => ({
  provider: "deepseek", name: "DeepSeek", tab: "deepseek", saved: true, last4: "a1b2", source: "saved", envName: "DEEPSEEK_API_KEY", envSet: false,
  status: "connected", checkable: true, providerEnabled: true, ...over,
});

test("the chip: Connected, No key, Key refused, Not checked yet, Saved, not checked; a refused paste reads Key refused", () => {
  assert.deepEqual(chipOf(row()), { text: "Connected", tone: "success" });
  assert.deepEqual(chipOf(row({ status: "nokey" })), { text: "No key", tone: undefined });
  assert.deepEqual(chipOf(row({ status: "refused" })), { text: "Key refused", tone: "error" });
  assert.deepEqual(chipOf(row({ status: "unchecked" })), { text: "Not checked yet", tone: "warn" });
  assert.deepEqual(chipOf(row({ status: "saved" })), { text: "Saved, not checked", tone: undefined });
  assert.deepEqual(chipOf(row(), true), { text: "Key refused", tone: "error" }, "the paste's refusal, over the saved key's own standing");
});

test("the field shows only the last 4; the source names the environment's variable", () => {
  assert.equal(maskKey("a1b2"), "••••••••a1b2");
  assert.equal(sourceText(row()), "Saved here");
  assert.equal(sourceText(row({ source: "env" })), "Environment (DEEPSEEK_API_KEY)");
  assert.equal(sourceText(row({ source: "none" })), "None");
});

test("last checked: when, then what came of it", () => {
  assert.equal(lastCheckedText(undefined, NOW), "Not checked yet");
  assert.equal(lastCheckedText({ at: NOW - 2 * 60_000, result: "accepted" }, NOW), "Checked 2 minutes ago: accepted");
  assert.equal(lastCheckedText({ at: NOW - 60_000, result: "unreachable" }, NOW), "Checked 1 minute ago: couldn't reach the provider");
});

test("Remove asks with the mesh named when it reaches it, and says what the model menu loses", () => {
  assert.equal(removeQuestion(row(), true), "Remove the DeepSeek key here and on your mesh computers?");
  assert.equal(removeQuestion(row(), false), "Remove the DeepSeek key from this computer?");
  assert.equal(removeDetail(row()), "DeepSeek's models leave the model menu until a key is saved again.");
  assert.equal(removeDetail(row({ envSet: true })), "DEEPSEEK_API_KEY still serves DeepSeek, so its models stay in the model menu.");
});

test("Accounts opens on the tab a link asked for, else the one last open in this browser, else Claude", () => {
  assert.equal(initialAccountTab("zai", "deepseek"), "zai");
  assert.equal(initialAccountTab(null, "deepseek"), "deepseek");
  assert.equal(initialAccountTab(null, null), "claude");
  assert.equal(initialAccountTab(undefined, "nonsense"), "claude", "a stale stored value is ignored");
});

test("each tab's mark: a key tab's chip, the sign-ins' standing for Claude and OpenAI, the saved count for Other", () => {
  const info: ProviderKeysInfo = {
    rows: [row(), row({ provider: "zai", name: "Z.ai", tab: "zai", status: "refused" }), row({ provider: "anthropic", name: "Anthropic", tab: "claude", status: "unchecked" }), row({ provider: "openai", name: "OpenAI", tab: "openai", status: "nokey", saved: false, source: "none" }), row({ provider: "openrouter", name: "OpenRouter", tab: "other", status: "saved" })],
    others: [{ id: "openrouter", name: "OpenRouter" }],
    revealAllowed: true,
    meshSharesLogins: false,
    signIns: { claude: false, openai: true },
  };
  assert.deepEqual(tabMark("deepseek", info), { tone: "success", words: "Connected" });
  assert.deepEqual(tabMark("zai", info), { tone: "error", words: "Key refused" });
  assert.deepEqual(tabMark("ollama-cloud", info), { tone: undefined, words: "" }, "no row yet");
  assert.deepEqual(tabMark("openai", info), { tone: "success", words: "Signed in" });
  assert.deepEqual(tabMark("claude", info), { tone: "warn", words: "API key: Not checked yet" }, "no sign-in: the API key's standing");
  assert.deepEqual(tabMark("claude", { ...info, rows: info.rows.filter((r) => r.provider !== "anthropic") }), { tone: undefined, words: "Not signed in" });
  assert.deepEqual(tabMark("other", info), { tone: undefined, words: "1 key saved" });
});

/** A clock a test moves by hand. */
function fakeClock() {
  let at = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  let id = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => (timers.set(++id, { due: at + ms, fn }), id),
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      at += ms;
      for (const [k, t] of [...timers]) if (t.due <= at) (timers.delete(k), t.fn());
    },
    pending: () => timers.size,
  };
}

test("a shown key hides itself after 30 s, at once on Hide, and a second Show restarts the 30 s", () => {
  const clock = fakeClock();
  const heard: (string | null)[] = [];
  const reveal = createReveal((k) => heard.push(k), clock);
  reveal.show("fake-key-1");
  clock.advance(REVEAL_MS - 1);
  assert.equal(reveal.shown(), "fake-key-1", "still shown just before 30 s");
  clock.advance(1);
  assert.equal(reveal.shown(), null, "hidden at 30 s");
  assert.deepEqual(heard, ["fake-key-1", null]);

  reveal.show("fake-key-2");
  clock.advance(20_000);
  reveal.show("fake-key-2");
  clock.advance(20_000);
  assert.equal(reveal.shown(), "fake-key-2", "the second Show counts from itself");
  reveal.hide(); // Hide, a tab switch or closing Settings
  assert.equal(reveal.shown(), null);
  assert.equal(clock.pending(), 0, "no timer left behind");
  reveal.hide();
  assert.deepEqual(heard, ["fake-key-1", null, "fake-key-2", "fake-key-2", null], "a second hide says nothing");
});
