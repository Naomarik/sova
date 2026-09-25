import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
	NUDGE_MAX_DELAY_MS,
	NUDGE_MIN_DELAY_MS,
	contextPct,
	contextShare,
	contextText,
	handoffPath,
	sessionDirKey,
	nudgeFireAt,
	parseDelay,
	roleSlug,
	successorRole,
	usageLines,
	usageProviderOf,
	usageWindows,
} from "./coordination.ts";

test("successor names strip an existing -N suffix and take the first free number", () => {
	assert.equal(successorRole("builder", []), "builder-2");
	assert.equal(successorRole("builder-2", ["builder", "builder-2"]), "builder-3");
	assert.equal(successorRole("builder", ["builder", "Builder-2"]), "builder-3", "taken roles collide case-insensitively");
	assert.equal(successorRole("builder-3", ["builder-4"]), "builder-5");
	assert.equal(successorRole("qa lead", []), "qa lead-2");
	const long = "x".repeat(64);
	assert.equal(successorRole(long, [], 64).length, 64, "the role limit holds");
	assert.match(successorRole(long, [], 64), /-2$/);
});

test("handover notes live under the team's handoffs directory with a safe file name", () => {
	assert.equal(roleSlug("qa lead/../x"), "qa-lead-..-x");
	assert.equal(roleSlug("../etc"), "etc");
	assert.equal(roleSlug("   "), "member");
	assert.equal(handoffPath("/agent", "s1", "team_03", "Lead Dev"), path.join("/agent", "sova", "teams", "s1", "team_03", "handoffs", "Lead-Dev.md"));
	assert.ok(!handoffPath("/agent", "s1", "team_03", "../../outside").includes(".."), "a role can never climb out of the directory");
});

test("N1: handover notes are keyed by the parent session, so two sessions' team_01 never share a note", () => {
	const a = handoffPath("/agent", sessionDirKey("0199aaaa-1111-7000-8000-000000000001", "x"), "team_01", "writer");
	const b = handoffPath("/agent", sessionDirKey("0199aaaa-1111-7000-8000-000000000002", "x"), "team_01", "writer");
	assert.notEqual(a, b);
	assert.equal(a, path.join("/agent", "sova", "teams", "0199aaaa-1111-7000-8000-000000000001", "team_01", "handoffs", "writer.md"));
	assert.equal(sessionDirKey(undefined, "unsaved-1"), "unsaved-1", "no session id: the process-unique fallback");
	assert.equal(sessionDirKey("../..", "unsaved-1"), "unsaved-1", "an id that is only dots never names a parent directory");
	assert.equal(sessionDirKey("a/b c", "f"), "a_b_c");
});

test("a wrap-up event's detail: percent of the window, else the tokens, else unknown", () => {
	assert.equal(contextShare(156_000, 200_000), "context 78% of 200k");
	assert.equal(contextShare(26_000, 1_000_000), "context 2% of 1M");
	assert.equal(contextShare(64_000, undefined), "context 64k tokens (window unknown)");
	assert.equal(contextShare(undefined, 200_000), "context unknown");
});

test("the context column: tokens over the window, whole percent rounded down; unknowns say so", () => {
	assert.equal(contextText(122_900, 200_000), "context 123k/200k (61%)");
	assert.equal(contextText(640_000, 1_000_000), "context 640k/1M (64%)");
	assert.equal(contextText(119_999, 200_000), "context 120k/200k (59%)", "59.9995% is 59, never rounded up across a threshold");
	assert.equal(contextText(0, 200_000), "context —");
	assert.equal(contextText(undefined, undefined), "context —");
	assert.equal(contextText(64_000, undefined), "context 64k/?");
	assert.equal(contextPct(120_000, 200_000), 60);
	assert.equal(contextPct(1, 0), undefined);
});

test("usage providers: claude-code and anthropic-ish pi refs are claude; others map by prefix or not at all", () => {
	assert.equal(usageProviderOf("claude-code", "opus[1m]"), "claude");
	assert.equal(usageProviderOf("pi", "claude-code-cli/opus"), "claude");
	assert.equal(usageProviderOf("pi", "anthropic/claude-x"), "claude");
	assert.equal(usageProviderOf("pi", "openai-codex/gpt-6"), "openai");
	assert.equal(usageProviderOf("pi", "zai/glm-5.3"), "zai");
	assert.equal(usageProviderOf("pi", "ollama-cloud/qwen"), "ollama");
	assert.equal(usageProviderOf("pi", "test/model"), undefined);
	assert.equal(usageProviderOf("pi", undefined), undefined);
	assert.equal(usageProviderOf("other", "x"), undefined);
});

