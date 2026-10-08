// Run: npx tsx --test src/lib/insights.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageClaudeLogin, UsageInsight, UsageProvider } from "../../shared/protocol";
import { shortDate, stampTime } from "./format";
import {
  authCaption,
  balanceBreakdown,
  accountReading,
  claudeAccountLoginsCaption,
  claudeAccounts,
  claudeAccountSubtitle,
  claudeLoginHolder,
  claudeLoginName,
  claudeLoginNote,
  claudeLoginStanding,
  claudeLoginTitle,
  claudePastNote,
  claudeReading,
  extraUsageMeter,
  glanceBars,
  glanceLabel,
  glanceTitle,
  meterReset,
  paceTone,
  paceWords,
  money,
  moneyCompact,
  planLabel,
  PROVIDER_ABBR,
  PROVIDER_NAME,
  providerChip,
  providerProblem,
  resetWhen,
  usageGlance,
  usageSummary,
  usesLine,
  windowLabel,
  windowPace,
  windowSpan,
} from "./insights";
import type { GlancePart } from "./insights";

/** A glance part's figure as text: the money, "pending", or each bar's percentage ("–" for an empty track). */
const fig = (p: GlancePart) => p.amount ?? (p.pending ? "pending" : p.bars!.map((b) => (b.pct === null ? "\u2013" : `${b.pct}`)).join("/"));

/** A clock for tests before NOW below: every window in them has no reset, so any time works. */
const T = Date.parse("2026-09-19T05:33:00Z");

const provider = (p: Partial<UsageProvider> & Pick<UsageProvider, "id">): UsageProvider => ({ state: "ok", windows: [], ...p });

const deepseek = (available: boolean): UsageProvider =>
  provider({ id: "deepseek", balance: { currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29, available } });

test("DeepSeek has a provider name and a foot abbreviation", () => {
  assert.equal(PROVIDER_NAME.deepseek, "DeepSeek");
  assert.equal(PROVIDER_ABBR.deepseek, "DS");
});

test("providerChip: a balance that can't fund calls reads 'Out of credit'", () => {
  assert.deepEqual(providerChip(deepseek(false)), { tone: "error", text: "Out of credit" });
  assert.equal(providerChip(deepseek(true)), null);
});

test("providerChip: a kept balance behind a failed fetch gets no chip, and out of credit still wins", () => {
  assert.equal(providerChip({ ...deepseek(true), error: "deepseek HTTP 500" }), null);
  assert.deepEqual(providerChip({ ...deepseek(false), error: "deepseek HTTP 500" }), { tone: "error", text: "Out of credit" });
});

test("providerProblem: an ok provider with a balance renders the balance, not a note", () => {
  assert.equal(providerProblem(deepseek(true)), null);
  assert.equal(providerProblem(deepseek(false)), null);
  // The generic key branches still read as sentences for DeepSeek.
  assert.deepEqual(providerProblem(provider({ id: "deepseek", state: "nokey" })), {
    lead: "No DeepSeek key in ",
    code: "~/.pi/agent/auth.json",
    rest: ".",
  });
  assert.deepEqual(providerProblem(provider({ id: "deepseek", state: "badkey" })), {
    lead: "DeepSeek refused the key in ",
    code: "~/.pi/agent/auth.json",
    rest: ".",
  });
});

test("usageGlance shows DeepSeek's balance last, and every window provider as a meter", () => {
  const usage: UsageInsight = {
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale: false,
    providers: [
      provider({ id: "claude", windows: [{ label: "7d", pct: 47 }] }),
      provider({ id: "openai", windows: [{ label: "7d", pct: 95 }] }),
      provider({ id: "ollama", windows: [{ label: "month", pct: 80 }] }),
      provider({ id: "zai", windows: [{ label: "5h", pct: 7 }] }),
      deepseek(true),
    ],
  };
  const parts = usageGlance(usage, T);
  assert.deepEqual(parts.map((p) => p.id), ["claude", "openai", "ollama", "zai", "deepseek"]);
  assert.deepEqual(
    parts.map((p) => `${p.abbr} ${fig(p)}`),
    ["C 47", "O 95", "OL 80", "Z 7", "DS $4"],
  );
  assert.equal(parts[0]!.full, "Claude 7-day: 47% used");
  // No reset sent: no tick, so 95% is an error fill on its own, and no balance emphasis.
  assert.deepEqual(parts[1]!.bars, [{ pct: 95, elapsed: null, tone: "error" }]);
  assert.equal(parts[1]!.high, false);
  // The money part carries no meter, and the window parts carry no amount.
  const ds = parts[4]!;
  assert.equal(ds.bars, undefined);
  // The foot rounds to whole units; the tooltip keeps the cents.
  assert.equal(ds.amount, "$4");
  assert.equal(ds.full, "DeepSeek balance $4.29");
  assert.equal(ds.high, false);
  assert.equal(ds.stale, false);
  assert.equal(parts[0]!.amount, undefined);
  // The foot row's tooltip and accessible name spell the providers out.
  assert.equal(
    glanceLabel(parts),
    "Usage: Claude 7-day: 47% used. OpenAI 7-day: 95% used. Ollama Cloud Monthly: 80% used. Z.ai 5-hour: 7% used. DeepSeek balance $4.29",
  );
  assert.equal(
    glanceTitle(parts),
    "Usage\nClaude 7-day: 47% used\nOpenAI 7-day: 95% used\nOllama Cloud Monthly: 80% used\nZ.ai 5-hour: 7% used\nDeepSeek balance $4.29",
  );
  assert.equal(glanceTitle([]), "");
  assert.equal(glanceLabel([]), "");
});

test("money keeps the cents, moneyCompact rounds to whole units", () => {
  assert.equal(money(4.29, "USD"), "$4.29");
  assert.equal(moneyCompact(4.29, "USD"), "$4");
  assert.equal(moneyCompact(4.99, "USD"), "$5");
  assert.equal(moneyCompact(0, "USD"), "$0");
  // An unusable currency code falls back to the code plus the number, at each precision.
  assert.equal(money(4.29, "nope"), "nope 4.29");
  assert.equal(moneyCompact(4.29, "nope"), "nope 4");
});

test("usageGlance: a rounded balance in the row, the exact one in the tooltip", () => {
  const usage: UsageInsight = {
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale: false,
    providers: [provider({ id: "deepseek", balance: { currency: "USD", total: 4.99, granted: 0, toppedUp: 4.99, available: true } })],
  };
  const part = usageGlance(usage, T)[0]!;
  assert.equal(part.amount, "$5");
  assert.equal(part.full, "DeepSeek balance $4.99");
});

