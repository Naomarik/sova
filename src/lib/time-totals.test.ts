import assert from "node:assert/strict";
import { test } from "node:test";
import { insightsRouteFromHash } from "./insights";
import {
  barHeights,
  DEFAULT_TIME_QUERY,
  headline,
  hoursWords,
  isEmptyAnswer,
  lineShare,
  messageRows,
  messagesNote,
  messagesOffered,
  modelLines,
  parseTimeQuery,
  percentWords,
  projectChoices,
  projectKeyName,
  ratioWords,
  rowRatioWords,
  sinceWords,
  TIME_DAY_BARS_MAX,
  timeApiSearch,
  timeBars,
  timeEmptyTitle,
  timeHref,
  timeProjectRows,
  timeRouteFromHash,
  timeSessionRows,
  toolsNote,
  whatLines,
  whoLines,
  yourLines,
} from "./time-totals";

const NOW = new Date(2026, 10, 18, 12).getTime();
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 9).getTime();

test("the address: #/agents/time, the range and project only when they differ from the defaults", () => {
  assert.equal(timeHref(), "#/agents/time");
  assert.equal(timeHref({ range: "7d", project: null }), "#/agents/time?range=7d");
  assert.equal(timeHref({ range: "30d", project: "p:prj_1" }), "#/agents/time?project=p%3Aprj_1");
  assert.deepEqual(timeRouteFromHash("#/agents/time"), DEFAULT_TIME_QUERY);
  assert.deepEqual(timeRouteFromHash("#/agents/time?range=all&project=f%3A%2Fhome%2Fx"), { range: "all", project: "f:/home/x" });
  assert.equal(timeRouteFromHash("#/agents/time/x"), null);
  assert.equal(timeRouteFromHash("#/agents/timex"), null);
  assert.deepEqual(parseTimeQuery("range=1y&project="), DEFAULT_TIME_QUERY);
  // Round trip.
  const q = { range: "7d" as const, project: "o" };
  assert.deepEqual(timeRouteFromHash(timeHref(q)), q);
});

test("#/agents/time is the Time Spent tab, never read as a team key", () => {
  assert.deepEqual(insightsRouteFromHash("#/agents/time?range=7d"), { page: "agents", team: null, time: { range: "7d", project: null } });
  assert.deepEqual(insightsRouteFromHash("#/agents/time"), { page: "agents", team: null, time: DEFAULT_TIME_QUERY });
  assert.deepEqual(insightsRouteFromHash("#/agents/time-team"), { page: "agents", team: "time-team" });
});

test("the request always says the range and the zone", () => {
  assert.equal(timeApiSearch(DEFAULT_TIME_QUERY, "Europe/Berlin"), "range=30d&tz=Europe%2FBerlin");
  assert.equal(timeApiSearch({ range: "7d", project: "x" }, "UTC"), "range=7d&project=x&tz=UTC");
});

test("plain numbers: hours and minutes, a ratio, a share", () => {
  assert.equal(hoursWords(0), "0m");
  assert.equal(hoursWords(29), "0m");
  assert.equal(hoursWords(31), "1m");
  assert.equal(hoursWords(45 * 60), "45m");
  assert.equal(hoursWords(3 * 3600 + 5 * 60), "3h 05m");
  assert.equal(hoursWords(120 * 3600), "120h 00m");
  assert.equal(hoursWords(Number.NaN), "0m");
  assert.equal(ratioWords(42, 10), "4.2×");
  assert.equal(ratioWords(3, 0), "—");
  assert.equal(ratioWords(1000, 1), "1000×");
  assert.equal(percentWords(68, 100), "68%");
  assert.equal(percentWords(0.1, 100), "<1%");
  assert.equal(percentWords(99.9, 100), ">99%");
  assert.equal(percentWords(1, 0), "—");
});

test("the headline: You, Agents, the ratio over your days, While You Were Away", () => {
  const stats = headline(
    { you: 10 * 3600, agents: 40 * 3600, workerWait: 2 * 3600, away: 30 * 3600, ratio: 3.5, ratioAgents: 35 * 3600, ratioYou: 10 * 3600, daysYou: 5 },
    { worker: 32 * 3600, main: 7 * 3600, overseer: 3600 },
  );
  assert.deepEqual(
    stats.map((s) => [s.key, s.value, s.note]),
    [
      ["you", "10h 00m", "2h 00m a day you were here"],
      ["agents", "40h 00m", "80% by workers"],
      ["ratio", "3.5×", "On the days you were here"],
      ["away", "30h 00m", "75% of agent time"],
    ],
  );
  // Waiting On Workers is never in Agents.
  assert.ok(!stats.some((s) => s.value === "42h 00m"));
  const none = headline({ you: 0, agents: 0, workerWait: 0, away: 0, ratio: null, ratioAgents: 0, ratioYou: 0, daysYou: 0 }, { worker: 0, main: 0, overseer: 0 });
  assert.equal(none.find((s) => s.key === "ratio")!.value, "—");
});