test("usage lines read the cache's windows for the team's providers and mark those at or over the pause threshold", () => {
	const cache = {
		fetchedAt: Date.parse("2026-09-25T12:00:00Z"),
		claude: { state: "ok", limits: [{ label: "5h", pct: 92, resetsAt: "2026-09-25T18:19:59Z" }, { label: "7d", pct: 40, resetsAt: "2026-09-30T00:00:00Z" }] },
		openai: { state: "ok", windows: [{ label: "7d", pct: 100, resetsAt: "2026-09-29T00:11:40Z" }] },
		zai: { state: "nokey" },
	};
	assert.deepEqual(usageWindows(cache, "claude").map((w) => [w.label, w.pct]), [["5h", 92], ["7d", 40]]);
	assert.deepEqual(usageWindows({ claude: { state: "ok", fiveHour: { pct: 10 }, sevenDay: { pct: 20, resetsAt: "bogus" } } }, "claude"), [
		{ provider: "claude", label: "5h", pct: 10 }, { provider: "claude", label: "7d", pct: 20 },
	], "the older fiveHour/sevenDay shape; an unparseable reset is dropped");
	const lines = usageLines(cache, ["claude", "claude", "zai"], 90, Date.parse("2026-09-25T12:03:00Z"));
	assert.equal(lines[0], "  Provider usage (cache fetched 3 min ago):");
	assert.match(lines[1], /claude 5h: 92%, resets 2026-09-25T18:19:59Z — AT\/OVER the 90% pause threshold$/);
	assert.doesNotMatch(lines[2], /AT\/OVER/);
	assert.equal(lines[3], "    zai: no window data");
	assert.equal(lines.length, 4, "each provider once; openai is not this team's");
	assert.match(usageLines(undefined, ["claude"], 90)[0], /unavailable/);
	assert.match(usageLines(cache, [], 90)[0], /no tracked provider/);
	assert.ok(usageLines(cache, ["openai"], undefined).every((l) => !l.includes("AT/OVER")), "no threshold, no marks");
});

test("a window whose reset time has passed counts as reset (usage unknown), never AT/OVER", () => {
	const cache = {
		fetchedAt: Date.parse("2026-09-25T19:00:00Z"),
		zai: { state: "ok", fiveHour: { label: "5h", pct: 95, resetsAt: "2026-09-25T19:09:05Z" } },
	};
	const before = Date.parse("2026-09-25T19:09:00Z");
	const after = Date.parse("2026-09-25T19:10:00Z");
	assert.equal(usageWindows(cache, "zai", before)[0].reset, undefined);
	assert.equal(usageWindows(cache, "zai", after)[0].reset, true);
	assert.match(usageLines(cache, ["zai"], 90, before)[1], /95%, resets 2026-09-25T19:09:05Z — AT\/OVER the 90% pause threshold$/);
	const stale = usageLines(cache, ["zai"], 90, after)[1];
	assert.doesNotMatch(stale, /AT\/OVER/);
	assert.match(stale, /zai 5h: reset at 2026-09-25T19:09:05Z — current usage unknown \(the cached 95% predates the reset\)/);
	assert.equal(usageWindows(cache, "zai", Date.parse("2026-09-25T19:09:05Z"))[0].reset, true, "a reset exactly now has happened");
});

test("member wake_nudge bounds mirror the wake-nudge extension", () => {
	const now = Date.parse("2026-09-25T12:00:00Z");
	assert.equal(parseDelay("1h30m"), 5_400_000);
	assert.equal(parseDelay(" 5m 10s "), 310_000);
	assert.throws(() => parseDelay("5 minutes"), /Invalid delay/);
	assert.equal(nudgeFireAt({ delay: "10m" }, now), now + 600_000);
	assert.throws(() => nudgeFireAt({ delay: "5s" }, now), /at least 10s/);
	assert.throws(() => nudgeFireAt({ delay: "25h" }, now), /at most 24h/);
	assert.throws(() => nudgeFireAt({ delay: "5m", at: "2026-09-25T13:00:00Z" }, now), /not both/);
	assert.throws(() => nudgeFireAt({}, now), /needs delay or at/);
	assert.equal(nudgeFireAt({ at: "2026-09-25T18:24:59Z" }, now), Date.parse("2026-09-25T18:24:59Z"));
	assert.equal(nudgeFireAt({ at: "2026-09-25T11:59:30Z" }, now), now + NUDGE_MIN_DELAY_MS, "within the past tolerance: clamped");
	assert.throws(() => nudgeFireAt({ at: "2026-09-25T11:58:00Z" }, now), /in the past/);
	assert.throws(() => nudgeFireAt({ at: new Date(now + NUDGE_MAX_DELAY_MS + 1000).toISOString() }, now), /at most 24h/);
	assert.throws(() => nudgeFireAt({ at: "tomorrow" }, now), /ISO-8601/);
});