test("usageGlance: out of credit is the balance's emphasis, and only an old file is stale", () => {
  const usage = (p: UsageProvider, stale = false): UsageInsight => ({
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale,
    providers: [p],
  });
  assert.equal(usageGlance(usage(deepseek(false)), T)[0]!.high, true);
  const kept = usageGlance(usage({ ...deepseek(true), error: "deepseek HTTP 500" }), T)[0]!;
  assert.equal(kept.stale, false);
  assert.equal(kept.full, "DeepSeek balance $4.29");
  assert.equal(kept.amount, "$4");
  assert.equal(usageGlance(usage(deepseek(true), true), T)[0]!.stale, true);
});

test("usageGlance leaves out a DeepSeek without a balance, or one that isn't ok", () => {
  const usage = (p: UsageProvider): UsageInsight => ({
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale: false,
    providers: [p],
  });
  // No balance to show: nothing in the foot (it never gets a percentage).
  assert.deepEqual(usageGlance(usage(provider({ id: "deepseek" })), T), []);
  assert.deepEqual(usageGlance(usage(provider({ id: "deepseek", state: "nokey" })), T), []);
  assert.deepEqual(usageGlance(usage({ ...deepseek(true), state: "error", error: "no data" }), T), []);
});

test("windowLabel names the known windows", () => {
  assert.equal(windowLabel({ label: "5h", pct: 0 }), "5-hour");
  assert.equal(windowLabel({ label: "month", pct: 0 }), "Monthly");
  assert.equal(windowLabel({ label: "7d scoped", pct: 0, scope: "Fable" }), "7-day Fable");
});

// ---------------------------------------------------------------------------
// Usage cards and the summary lead

const NOW = Date.parse("2026-09-19T05:33:00Z");
const inMs = (ms: number) => new Date(NOW + ms).toISOString();
const H = 3_600_000;
const usage = (providers: UsageProvider[]): UsageInsight => ({ available: true, fetchedAt: NOW, nextFetchAt: null, stale: false, providers });

test("resetWhen / meterReset: under 24h a duration, else a date, past a clock time; never estimated", () => {
  assert.deepEqual(resetWhen(inMs(2 * 3_600_000 + 17 * 60_000), NOW), { past: false, when: "in 2h 17m" });
  assert.deepEqual(resetWhen("2026-09-25T10:00:00Z", NOW), { past: false, when: "Sep 25" });
  assert.deepEqual(resetWhen(inMs(-60_000), NOW), { past: true });
  assert.equal(resetWhen(undefined, NOW), null);
  assert.equal(resetWhen("soon", NOW), null);
  // With a tick, the context adds the window's progress.
  assert.deepEqual(meterReset({ label: "5h", pct: 96, resetsAt: inMs(2 * 3_600_000 + 17 * 60_000) }, NOW), { lead: "Resets in 2h 17m \u00b7 2h 43m of 5h" });
  assert.deepEqual(meterReset({ label: "7d", pct: 40, resetsAt: "2026-09-25T10:00:00Z" }, NOW), { lead: "Resets Sep 25 \u00b7 day 1 of 7" });
  // A window of no stated length keeps the reset alone.
  assert.deepEqual(meterReset({ label: "pri", pct: 40, resetsAt: inMs(3 * H) }, NOW), { lead: "Resets in 3h" });
  const past = meterReset({ label: "5h", pct: 96, resetsAt: inMs(-60_000) }, NOW);
  assert.equal(past?.lead, "Reset at ");
  assert.match(past?.time ?? "", /^(1[0-2]|[1-9]):[0-5]\d [AP]M$/);
  assert.equal(past?.rest, ". New reading at the next refresh.");
  assert.equal(meterReset({ label: "5h", pct: 96, resetsAt: inMs(-60_000) }, NOW, "Not read while it is free.")?.rest, ". Not read while it is free.");
  assert.equal(meterReset({ label: "7d", pct: 40 }, NOW), null);
});

test("usesLine: MCP counts with comma thousands, only for mcp with both counts", () => {
  assert.equal(usesLine({ label: "mcp", pct: 1, used: 12, limit: 1000 }), "12 of 1,000 uses");
  assert.equal(usesLine({ label: "mcp", pct: 1, used: 12 }), null);
  assert.equal(usesLine({ label: "5h", pct: 1, used: 12, limit: 1000 }), null);
});

test("balanceBreakdown: the non-zero parts, joined; nothing when both are 0", () => {
  const b = { currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29, available: true };
  assert.equal(balanceBreakdown(b), "Topped up $4.29");
  assert.equal(balanceBreakdown({ ...b, granted: 1 }), "Granted $1.00 \u00b7 Topped up $4.29");
  assert.equal(balanceBreakdown({ ...b, toppedUp: 0 }), null);
});

test("planLabel: OpenAI plan or Z.ai level, capitalised, 'plan' never doubled; absent is null", () => {
  assert.equal(planLabel(provider({ id: "openai", plan: "plus" })), "Plus plan");
  assert.equal(planLabel(provider({ id: "zai", level: "pro" })), "Pro plan");
  assert.equal(planLabel(provider({ id: "openai", plan: "Team plan" })), "Team plan");
  assert.equal(planLabel(provider({ id: "openai", plan: " " })), null);
  assert.equal(planLabel(provider({ id: "claude" })), null);
});

test("extraUsageMeter: a fill when there's a reading, 'On' when only switched on, nothing when off", () => {
  assert.deepEqual(extraUsageMeter(provider({ id: "claude", extraUsage: { enabled: true, pct: 42 } })), { pct: 42 });
  assert.deepEqual(extraUsageMeter(provider({ id: "claude", extraUsage: { enabled: true } })), { on: true });
  assert.equal(extraUsageMeter(provider({ id: "claude", extraUsage: { enabled: false, pct: 42 } })), null);
  assert.equal(extraUsageMeter(provider({ id: "claude" })), null);
});

test("usageSummary: null without data; all healthy is one sentence", () => {
  assert.equal(usageSummary(undefined, NOW), null);
  assert.equal(usageSummary({ available: false, reason: "missing", fetchedAt: null, nextFetchAt: null, stale: false, providers: [] }, NOW), null);
  const healthy = usage([
    provider({ id: "claude", windows: [{ label: "5h", pct: 79.4 }], extraUsage: { enabled: true, pct: 100 } }),
    provider({ id: "ollama", windows: [{ label: "month", pct: 20 }] }),
    deepseek(true),
  ]);
  assert.equal(usageSummary(healthy, NOW), "All providers under limits.");
});

