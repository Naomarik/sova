// Run: npx tsx --test src/lib/insights.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageClaudeLogin, UsageInsight, UsageProvider } from "../../shared/protocol";
import { stampTime } from "./format";
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
  claudeReading,
  extraUsageMeter,
  meterReset,
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
} from "./insights";

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

test("usageGlance shows DeepSeek's balance last, and every window provider as a percentage", () => {
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
  const parts = usageGlance(usage);
  assert.deepEqual(parts.map((p) => p.id), ["claude", "openai", "ollama", "zai", "deepseek"]);
  assert.deepEqual(
    parts.map((p) => `${p.abbr} ${p.amount ?? `${p.pct}%`}`),
    ["C 47%", "O 95%", "OL 80%", "Z 7%", "DS $4"],
  );
  assert.equal(parts[0]!.full, "Claude 7-day 47%");
  assert.equal(parts[1]!.high, true);
  // The money part carries no percentage, and the window parts carry no amount.
  const ds = parts[4]!;
  assert.equal(ds.pct, undefined);
  // The foot rounds to whole units; the tooltip keeps the cents.
  assert.equal(ds.amount, "$4");
  assert.equal(ds.full, "DeepSeek balance $4.29");
  assert.equal(ds.high, false);
  assert.equal(ds.stale, false);
  assert.equal(parts[0]!.amount, undefined);
  // The foot row's tooltip and accessible name spell the providers out.
  assert.equal(
    `Usage: ${parts.map((p) => p.full).join(", ")}`,
    "Usage: Claude 7-day 47%, OpenAI 7-day 95%, Ollama Cloud Monthly 80%, Z.ai 5-hour 7%, DeepSeek balance $4.29",
  );
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
  const part = usageGlance(usage)[0]!;
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
  assert.equal(usageGlance(usage(deepseek(false)))[0]!.high, true);
  const kept = usageGlance(usage({ ...deepseek(true), error: "deepseek HTTP 500" }))[0]!;
  assert.equal(kept.stale, false);
  assert.equal(kept.full, "DeepSeek balance $4.29");
  assert.equal(kept.amount, "$4");
  assert.equal(usageGlance(usage(deepseek(true), true))[0]!.stale, true);
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
  assert.deepEqual(usageGlance(usage(provider({ id: "deepseek" }))), []);
  assert.deepEqual(usageGlance(usage(provider({ id: "deepseek", state: "nokey" }))), []);
  assert.deepEqual(usageGlance(usage({ ...deepseek(true), state: "error", error: "no data" })), []);
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
const usage = (providers: UsageProvider[]): UsageInsight => ({ available: true, fetchedAt: NOW, nextFetchAt: null, stale: false, providers });

test("resetWhen / meterReset: under 24h a duration, else a date, past a clock time; never estimated", () => {
  assert.deepEqual(resetWhen(inMs(2 * 3_600_000 + 17 * 60_000), NOW), { past: false, when: "in 2h 17m" });
  assert.deepEqual(resetWhen("2026-09-25T10:00:00Z", NOW), { past: false, when: "Sep 25" });
  assert.deepEqual(resetWhen(inMs(-60_000), NOW), { past: true });
  assert.equal(resetWhen(undefined, NOW), null);
  assert.equal(resetWhen("soon", NOW), null);
  assert.deepEqual(meterReset({ label: "5h", pct: 96, resetsAt: inMs(2 * 3_600_000 + 17 * 60_000) }, NOW), { lead: "Resets in 2h 17m" });
  assert.deepEqual(meterReset({ label: "7d", pct: 40, resetsAt: "2026-09-25T10:00:00Z" }, NOW), { lead: "Resets Sep 25" });
  const past = meterReset({ label: "5h", pct: 96, resetsAt: inMs(-60_000) }, NOW);
  assert.equal(past?.lead, "Reset at ");
  assert.match(past?.time ?? "", /^(1[0-2]|[1-9]):[0-5]\d [AP]M$/);
  assert.equal(past?.rest, ". New reading at the next refresh.");
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
    provider({ id: "ollama", state: "na" }),
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

test("usageSummary: a passed reset drops the suffix; limitReached speaks only without a window sentence", () => {
  const passed = usage([provider({ id: "claude", windows: [{ label: "5h", pct: 100, resetsAt: inMs(-60_000) }] })]);
  assert.equal(usageSummary(passed, NOW), "Claude's 5-hour window is rate-limited.");
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
  assert.equal(usageSummary(quiet, NOW), "All providers under limits.");
});

const H = 3_600_000;
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
  assert.equal(accountReading([a, b, c]).usage, newer);
  assert.equal(accountReading([a, b, c]).login, b);
  assert.equal(accountReading([c, a]).usage, older, "a login never read doesn't hide its account's reading");
  const d = login({ id: "l-0000000d", usage: unread });
  assert.equal(accountReading([d, c]).login, c, "nothing read: the login in use speaks, for its note");
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
  assert.equal(claudeReading(u, "default")!.usage, LIMITED, "a chat recorded on the default login");
  assert.equal(claudeReading(u, "l-0000000a")!.usage, SPARE_READING);
  assert.equal(claudeReading(u)!.usage, SPARE_READING, "no chat: the login in use for new chats");
  assert.equal(claudeReading(u, null)!.usage, SPARE_READING);
  assert.equal(claudeReading(u, "l-0000dead")!.usage, SPARE_READING, "a login no longer listed here");
  // No login in use (none ready), or an older server without claudeLogins: Claude Code's own.
  const none: UsageInsight = { ...u, claudeLogins: u.claudeLogins!.map((l) => ({ ...l, inUse: false })) };
  assert.equal(claudeReading(none)!.usage, LIMITED);
  const older: UsageInsight = { ...u, claudeLogins: undefined };
  assert.deepEqual(claudeReading(older, "l-0000000a"), { usage: LIMITED, name: "Claude" });
  assert.equal(claudeReading(usage([provider({ id: "openai" })])), null);
});

test("usageGlance: C reads the chosen login, and only several logins name it in the full text", () => {
  const u = twoLogins();
  const c = usageGlance(u)[0]!;
  assert.deepEqual({ abbr: c.abbr, pct: c.pct, high: c.high, full: c.full }, { abbr: "C", pct: 61, high: false, full: "Claude (spare@example.com) 7-day 61%" });
  const onDefault = usageGlance(u, "default")[0]!;
  assert.deepEqual({ pct: onDefault.pct, high: onDefault.high, full: onDefault.full }, { pct: 40, high: false, full: "Claude (own@example.com) 7-day 40%" });
  // The other providers are untouched.
  assert.equal(usageGlance(u)[1]!.full, "OpenAI 7-day 14%");
  // One login: unchanged, no name.
  const one: UsageInsight = { ...u, claudeLogins: [login({ id: "default", email: "own@example.com", inUse: true, usage: LIMITED })] };
  assert.equal(usageGlance(one)[0]!.full, "Claude 7-day 40%");
});

test("usageGlance: unreadable selected accounts fall back to the own login, including 100%", () => {
  const own = provider({ id: "claude", windows: [{ label: "7d", pct: 100 }] });
  for (const missing of [
    provider({ id: "claude", state: "error", windows: [{ label: "7d", pct: 25 }] }),
    provider({ id: "claude", windows: [] }),
    provider({ id: "claude", windows: [{ label: "7d opus", pct: 25 }] }),
  ]) {
    const u = twoLogins();
    u.providers[0] = own;
    u.claudeLogins![1] = { ...u.claudeLogins![1]!, usage: missing };
    for (const id of [undefined, "l-0000000a"]) {
      const c = usageGlance(u, id)[0]!;
      assert.deepEqual({ id: c.id, pct: c.pct, high: c.high, full: c.full }, {
        id: "claude", pct: 100, high: true, full: "Claude (Claude Code's own login) 7-day 100%",
      });
      assert.equal(usageGlance(u, id)[1]!.full, "OpenAI 7-day 14%");
    }
    assert.equal(claudeReading(u)!.usage, missing, "summary selection is unchanged");
    u.providers[0] = provider({ id: "claude", state: "error", windows: [] });
    assert.equal(usageGlance(u).some((part) => part.id === "claude"), false, "no fabricated reading");
  }
});

test("usageGlance: readable selected accounts take precedence even at 100%", () => {
  const u = twoLogins();
  u.claudeLogins![1]!.usage = provider({ id: "claude", windows: [{ label: "7d", pct: 100 }] });
  const c = usageGlance(u)[0]!;
  assert.equal(c.pct, 100);
  assert.equal(c.high, true);
  assert.equal(c.full, "Claude (spare@example.com) 7-day 100%");
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
  assert.equal(claudeReading(u)!.usage, SPARE_READING);
  assert.equal(usageGlance(u)[0]!.full, "Claude (a@example.com) 7-day 61%");
  assert.equal(claudeReading(u, "default")!.usage, LIMITED);
});