test("the chart: every day of the range, a zero day a zero bar", () => {
  const bars = timeBars(
    [
      { day: "2026-11-17", you: 3600, agents: 7200, workerWait: 0 },
      { day: "2026-11-18", you: 1800, agents: 0, workerWait: 600 },
    ],
    "7d",
    "2026-11-18",
  );
  assert.equal(bars.length, 7);
  assert.equal(bars[0]!.from, "2026-11-12");
  assert.deepEqual(bars.at(-2), { from: "2026-11-17", to: "2026-11-17", you: 3600, agents: 7200 });
  assert.deepEqual(bars.at(-1), { from: "2026-11-18", to: "2026-11-18", you: 1800, agents: 0 });
  assert.equal(bars[0]!.agents, 0);
  // Heights against the tallest figure of either kind.
  assert.deepEqual(barHeights(bars.at(-2)!, bars), { agents: 1, you: 0.5 });
  assert.deepEqual(barHeights(bars.at(-1)!, bars), { agents: 0, you: 0.25 });
  assert.deepEqual(barHeights(bars[0]!, [bars[0]!]), { agents: 0, you: 0 });
});

test("the chart: All starts at the first day with time and turns to weeks past the day limit", () => {
  const short = timeBars([{ day: "2026-11-10", you: 0, agents: 60, workerWait: 0 }], "all", "2026-11-18");
  assert.equal(short.length, 9);
  assert.equal(short[0]!.from, "2026-11-10");
  const long = timeBars(
    [
      { day: "2026-06-01", you: 60, agents: 120, workerWait: 0 },
      { day: "2026-06-02", you: 60, agents: 120, workerWait: 0 },
    ],
    "all",
    "2026-11-18",
  );
  assert.ok(long.length < TIME_DAY_BARS_MAX);
  // 2026-06-01 is a Monday: the first week holds both days.
  assert.deepEqual(long[0], { from: "2026-06-01", to: "2026-06-07", you: 120, agents: 240 });
  assert.equal(long.reduce((n, b) => n + b.agents, 0), 240);
  assert.equal(timeBars([], "all", "2026-11-18").length, 1);
});

test("Your Time: the session tab's rows summed, Reading first opening to its three parts, adding up to the second", () => {
  const lines = yourLines({ "reading-transcript": 100.4, "reading-alignments": 50.3, "reading-workers": 10.3, typing: 300.5, scrolling: 20, other: 0 });
  assert.deepEqual(
    lines.map((l) => [l.key, l.label, l.seconds]),
    [
      ["reading", "Reading", 160],
      ["typing", "Typing", 301],
      ["scrolling", "Scrolling", 20],
    ],
  );
  assert.deepEqual(
    lines[0]!.parts!.map((p) => [p.label, p.seconds]),
    [
      ["Main Thread", 100],
      ["Alignments", 50],
      ["Workers", 10],
    ],
  );
  assert.equal(lines.reduce((n, l) => n + l.seconds, 0), 481);
  assert.deepEqual(yourLines({}), []);
  // No reading: no Reading row.
  assert.deepEqual(yourLines({ changes: 60 }).map((l) => l.label), ["Reviewing Changes"]);
});

test("Agent Time: who and on what, most first, empty kinds left out; models shortened", () => {
  assert.deepEqual(whoLines({ worker: 10, main: 30, overseer: 0 }).map((l) => [l.label, l.seconds]), [
    ["Main Threads", 30],
    ["Workers", 10],
  ]);
  assert.deepEqual(whatLines({ thinking: 5, writing: 9, tools: 0, waiting: 2 }).map((l) => l.label), ["Writing", "Thinking", "Waiting For The Model"]);
  const models = modelLines([
    { provider: "anthropic", model: "claude-opus-4-5", seconds: 10, replies: 1 },
    { provider: "zai", model: "glm-5", seconds: 20, replies: 2 },
    { provider: "zai", model: "glm-4", seconds: 0, replies: 0 },
  ]);
  assert.deepEqual(models.map((m) => m.key), ["zai/glm-5", "anthropic/claude-opus-4-5"]);
  assert.equal(lineShare(models[1]!, models), 0.5);
  assert.equal(lineShare({ key: "a", label: "a", seconds: 0 }, []), 0);
});