test("usageSummary: one sentence per problem provider, worst state first, payload order", () => {
  const u = usage([
    provider({ id: "claude", windows: [{ label: "5h", pct: 85 }, { label: "7d", pct: 96.4 }] }),
    provider({ id: "openai", windows: [{ label: "5h", pct: 100, resetsAt: inMs(2 * 3_600_000 + 17 * 60_000) }, { label: "7d", pct: 90 }] }),
    provider({ id: "ollama", windows: [{ label: "month", pct: 100, resetsAt: "2026-09-25T10:00:00Z" }] }),
    provider({ id: "zai", windows: [{ label: "5h", pct: 10 }, { label: "mcp", pct: 100 }] }),
    deepseek(false),
  ]);
  assert.equal(
    usageSummary(u, NOW),
    "Claude's 7-day window is at 96%. " +
      "OpenAI's 5-hour window is rate-limited \u2014 resets in 2h 17m. " +
      "Ollama Cloud's Monthly quota is used up \u2014 resets Sep 25. " +
      "Z.ai's MCP uses quota is used up. " +
      "DeepSeek is out of credit.",
  );
});

test("usageSummary: a window whose reset passed adds no sentence; limitReached speaks only without a window sentence", () => {
  // Like the head chip: the window is gone, so it is neither rate-limited nor used up.
  const passed = usage([provider({ id: "claude", windows: [{ label: "5h", pct: 100, resetsAt: inMs(-60_000) }, { label: "7d", pct: 100, resetsAt: inMs(-H) }] })]);
  assert.equal(providerChip(passed.providers[0]!, NOW), null);
  assert.equal(usageSummary(passed, NOW), "No reported limit needs attention. Some readings are unavailable or stale.");
  const stillAhead = usage([provider({ id: "claude", windows: [{ label: "5h", pct: 100, resetsAt: inMs(-60_000) }, { label: "7d", pct: 100, resetsAt: inMs(H) }] })]);
  assert.equal(usageSummary(stillAhead, NOW), "Claude's 7-day quota is used up \u2014 resets in 1h.");
  const reached = usage([provider({ id: "openai", limitReached: true, windows: [{ label: "7d", pct: 40 }] })]);
  assert.equal(usageSummary(reached, NOW), "OpenAI's usage limit is reached.");
  const both = usage([provider({ id: "openai", limitReached: true, windows: [{ label: "7d", pct: 100 }] })]);
  assert.equal(usageSummary(both, NOW), "OpenAI's 7-day quota is used up.");
});

test("usageSummary: not-ok states each have a sentence; na and kept readings don't", () => {
  const u = usage([
    provider({ id: "claude", state: "nologin" }),
    provider({ id: "openai", state: "expired" }),
    provider({ id: "ollama", state: "nokey" }),
    provider({ id: "zai", state: "badkey" }),
    provider({ id: "deepseek", state: "error", error: "HTTP 500" }),
  ]);
  assert.equal(
    usageSummary(u, NOW),
    "Claude isn't signed in. OpenAI's sign-in expired. Ollama Cloud needs an API key. Z.ai's API key was refused. DeepSeek's usage couldn't be fetched.",
  );
  const quiet = usage([
    provider({ id: "ollama", state: "na" }),
    provider({ id: "zai", state: "error", error: "timeout", windows: [{ label: "5h", pct: 10 }] }),
    provider({ id: "claude", lastKnown: true, error: "older pi", windows: [{ label: "7d", pct: 10 }] }),
  ]);
  assert.equal(usageSummary(quiet, NOW), "No reported limit needs attention. Some readings are unavailable or stale.");
});

const claudeAuth = (a: Partial<NonNullable<UsageProvider["auth"]>>): UsageProvider["auth"] => ({ kind: "oauth", source: "claude-cli", ...a });

test("authCaption: a valid sign-in says when it renews by, and when it last did only when known", () => {
  const p = provider({ id: "claude", windows: [{ label: "5h", pct: 10 }], auth: claudeAuth({ expiresAt: NOW + 5 * H, refreshExpiresAt: NOW + 20 * 24 * H, refreshedAt: NOW - 3 * H }) });
  assert.deepEqual(authCaption(p, NOW), { rest: `Sign-in renews by ${stampTime(NOW + 5 * H, NOW)} · last renewed 3h ago` });
  assert.deepEqual(authCaption({ ...p, auth: claudeAuth({ expiresAt: NOW + 5 * H }) }, NOW), { rest: `Sign-in renews by ${stampTime(NOW + 5 * H, NOW)}` });
  // pi's OpenAI sign-in lasts days: the clock carries the date.
  const openai = provider({ id: "openai", auth: { kind: "oauth", source: "pi", expiresAt: NOW + 7 * 24 * H } });
  assert.match(authCaption(openai, NOW)!.rest, /^Sign-in renews by [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2} [AP]M$/);
  // Codex CLI only: a renewal time and no expiry.
  const codex = provider({ id: "openai", auth: { kind: "oauth", source: "codex-cli", refreshedAt: Date.parse("2026-07-29T10:00:00Z") } });
  assert.deepEqual(authCaption(codex, NOW), { rest: "Sign-in last renewed Jul 29" });
});

test("authCaption: nothing for API keys, no sign-in data, or a card whose expired note says it", () => {
  assert.equal(authCaption(provider({ id: "ollama", auth: { kind: "apiKey" } }), NOW), null);
  assert.equal(authCaption(provider({ id: "claude" }), NOW), null);
  assert.equal(authCaption(provider({ id: "claude", state: "expired", auth: claudeAuth({ expiresAt: NOW - 2 * H }) }), NOW), null);
  assert.equal(authCaption(provider({ id: "openai", auth: { kind: "oauth", source: "codex-cli" } }), NOW), null);
});

test("authCaption: a timed-out token on a card still showing a reading, and a refresh token that can't renew", () => {
  const late = provider({ id: "claude", windows: [{ label: "5h", pct: 10 }], auth: claudeAuth({ expiresAt: NOW - 2 * H, refreshExpiresAt: NOW + 20 * 24 * H }) });
  assert.deepEqual(authCaption(late, NOW), { rest: "Sign-in token expired 2h ago. It renews the next time Claude Code runs; usage updates after that." });
  const dead = { ...late, auth: claudeAuth({ expiresAt: NOW + H, refreshExpiresAt: NOW - H }) };
  assert.deepEqual(authCaption(dead, NOW), { lead: "Sign-in can't renew. Run ", code: "claude /login", rest: " to sign in again." });
});

