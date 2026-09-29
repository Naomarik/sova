// Run: npx tsx --test src/lib/insights.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageClaudeLogin, UsageInsight, UsageProvider } from "../../shared/protocol";
import { stampTime } from "./format";
import {
  authCaption,
  balanceBreakdown,
  claudeLoginGroups,
  claudeLoginName,
  claudeLoginNote,
  claudeLoginStanding,
  claudeLoginSubtitle,
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

test("a Claude login's card is titled by its email and says what it is under it", () => {
  const own = login({ id: "default", email: "own@example.com", planLabel: "Max 20x" });
  assert.equal(claudeLoginTitle(own), "own@example.com");
  assert.equal(claudeLoginSubtitle(own), "Claude · Max 20x · Claude Code's own login");
  const spare = login({ id: "l-0000000a", email: "spare@example.com", label: "Spare" });
  assert.equal(claudeLoginSubtitle(spare), "Claude · Spare");
  const now = Date.parse("2026-09-29T10:00:00Z");
  const unnamed = login({ id: "l-0000000c", email: "own@example.com", addedAt: now - 86_400_000 });
  assert.equal(claudeLoginSubtitle(unnamed, now, true), "Claude · Login added Sep 28", "beside another login of its account, when it was added tells them apart");
  assert.equal(claudeLoginSubtitle(unnamed, now), "Claude", "alone in its account, the email says enough");
  assert.equal(claudeLoginName(login({ id: "l-0000000d" })), "Added login");
  assert.equal(claudeLoginTitle(login({ id: "default" })), "Claude Code's own login");
  assert.equal(claudeLoginSubtitle(login({ id: "default" })), "Claude", "no email: the title already names it");
  assert.equal(claudeLoginTitle(login({ id: "l-0000000b", label: "Lab" })), "Lab");
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

test("a login card without meters says why when the reason is the login's", () => {
  const empty = provider({ id: "claude", state: "error", windows: [], error: "not read yet" });
  assert.match(claudeLoginNote(login({ id: "l-0000000a", usage: empty }))!, /^Not read yet/);
  assert.match(claudeLoginNote(login({ id: "l-0000000a", usage: empty, standing: { state: "auth" } }))!, /^Not fetched while this login needs signing in again/);
  assert.equal(claudeLoginNote(login({ id: "l-0000000a", usage: empty, fetchedAt: 5 })), null, "read before: the provider's own error note");
  assert.equal(claudeLoginNote(login({ id: "l-0000000a" })), null, "meters: nothing to say");
});

test("logins of one account sit together, in the order the first of them has", () => {
  const ids = (groups: UsageClaudeLogin[][]) => groups.map((g) => g.map((l) => l.id));
  const logins = [
    login({ id: "l-0000000b", accountUuid: "acct-2" }),
    login({ id: "default", accountUuid: "acct-1" }),
    login({ id: "l-0000000c" }),
    login({ id: "l-0000000a", accountUuid: "acct-1" }),
  ];
  assert.deepEqual(ids(claudeLoginGroups(logins)), [["l-0000000b"], ["default", "l-0000000a"], ["l-0000000c"]]);
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