test("By Project: your time first, then agents; Other folders always last", () => {
  const row = (key: string, kind: "project" | "folder" | "overseer" | "other", you: number, agents: number) => ({ key, kind, name: key, you, agents });
  const rows = timeProjectRows([row("x", "other", 900, 900), row("p:a", "project", 10, 5), row("p:b", "project", 10, 50), row("o", "overseer", 100, 0)]);
  assert.deepEqual(rows.map((r) => r.key), ["o", "p:b", "p:a", "x"]);
  // A picked project: only its row.
  assert.deepEqual(timeProjectRows(rows, "p:a").map((r) => r.key), ["p:a"]);
  assert.equal(rowRatioWords({ you: 0, ratio: null }), "—");
  assert.equal(rowRatioWords({ you: 3600, ratio: 5.62 }), "5.6×");
});

test("Top Sessions: most of your time first", () => {
  const s = (sid: string, you: number, agents: number) => ({ sid, kind: "main" as const, parent: null, worker: null, cwd: null, project: null, row: "x", you, agents, usd: 0, lastAt: 0 });
  assert.deepEqual(timeSessionRows([s("a", 1, 1), s("b", 5, 0), s("c", 1, 9)]).map((r) => r.sid), ["b", "c", "a"]);
});

test("Your Messages: the four labels in the session tab's order, rows with nothing left out", () => {
  const rows = messageRows([
    { label: "asking", count: 2, seconds: 30 },
    { label: "specifying", count: 3, seconds: 600 },
    { label: "reworking", count: 0, seconds: 0 },
  ]);
  assert.deepEqual(rows.map((r) => [r.label, r.count, r.seconds]), [
    ["Specifying", 3, 600],
    ["Asking", 2, 30],
  ]);
  assert.equal(messagesOffered({ enabled: true }), true);
  assert.equal(messagesOffered({ enabled: false }), false);
  assert.equal(messagesOffered({} as { enabled: boolean }), true);
});

test("the states: empty, since when each kind is counted, and the labelled-time note", () => {
  assert.equal(isEmptyAnswer({ you: 0, agents: 0, workerWait: 0 }), true);
  assert.equal(isEmptyAnswer({ you: 0, agents: 0, workerWait: 5 }), false);
  assert.equal(timeEmptyTitle(DEFAULT_TIME_QUERY), "No time recorded in the last 30 days.");
  assert.equal(timeEmptyTitle({ range: "7d" }), "No time recorded in the last 7 days.");
  assert.equal(timeEmptyTitle({ range: "all" }), "No time recorded yet.");
  assert.equal(
    sinceWords({ you: at(2026, 11, 7), agents: at(2026, 10, 13), tools: at(2026, 11, 18) }, NOW),
    "This computer only. Your time is counted since Nov 7, agent time since Oct 13, tool time since Nov 18.",
  );
  assert.equal(sinceWords({ you: null, agents: at(2026, 10, 13), tools: null }, NOW), "This computer only. Agent time since Oct 13.");
  assert.equal(sinceWords({ you: null, agents: null, tools: null }, NOW), "This computer only.");
  assert.equal(toolsNote({ tools: null }, "2026-11-01", NOW), "Running Tools isn't recorded yet: agent time is reply time only.");
  assert.equal(toolsNote({ tools: at(2026, 11, 18) }, "2026-11-01", NOW), "Running Tools is counted from Nov 18; earlier days count reply time only.");
  assert.equal(toolsNote({ tools: at(2026, 11, 1) }, "2026-11-12", NOW), null);
  assert.equal(messagesNote({ byLabelTime: false }, { labels: null }, NOW), null);
  assert.equal(messagesNote({ byLabelTime: true }, { labels: at(2026, 11, 18) }, NOW), "Messages labelled before Nov 18 count on the day they were labelled.");
  assert.equal(messagesNote({ byLabelTime: true }, { labels: null }, NOW), "These messages count on the day they were labelled.");
});

test("the project filter's choices: by name, Other folders last, a picked key no longer listed kept", () => {
  const choices = projectChoices(
    [
      { key: "x", name: "Other folders", kind: "other" },
      { key: "p:b", name: "beta", kind: "project" },
      { key: "p:a", name: "alpha", kind: "project" },
    ],
    "f:/home/me/gone",
  );
  assert.deepEqual(choices, [
    { key: "p:a", name: "alpha" },
    { key: "p:b", name: "beta" },
    { key: "f:/home/me/gone", name: "gone" },
    { key: "x", name: "Other folders" },
  ]);
  assert.deepEqual(projectChoices(undefined, null), []);
  assert.equal(projectKeyName("o"), "Overseer");
  assert.equal(projectKeyName("x"), "Other folders");
});