test("providerProblem expired: soft only when the token timed out and the refresh token may still renew it", () => {
  const expired = (auth?: UsageProvider["auth"], id: UsageProvider["id"] = "claude") => providerProblem(provider({ id, state: "expired", auth }), NOW);
  const hard = { lead: "Sign-in expired. Run ", code: "claude /login", rest: " to renew it." };
  assert.deepEqual(expired(claudeAuth({ expiresAt: NOW - 2 * H, refreshExpiresAt: NOW + 20 * 24 * H })), {
    rest: "Sign-in token expired 2h ago. It renews the next time Claude Code runs; usage updates after that.",
  });
  assert.deepEqual(expired(claudeAuth({ expiresAt: NOW - 2 * H })), expired(claudeAuth({ expiresAt: NOW - 2 * H, refreshExpired: false })), "unknown refresh expiry: soft");
  assert.deepEqual(
    expired({ kind: "oauth", source: "pi", expiresAt: NOW - 2 * H }, "openai"),
    { rest: "Sign-in token expired 2h ago. It renews the next time pi uses OpenAI; usage updates after that." },
  );
  // Every other case keeps the hard copy.
  assert.deepEqual(expired(undefined), hard, "no sign-in data");
  assert.deepEqual(expired(claudeAuth({ expiresAt: NOW - 2 * H, refreshExpiresAt: NOW - H })), hard, "refresh token expired");
  assert.deepEqual(expired(claudeAuth({ expiresAt: NOW - 2 * H, refreshExpired: true })), hard, "refresh flag without a time");
  assert.deepEqual(expired(claudeAuth({ expiresAt: NOW + 2 * H })), hard, "refused before its expiry: revoked");
  assert.deepEqual(expired(claudeAuth({})), hard, "no expiry known");
  assert.deepEqual(expired({ kind: "oauth", source: "pi", expiresAt: NOW + H }, "openai"), { ...hard, code: "pi /login" });
});

const login = (over: Partial<UsageClaudeLogin> & Pick<UsageClaudeLogin, "id">): UsageClaudeLogin => ({
  enabled: true,
  signedIn: true,
  standing: { state: "ready" },
  inUse: false,
  usage: provider({ id: "claude", windows: [{ label: "5h", pct: 10 }] }),
  ...over,
});

test("an account card is titled by its email, its caption says the plan and a lone login's name", () => {
  const own = login({ id: "default", email: "own@example.com", planLabel: "Max 20x" });
  assert.equal(claudeLoginTitle(own), "own@example.com");
  assert.equal(claudeAccountSubtitle([own]), "Claude \u00b7 Max 20x \u00b7 Claude Code's own login");
  const spare = login({ id: "l-0000000a", email: "spare@example.com", label: "Spare" });
  assert.equal(claudeAccountSubtitle([spare]), "Claude \u00b7 Spare");
  const unnamed = login({ id: "l-0000000c", email: "own@example.com", addedAt: 5 });
  assert.equal(claudeAccountSubtitle([unnamed]), "Claude", "alone and unnamed, the email says enough");
  assert.equal(claudeAccountSubtitle([unnamed, login({ id: "l-0000000d", email: "own@example.com", label: "Lab", planLabel: "Max 5x" })]), "Claude \u00b7 Max 5x", "several logins: the list names them");
  assert.equal(claudeLoginTitle(login({ id: "default" })), "Claude Code's own login");
  assert.equal(claudeAccountSubtitle([login({ id: "default" })]), "Claude", "no email: the title already names it");
  assert.equal(claudeLoginTitle(login({ id: "l-0000000b", label: "Lab" })), "Lab");
});

test("a login inside its account is named by its label, else Login N by when it was added", () => {
  const first = login({ id: "l-0000000b", accountUuid: "acct-1", addedAt: 100 });
  const second = login({ id: "l-0000000a", accountUuid: "acct-1", addedAt: 200 });
  const own = login({ id: "default", accountUuid: "acct-1" });
  // Listed second first (a moved order): the numbers still follow when each was added.
  const account = [second, own, first];
  assert.deepEqual(account.map((l) => claudeLoginName(l, account)), ["Login 2", "Claude Code's own login", "Login 1"]);
  const renamed = { ...second, label: "Work laptop" };
  assert.equal(claudeLoginName(renamed, [renamed, first]), "Work laptop");
  assert.equal(claudeLoginName(first, [renamed, first]), "Login 1", "a rename doesn't renumber the others");
});

test("the logins caption counts the pool's logins, never Claude Code's own", () => {
  const pooled = (id: string) => login({ id, holder: { label: "Desk", self: true, free: false, stuck: false } });
  assert.equal(claudeAccountLoginsCaption([pooled("l-0000000a"), pooled("l-000000a2")]), "2 logins in the pool");
  assert.equal(claudeAccountLoginsCaption([pooled("l-0000000a")]), "1 login in the pool");
  assert.equal(claudeAccountLoginsCaption([pooled("l-0000000a"), login({ id: "default" })]), "1 login in the pool", "default is listed, not counted");
  assert.equal(claudeAccountLoginsCaption([login({ id: "default" })]), null, "the pool is on, but default is never in it: no list");
  assert.equal(claudeAccountLoginsCaption([login({ id: "l-0000000a" }), login({ id: "l-000000a2" })]), "2 logins on this device");
  assert.equal(claudeAccountLoginsCaption([login({ id: "l-0000000a" })]), null);
});

test("a pool login's place reads like Settings → Accounts' holder chip", () => {
  const at = (holder: UsageClaudeLogin["holder"]) => claudeLoginHolder(login({ id: "l-0000000a", holder }));
  assert.deepEqual(at({ label: "Desk", self: true, free: false, stuck: false }), { tone: "accent", text: "This device" });
  assert.deepEqual(at({ label: "Laptop", self: false, free: false, stuck: false }), { tone: "info", text: "Laptop" });
  assert.deepEqual(at({ label: "Desk", self: false, free: true, stuck: false }), { tone: "success", text: "Free" });
  assert.deepEqual(at({ label: "Phone", self: false, free: false, stuck: true }), { tone: "warn", text: "Stuck on Phone" });
  assert.equal(at(undefined), null, "mesh off: no place to say");
});

test("an account's one reading is its freshest, whichever login read it", () => {
  const older = provider({ id: "claude", windows: [{ label: "5h", pct: 20 }] });
  const newer = provider({ id: "claude", windows: [{ label: "5h", pct: 30 }] });
  const unread = provider({ id: "claude", state: "error", windows: [], error: "not read yet" });
  const a = login({ id: "l-0000000a", usage: older, fetchedAt: 100 });
  const b = login({ id: "l-0000000b", usage: newer, fetchedAt: 200 });
  const c = login({ id: "l-0000000c", usage: unread, inUse: true });
  assert.equal(accountReading([a, b, c], NOW).usage, newer);
  assert.equal(accountReading([a, b, c], NOW).login, b);
  assert.equal(accountReading([c, a], NOW).usage, older, "a login never read doesn't hide its account's reading");
  const d = login({ id: "l-0000000d", usage: unread });
  assert.equal(accountReading([d, c], NOW).login, c, "nothing read: the login in use speaks, for its note");
});

test("a login's standing reads as Settings → Accounts says it", () => {
  const now = Date.parse("2026-09-29T10:00:00Z");
  assert.deepEqual(claudeLoginStanding(login({ id: "default" }), now), { tone: "success", text: "Ready" });
  assert.equal(claudeLoginStanding(login({ id: "l-0000000a", enabled: false }), now).text, "Off");
  const until = now + 3_600_000;
  assert.deepEqual(claudeLoginStanding(login({ id: "l-0000000a", standing: { state: "limited", until, window: "five_hour" } }), now), { tone: "warn", text: `Limited until ${stampTime(until, now)}`, title: "5h limit" });
  assert.equal(claudeLoginStanding(login({ id: "l-0000000a", standing: { state: "auth" } }), now).text, "Sign in again");
  assert.equal(claudeLoginStanding(login({ id: "l-0000000a", signedIn: false }), now).text, "Not signed in");
  assert.equal(claudeLoginStanding(login({ id: "default", signedIn: false }), now).text, "Ready", "default's sign-in is the provider's own note");
});

test("the standing never says Ready under a head chip that says Rate-limited", () => {
  // The user's case: Claude Code's own login recorded ready, its 5-hour window at 100% for 6 more minutes.
  const now = Date.parse("2026-09-29T10:00:00Z");
  const resets = now + 6 * 60_000;
  const full = provider({ id: "claude", windows: [{ label: "5h", pct: 100, resetsAt: new Date(resets).toISOString() }, { label: "7d", pct: 59 }] });
  const own = login({ id: "default", usage: full });
  assert.deepEqual(providerChip(full, now), { tone: "warn", text: "Rate-limited" });
  assert.deepEqual(claudeLoginStanding(own, now), { tone: "warn", text: `Limited until ${stampTime(resets, now)}`, title: "Its 5-hour window is used up" });
  // Another login of the account, read by the account's reading.
  assert.equal(claudeLoginStanding(login({ id: "l-0000000a" }), now, full).text, `Limited until ${stampTime(resets, now)}`);
  // An Off login of a full account: the quota is the newer fact.
  assert.equal(claudeLoginStanding(login({ id: "l-0000000a", enabled: false }), now, full).text, `Limited until ${stampTime(resets, now)}`);
  // Once the reset has passed, neither says limited: the reading describes a window that's gone.
  const later = resets + 60_000;
  assert.equal(providerChip(full, later), null);
  assert.equal(claudeLoginStanding(own, later).text, "Ready");
  // A recorded limit keeps its own words.
  const until = now + 3_600_000;
  assert.equal(claudeLoginStanding(login({ id: "default", usage: full, standing: { state: "limited", until } }), now).text, `Limited until ${stampTime(until, now)}`);
  // A full window with no reset time never invents one.
  assert.equal(claudeLoginStanding(login({ id: "default", usage: provider({ id: "claude", windows: [{ label: "5h", pct: 100 }] }) }), now).text, "Ready");
  assert.deepEqual(providerChip(provider({ id: "claude", windows: [{ label: "5h", pct: 100 }] }), now), { tone: "warn", text: "Rate-limited" });
});

test("a login card without meters says why when the reason is the login's", () => {
  const empty = provider({ id: "claude", state: "error", windows: [], error: "not read yet" });
  assert.match(claudeLoginNote(login({ id: "l-0000000a", usage: empty }))!, /^Not read yet/);
  assert.match(claudeLoginNote(login({ id: "l-0000000a", usage: empty, standing: { state: "auth" } }))!, /^Not fetched while this login needs signing in again/);
  assert.equal(claudeLoginNote(login({ id: "l-0000000a", usage: empty, fetchedAt: 5 })), null, "read before: the provider's own error note");
  assert.equal(claudeLoginNote(login({ id: "l-0000000a" })), null, "meters: nothing to say");
  assert.match(claudeLoginNote(login({ id: "l-0000000a", usage: empty, holder: { label: "Desk", self: false, free: true, stuck: false } }))!, /^Not read while it is free/);
  assert.match(claudeLoginNote(login({ id: "l-0000000a", usage: empty, holder: { label: "Laptop", self: false, free: false, stuck: false } }))!, /once Laptop publishes a reading/);
});

test("logins of one account share one card, where the first of them falls", () => {
  const ids = (groups: UsageClaudeLogin[][]) => groups.map((g) => g.map((l) => l.id));
  const logins = [
    login({ id: "l-0000000b", accountUuid: "acct-2" }),
    login({ id: "default", accountUuid: "acct-1" }),
    login({ id: "l-0000000c" }),
    login({ id: "l-0000000a", accountUuid: "acct-1" }),
  ];
  assert.deepEqual(ids(claudeAccounts(logins)), [["l-0000000b"], ["default", "l-0000000a"], ["l-0000000c"]]);
});

// §app.insights/sidebar-foot: which Claude login the foot and the summary lead read.
const LIMITED = provider({ id: "claude", windows: [{ label: "5h", pct: 100 }, { label: "7d", pct: 40 }] });
const SPARE_READING = provider({ id: "claude", windows: [{ label: "5h", pct: 30 }, { label: "7d", pct: 61, active: true }] });
const twoLogins = (): UsageInsight => ({
  ...usage([LIMITED, provider({ id: "openai", windows: [{ label: "7d", pct: 14 }] })]),
  claudeLogins: [
    login({ id: "default", email: "own@example.com", usage: LIMITED }),
    login({ id: "l-0000000a", email: "spare@example.com", inUse: true, usage: SPARE_READING }),
  ],
});

test("claudeReading: the chat's recorded login, else the one in use for new chats, else providers' claude", () => {
  const u = twoLogins();
  assert.equal(claudeReading(u, NOW, "default")!.usage, LIMITED, "a chat recorded on the default login");
  assert.equal(claudeReading(u, NOW, "l-0000000a")!.usage, SPARE_READING);
  assert.equal(claudeReading(u, NOW)!.usage, SPARE_READING, "no chat: the login in use for new chats");
  assert.equal(claudeReading(u, NOW, null)!.usage, SPARE_READING);
  assert.equal(claudeReading(u, NOW, "l-0000dead")!.usage, SPARE_READING, "a login no longer listed here");
  // No login in use (none ready), or an older server without claudeLogins: Claude Code's own.
  const none: UsageInsight = { ...u, claudeLogins: u.claudeLogins!.map((l) => ({ ...l, inUse: false })) };
  assert.equal(claudeReading(none, NOW)!.usage, LIMITED);
  const older: UsageInsight = { ...u, claudeLogins: undefined };
  assert.deepEqual(claudeReading(older, NOW, "l-0000000a"), { usage: LIMITED, name: "Claude" });
  assert.equal(claudeReading(usage([provider({ id: "openai" })]), NOW), null);
});

test("usageGlance: C reads the chosen login, and only several logins name it in the full text", () => {
  const u = twoLogins();
  const c = usageGlance(u, NOW)[0]!;
  assert.deepEqual({ abbr: c.abbr, fig: fig(c), full: c.full }, { abbr: "C", fig: "30/61", full: "Claude (spare@example.com) 5-hour: 30% used; 7-day: 61% used" });
  const onDefault = usageGlance(u, NOW, "default")[0]!;
  assert.deepEqual({ fig: fig(onDefault), full: onDefault.full }, { fig: "100/40", full: "Claude (own@example.com) 5-hour: 100% used; 7-day: 40% used" });
  // The other providers are untouched.
  assert.equal(usageGlance(u, NOW)[1]!.full, "OpenAI 7-day: 14% used");
  // One login: unchanged, no name.
  const one: UsageInsight = { ...u, claudeLogins: [login({ id: "default", email: "own@example.com", inUse: true, usage: LIMITED })] };
  assert.equal(usageGlance(one, NOW)[0]!.full, "Claude 5-hour: 100% used; 7-day: 40% used");
});

test("usageGlance: a chosen login with no current reading is a pending C naming it, never another account's number", () => {
  // Claude Code's own login is readable (and at 100%): it must not stand in under the same C.
  const own = provider({ id: "claude", windows: [{ label: "7d", pct: 100 }] });
  for (const [why, missing] of [
    ["never read: a login just taken", provider({ id: "claude", state: "error", windows: [], error: "not read yet" })],
    ["every reset passed", provider({ id: "claude", windows: [{ label: "5h", pct: 19, resetsAt: inMs(-2 * H) }, { label: "7d", pct: 100, resetsAt: inMs(-H) }] })],
    ["no window at all", provider({ id: "claude", windows: [] })],
    ["only the Opus window", provider({ id: "claude", windows: [{ label: "7d opus", pct: 25 }] })],
  ] as const) {
    const u = twoLogins();
    u.providers[0] = own;
    u.claudeLogins![1] = { ...u.claudeLogins![1]!, usage: missing };
    for (const id of [undefined, "l-0000000a"]) {
      const c = usageGlance(u, NOW, id)[0]!;
      assert.deepEqual({ id: c.id, pending: c.pending, bars: c.bars, amount: c.amount, high: c.high, full: c.full }, {
        id: "claude", pending: true, bars: [{ pct: null, elapsed: null, tone: null, thin: true }, { pct: null, elapsed: null, tone: null }], amount: undefined, high: false,
        full: "Claude (spare@example.com) reading pending",
      }, why);
      assert.equal(usageGlance(u, NOW, id)[1]!.full, "OpenAI 7-day: 14% used");
    }
    assert.equal(claudeReading(u, NOW)!.usage, missing, "summary selection is unchanged");
  }
  // Named even when it is the only login.
  const alone: UsageInsight = { ...usage([own]), claudeLogins: [login({ id: "l-0000000a", email: "spare@example.com", inUse: true, usage: provider({ id: "claude", state: "error", windows: [], error: "not read yet" }) })] };
  assert.equal(usageGlance(alone, NOW)[0]!.full, "Claude (spare@example.com) reading pending");
  // A chosen login in another not-ok state is missing data: left out, still no stand-in.
  const u = twoLogins();
  u.providers[0] = own;
  u.claudeLogins![1] = { ...u.claudeLogins![1]!, usage: provider({ id: "claude", state: "expired" }) };
  assert.equal(usageGlance(u, NOW).some((part) => part.id === "claude"), false);
});

test("usageGlance: no login chosen reads Claude Code's own login, pending once every reset passed", () => {
  const older = usage([provider({ id: "claude", windows: [{ label: "7d", pct: 100, resetsAt: inMs(-H) }] })]);
  assert.deepEqual(usageGlance(older, NOW).map((p) => ({ pending: p.pending, full: p.full })), [{ pending: true, full: "Claude (Claude Code's own login) reading pending" }]);
  assert.deepEqual(usageGlance(usage([provider({ id: "claude", state: "error", windows: [], error: "no data" })]), NOW), [], "an own login never read: no data");
  assert.equal(fig(usageGlance(usage([provider({ id: "claude", windows: [{ label: "7d", pct: 40, resetsAt: inMs(H) }] })]), NOW)[0]!), "40");
});

test("usageGlance: a window whose reset passed is never a reading in the foot", () => {
  // The 7-day's reset is gone: its bar is an empty track, and only the 5-hour speaks.
  const u = usage([provider({ id: "claude", windows: [{ label: "5h", pct: 12, resetsAt: inMs(H) }, { label: "7d", pct: 100, resetsAt: inMs(-H) }] })]);
  const c = usageGlance(u, NOW)[0]!;
  assert.deepEqual({ fig: fig(c), pending: c.pending }, { fig: "12/\u2013", pending: undefined });
  assert.deepEqual(c.bars![1], { pct: null, elapsed: null, tone: null });
  assert.equal(c.full, `Claude 5-hour: 12% used \u00b7 4h of 5h \u00b7 resets ${stampTime(NOW + H, NOW)}`);
});

test("an account's reading prefers a login with a current window over a fresher one whose resets passed", () => {
  // The user's case: a free spare login's pool figures (7-day 100%, reset gone) beside the pinned
  // login's own first reading.
  const frozen = provider({ id: "claude", windows: [{ label: "5h", pct: 19, resetsAt: inMs(-3 * H) }, { label: "7d", pct: 100, resetsAt: inMs(-H) }] });
  const live = provider({ id: "claude", windows: [{ label: "5h", pct: 4, resetsAt: inMs(4 * H) }, { label: "7d", pct: 1, resetsAt: inMs(100 * H) }] });
  const free = { label: "Free", self: false, free: true, stuck: false };
  const spare = login({ id: "l-0000000a", accountUuid: "acct", usage: frozen, fetchedAt: NOW - 60_000, holder: free });
  const pinned = login({ id: "l-0000000b", accountUuid: "acct", usage: live, fetchedAt: NOW - 10 * 60_000, inUse: true });
  assert.equal(accountReading([spare, pinned], NOW).login, pinned, "older but current beats fresher but gone");
  // Nothing current: the freshest still speaks (the card ghosts it), and a free login's ghost says why.
  const notYet = { ...pinned, usage: provider({ id: "claude", state: "error", windows: [], error: "not read yet" }), fetchedAt: undefined };
  assert.equal(accountReading([spare, notYet], NOW).login, spare);
  assert.equal(claudePastNote(spare), "Not read while it is free.");
  assert.equal(claudePastNote(pinned), undefined);
  // And the foot never shows that frozen 100% as C: the login in use is pending.
  const u: UsageInsight = { ...usage([provider({ id: "claude", windows: [{ label: "7d", pct: 100, resetsAt: inMs(80 * H) }] })]), claudeLogins: [spare, notYet] };
  const c = usageGlance(u, NOW)[0]!;
  assert.equal(c.pending, true);
  assert.equal(usageSummary(u, NOW), "No reported limit needs attention. Some readings are unavailable or stale.", "a frozen quota is not current, and is not described as used up");
});

test("usageGlance: readable selected accounts take precedence even at 100%", () => {
  const u = twoLogins();
  u.claudeLogins![1]!.usage = provider({ id: "claude", windows: [{ label: "7d", pct: 100 }] });
  const c = usageGlance(u, NOW)[0]!;
  assert.equal(fig(c), "100");
  assert.equal(c.bars![0]!.tone, "error");
  assert.equal(c.full, "Claude (spare@example.com) 7-day: 100% used");
});

test("usageSummary: Claude's sentence speaks for the login in use, not a limited default no chat is on", () => {
  const u = twoLogins();
  assert.equal(usageSummary(u, NOW), "All providers under limits.");
  assert.equal(usageSummary(u, NOW, "default"), "Claude (own@example.com)'s 5-hour window is rate-limited.");
  const nearly: UsageInsight = { ...u, claudeLogins: u.claudeLogins!.map((l) => (l.inUse ? { ...l, usage: provider({ id: "claude", windows: [{ label: "7d", pct: 90 }] }) } : l)) };
  assert.equal(usageSummary(nearly, NOW), "Claude (spare@example.com)'s 7-day window is at 90%.");
  // One login: the sentence keeps its plain name.
  const one: UsageInsight = { ...u, claudeLogins: [login({ id: "default", inUse: true, usage: LIMITED })] };
  assert.equal(usageSummary(one, NOW), "Claude's 5-hour window is rate-limited.");
});

test("claudeReading: a login in use that has no reading of its own reads its account's", () => {
  // Two logins of one account: the second is in use, only the first has been read.
  const u: UsageInsight = {
    ...usage([LIMITED]),
    claudeLogins: [
      login({ id: "l-0000000a", email: "a@example.com", accountUuid: "acct-a", usage: SPARE_READING, fetchedAt: 100 }),
      login({ id: "l-000000a2", email: "a@example.com", accountUuid: "acct-a", inUse: true, usage: provider({ id: "claude", state: "error", windows: [], error: "not read yet" }) }),
      login({ id: "default", email: "b@example.com", accountUuid: "acct-b", usage: LIMITED }),
    ],
  };
  assert.equal(claudeReading(u, NOW)!.usage, SPARE_READING);
  assert.equal(usageGlance(u, NOW)[0]!.full, "Claude (a@example.com) 5-hour: 30% used; 7-day: 61% used");
  assert.equal(claudeReading(u, NOW, "default")!.usage, LIMITED);
});

// §app.insights/pace-tick: the tick, its words and the foot's tone.
const D = 86_400_000;

test("windowSpan: startsAt when sent, else resetsAt minus the label's length; never a guess", () => {
  assert.deepEqual(windowSpan({ label: "5h", pct: 1, resetsAt: inMs(H) }), { start: NOW + H - 5 * H, end: NOW + H });
  assert.deepEqual(windowSpan({ label: "7d scoped", scope: "Fable", pct: 1, resetsAt: inMs(D) }), { start: NOW + D - 7 * D, end: NOW + D });
  assert.deepEqual(windowSpan({ label: "7d", pct: 1, resetsAt: inMs(D), startsAt: inMs(-D) }), { start: NOW - D, end: NOW + D }, "the window's own start wins");
  // Unknown: no reset, a label of no stated length, Ollama's month without its declared start, MCP.
  assert.equal(windowSpan({ label: "5h", pct: 0 }), null);
  assert.equal(windowSpan({ label: "pri", pct: 1, resetsAt: inMs(H) }), null);
  assert.equal(windowSpan({ label: "plan", pct: 1, resetsAt: inMs(H) }), null);
  assert.equal(windowSpan({ label: "month", pct: 1, resetsAt: inMs(H) }), null);
  assert.equal(windowSpan({ label: "mcp", pct: 1 }), null);
});

test("windowPace: the elapsed share and its words; no tick once the reset passed", () => {
  // 7-day ending in 3.5 days: half gone, the fourth day.
  assert.deepEqual(windowPace({ label: "7d", pct: 50, resetsAt: inMs(3.5 * D) }, NOW), { elapsed: 0.5, progress: "day 4 of 7" });
  // Its first instant is day 1; its last, day 7.
  assert.equal(windowPace({ label: "7d", pct: 0, resetsAt: inMs(7 * D) }, NOW)!.progress, "day 1 of 7");
  assert.equal(windowPace({ label: "7d", pct: 0, resetsAt: inMs(60_000) }, NOW)!.progress, "day 7 of 7");
  // A short window counts time: 2h 10m into a 5-hour window.
  assert.deepEqual(windowPace({ label: "5h", pct: 10, resetsAt: inMs(2 * H + 50 * 60_000) }, NOW), { elapsed: 130 / 300, progress: "2h 10m of 5h" });
  assert.equal(windowPace({ label: "7d", pct: 50, resetsAt: inMs(-1) }, NOW), null, "reset passed");
  assert.equal(windowPace({ label: "7d", pct: 50 }, NOW), null, "no reset");
  // A start in the future (clock skew) is the window's first instant, never a negative tick.
  assert.equal(windowPace({ label: "7d", pct: 0, resetsAt: inMs(8 * D), startsAt: inMs(D) }, NOW)!.elapsed, 0);
});

test("windowPace: a declared month counts calendar days, Feb clamped from day 31", () => {
  // The server's window for reset day 31, read on Feb 10 2027 (local): Jan 31 → Feb 28.
  const now = new Date(2027, 1, 10, 15).getTime();
  const w = { label: "month", pct: 40, startsAt: new Date(2027, 0, 31).toISOString(), resetsAt: new Date(2027, 1, 28).toISOString(), declared: true as const };
  assert.equal(windowPace(w, now)!.progress, "day 11 of 28");
  // Reset day 14: Sep 14 → Oct 14 is 30 days, and Oct 1 is its 18th.
  const oct = { label: "month", pct: 97, startsAt: new Date(2026, 8, 14).toISOString(), resetsAt: new Date(2026, 9, 14).toISOString(), declared: true as const };
  assert.equal(windowPace(oct, new Date(2026, 9, 1, 9).getTime())!.progress, "day 18 of 30");
  // Its words: the reset is a date, with no clock time.
  const at = new Date(2026, 9, 1, 9).getTime();
  assert.equal(paceWords(oct, at), `Monthly: 97% used · day 18 of 30 · resets ${shortDate(Date.parse(oct.resetsAt), at)}`);
  assert.equal(shortDate(Date.parse(oct.resetsAt), at), "Oct 14");
  // And the card says the date, never a countdown to that midnight.
  assert.equal(meterReset(oct, at)!.lead, "Resets Oct 14 · day 18 of 30");
});

test("paceTone: error at 90%, warn more than 10 points ahead of the tick, else from 80% without one", () => {
  assert.equal(paceTone(90, 0.95), "error");
  assert.equal(paceTone(61, 0.5), "warn");
  assert.equal(paceTone(60, 0.5), null, "exactly 10 ahead is on pace");
  assert.equal(paceTone(30, 0.9), null, "behind the tick");
  assert.equal(paceTone(85, 0.8), null, "high but on pace");
  assert.equal(paceTone(80, null), "warn");
  assert.equal(paceTone(79, null), null);
});

test("paceWords: progress only with a tick, reset only when one is ahead", () => {
  assert.equal(paceWords({ label: "7d", pct: 50, resetsAt: inMs(3.5 * D) }, NOW), `7-day: 50% used · day 4 of 7 · resets ${stampTime(NOW + 3.5 * D, NOW)}`);
  assert.equal(paceWords({ label: "pri", pct: 5, resetsAt: inMs(3 * H) }, NOW), `Primary: 5% used · resets ${stampTime(NOW + 3 * H, NOW)}`);
  assert.equal(paceWords({ label: "mcp", pct: 0, used: 0, limit: 1000 }, NOW), "MCP uses: 0% used");
  assert.equal(paceWords({ label: "5h", pct: 0 }, NOW), "5-hour: 0% used", "an idle 5-hour window has no reset and no tick");
});

test("glanceBars: two stacked bars for Claude and Z.ai, one for OpenAI and Ollama", () => {
  const claude = provider({ id: "claude", windows: [
    { label: "5h", pct: 10, resetsAt: inMs(2 * H + 50 * 60_000) },
    { label: "7d", pct: 30, resetsAt: inMs(3.5 * D) },
    { label: "7d scoped", scope: "Fable", pct: 70, resetsAt: inMs(3.5 * D), active: true },
    { label: "7d opus", pct: 99 },
  ] });
  const c = glanceBars(claude, NOW)!;
  // The active 7-day window (Fable) is the long bar; Opus never is.
  assert.deepEqual(c.bars, [{ pct: 10, elapsed: 130 / 300, tone: null, thin: true }, { pct: 70, elapsed: 0.5, tone: "warn" }]);
  assert.equal(c.words.length, 2);
  assert.match(c.words[1]!, /^7-day Fable: 70% used · day 4 of 7 · resets /);
  // An active window that isn't a 7-day one leaves the 7-day as the long bar.
  const active5h = glanceBars(provider({ id: "claude", windows: [{ label: "5h", pct: 1, active: true }, { label: "7d", pct: 2 }] }), NOW)!;
  assert.deepEqual(active5h.bars.map((b) => b.pct), [1, 2]);
  const zai = glanceBars(provider({ id: "zai", windows: [{ label: "5h", pct: 5, resetsAt: inMs(4 * H) }, { label: "mcp", pct: 0, used: 0, limit: 1000 }] }), NOW)!;
  assert.deepEqual(zai.bars, [{ pct: 5, elapsed: 0.2, tone: null, thin: true }, { pct: 0, elapsed: null, tone: null }], "MCP uses: no reset read, no tick");
  assert.equal(zai.words[1], "MCP uses: 0% used");
  const openai = glanceBars(provider({ id: "openai", windows: [{ label: "5h", pct: 3, resetsAt: inMs(H) }, { label: "7d", pct: 97, resetsAt: inMs(5 * D), startsAt: inMs(-2 * D) }] }), NOW)!;
  assert.deepEqual(openai.bars, [{ pct: 97, elapsed: 2 / 7, tone: "error" }], "OpenAI: its 7-day only, the tick from its own start");
  assert.deepEqual(glanceBars(provider({ id: "ollama", windows: [{ label: "month", pct: 97 }] }), NOW)!.bars, [{ pct: 97, elapsed: null, tone: "error" }], "no reset day: no tick");
  // A stale file mutes every tone; a provider that isn't ok has no meter.
  assert.deepEqual(glanceBars(claude, NOW, true)!.bars.map((b) => b.tone), [null, null]);
  assert.equal(glanceBars({ ...claude, state: "expired" }, NOW), null);
});

test("usageGlance: C's words add each other account usable here, once per account", () => {
  const read = (pct: number) => provider({ id: "claude", windows: [{ label: "7d", pct }] });
  const u: UsageInsight = {
    ...usage([read(40)]),
    claudeLogins: [
      // The chosen login's account: two logins of one account, never listed.
      login({ id: "l-0000000a", email: "spare@example.com", accountUuid: "acct-spare", inUse: true, usage: read(61) }),
      login({ id: "l-000000a2", email: "spare@example.com", accountUuid: "acct-spare", usage: read(61) }),
      // Claude Code's own login: another account, usable here.
      login({ id: "default", email: "own@example.com", accountUuid: "acct-own", usage: read(40) }),
      // Two logins of a third account: listed once.
      login({ id: "l-0000000b", email: "team@example.com", accountUuid: "acct-team", usage: read(10), fetchedAt: 5 }),
      login({ id: "l-0000000c", email: "team@example.com", accountUuid: "acct-team", usage: provider({ id: "claude", state: "error", windows: [], error: "not read yet" }) }),
      // Held by another device, or kept free in the pool: not usable here.
      login({ id: "l-0000000d", email: "far@example.com", accountUuid: "acct-far", usage: read(5), holder: { label: "Laptop", self: false, free: false, stuck: false } }),
      login({ id: "l-0000000e", email: "free@example.com", accountUuid: "acct-free", usage: read(5), holder: { label: "Free", self: false, free: true, stuck: false } }),
    ],
  };
  const c = usageGlance(u, NOW)[0]!;
  assert.equal(c.full, "Claude (spare@example.com) 7-day: 61% used");
  assert.deepEqual(c.others, ["Claude (own@example.com) 7-day: 40% used", "Claude (team@example.com) 7-day: 10% used"]);
  assert.equal(glanceTitle([c]), "Usage\nClaude (spare@example.com) 7-day: 61% used\nClaude (own@example.com) 7-day: 40% used\nClaude (team@example.com) 7-day: 10% used");
  // On the default login, the spare account is the other one.
  assert.deepEqual(usageGlance(u, NOW, "default")[0]!.others, ["Claude (spare@example.com) 7-day: 61% used", "Claude (team@example.com) 7-day: 10% used"]);
  // A pending C still lists them; an account with no current reading is pending too.
  const pendingU: UsageInsight = { ...u, claudeLogins: u.claudeLogins!.map((l) => (l.id === "l-0000000b" ? { ...l, usage: provider({ id: "claude", windows: [{ label: "7d", pct: 9, resetsAt: inMs(-H) }] }) } : l)) };
  assert.deepEqual(usageGlance(pendingU, NOW)[0]!.others, ["Claude (own@example.com) 7-day: 40% used", "Claude (team@example.com) reading pending"]);
  // One account only: nothing else to say.
  const one: UsageInsight = { ...u, claudeLogins: u.claudeLogins!.slice(0, 2) };
  assert.equal(usageGlance(one, NOW)[0]!.others, undefined);
});
