import assert from "node:assert/strict";
import { test } from "node:test";
import {
  barShare,
  type CostChoice,
  costBars,
  costsApiSearch,
  costsHref,
  costsRouteFromHash,
  DAY_BARS_MAX,
  DEFAULT_COSTS_QUERY,
  facetChoices,
  kindRows,
  modelChoices,
  parseCostsQuery,
  pickedLabel,
  priceChangeWords,
  projectName,
  providerChoices,
  toggleModel,
  toggleProvider,
} from "./cost-history";

test("the default query has a bare address, and every query round-trips through the hash", () => {
  assert.equal(costsHref(), "#/agents/costs");
  assert.deepEqual(costsRouteFromHash("#/agents/costs"), DEFAULT_COSTS_QUERY);
  const q = { range: "7d" as const, providers: ["openai", "anthropic"], models: ["anthropic/claude-opus-5-5", "openai/gpt-5.5"] };
  const href = costsHref(q);
  assert.match(href, /^#\/agents\/costs\?/);
  assert.deepEqual(costsRouteFromHash(href), { range: "7d", providers: ["anthropic", "openai"], models: ["anthropic/claude-opus-5-5", "openai/gpt-5.5"] });
  // One selection, one address: order and repeats don't change it.
  assert.equal(costsHref({ ...q, providers: ["anthropic", "openai", "anthropic"] }), href);
});

test("a model id with slashes and commas survives the address", () => {
  const q = { range: "all" as const, providers: ["ollama-cloud"], models: ["ollama-cloud/qwen/coder,large"] };
  assert.deepEqual(costsRouteFromHash(costsHref(q)), q);
});

test("only the costs address is the costs route", () => {
  assert.equal(costsRouteFromHash("#/agents"), null);
  assert.equal(costsRouteFromHash("#/agents/team_01.abc"), null);
  assert.equal(costsRouteFromHash("#/agents/costs/x"), null);
  assert.equal(costsRouteFromHash("#/agents/costsx"), null);
});

test("#/agents/costs is the Agents page's Costs tab, matched before a team key", async () => {
  const { agentsHref, insightsRouteFromHash } = await import("./insights");
  assert.deepEqual(insightsRouteFromHash("#/agents/costs?range=all"), { page: "agents", team: null, costs: { range: "all", providers: [], models: [] } });
  assert.deepEqual(insightsRouteFromHash("#/agents"), { page: "agents", team: null });
  assert.deepEqual(insightsRouteFromHash(agentsHref("team_01.abc")), { page: "agents", team: "team_01.abc" });
  assert.deepEqual(insightsRouteFromHash("#/agents/costs-team"), { page: "agents", team: "costs-team" });
});

test("a bad range, unknown keys and models outside the picked providers fall away", () => {
  assert.deepEqual(parseCostsQuery("range=1y&foo=bar"), DEFAULT_COSTS_QUERY);
  assert.deepEqual(parseCostsQuery("?provider=zai&model=openai/gpt-5.5&model=zai/glm-5.3&model=noslash"), { range: "30d", providers: ["zai"], models: ["zai/glm-5.3"] });
  // No provider picked: any model may be picked.
  assert.deepEqual(parseCostsQuery("model=openai/gpt-5.5").models, ["openai/gpt-5.5"]);
});

test("the request always says its range and the browser's zone", () => {
  const def = new URLSearchParams(costsApiSearch(DEFAULT_COSTS_QUERY, "Asia/Kolkata"));
  assert.equal(def.get("range"), "30d");
  assert.equal(def.get("tz"), "Asia/Kolkata");
  const p = new URLSearchParams(costsApiSearch({ range: "7d", providers: ["zai"], models: ["zai/glm-5.3"] }, "UTC"));
  assert.deepEqual([p.get("range"), p.getAll("provider"), p.getAll("model")], ["7d", ["zai"], ["zai/glm-5.3"]]);
});

test("facets become one choice per provider, a provider with no model listed kept", () => {
  assert.deepEqual(facetChoices(undefined), []);
  assert.deepEqual(
    facetChoices({ providers: ["zai", "jev"], models: [{ provider: "zai", model: "glm-5.3" }, { provider: "zai", model: "glm-4" }] }),
    [{ provider: "zai", models: ["glm-5.3", "glm-4"] }, { provider: "jev", models: [] }],
  );
});

test("kinds keep the ledger's order; projects name the org project, else the folder", () => {
  const k = (kind: "main" | "overseer" | "worker" | "oneshot", n: number) => ({ kind, usd: n });
  assert.deepEqual(kindRows([k("oneshot", 9), k("worker", 1), k("main", 0)]).map((r) => r.kind), ["main", "worker", "oneshot"]);
  assert.equal(projectName({ project: "prj_abcd1234", cwd: "/x/y" }, (id) => (id === "prj_abcd1234" ? "Sova" : undefined)), "Sova");
  assert.equal(projectName({ project: "prj_gone0000", cwd: null }), "prj_gone0000");
  assert.equal(projectName({ project: null, cwd: "/home/u/webapps/sova/" }), "sova");
  assert.equal(projectName({ project: null, cwd: null }), "No project");
});

test("the last price change in words", () => {
  assert.equal(priceChangeWords(null), null);
  assert.equal(priceChangeWords({ added: [], changed: [] }), null);
  assert.equal(priceChangeWords({ added: ["a/b"], changed: ["c/d", "e/f"] }), "2 prices changed, 1 model added");
  assert.equal(priceChangeWords({ added: [], changed: ["c/d"] }), "1 price changed");
});

test("turning a provider off drops its models; picking the first one narrows to it", () => {
  const q = { range: "30d" as const, providers: [], models: ["openai/gpt-5.5", "zai/glm-5.3"] };
  const zai = toggleProvider(q, "zai");
  assert.deepEqual(zai.providers, ["zai"]);
  assert.deepEqual(zai.models, ["zai/glm-5.3"], "the other provider's model goes");
  const both = toggleProvider(zai, "openai");
  assert.deepEqual(both.providers, ["openai", "zai"]);
  const off = toggleProvider(both, "zai");
  assert.deepEqual(off, { range: "30d", providers: ["openai"], models: [] });
  assert.deepEqual(toggleProvider(off, "openai"), { range: "30d", providers: [], models: [] });
});

test("toggling a model adds and removes it, sorted", () => {
  const a = toggleModel(DEFAULT_COSTS_QUERY, "zai/glm-5.3");
  const b = toggleModel(a, "openai/gpt-5.5");
  assert.deepEqual(b.models, ["openai/gpt-5.5", "zai/glm-5.3"]);
  assert.deepEqual(toggleModel(b, "zai/glm-5.3").models, ["openai/gpt-5.5"]);
});

test("model choices narrow to the picked providers, and keep a picked model the answer dropped", () => {
  const choices: CostChoice[] = [
    { provider: "zai", models: ["glm-5.3"] },
    { provider: "openai", models: ["gpt-5.5", "gpt-5.5-mini"] },
  ];
  assert.deepEqual(
    modelChoices(choices, { providers: [], models: [] }).map((c) => c.key),
    ["openai/gpt-5.5", "openai/gpt-5.5-mini", "zai/glm-5.3"],
  );
  assert.deepEqual(
    modelChoices(choices, { providers: ["zai"], models: [] }).map((c) => c.key),
    ["zai/glm-5.3"],
  );
  const kept = modelChoices(choices, { providers: ["zai"], models: ["zai/glm-4"] });
  assert.deepEqual(kept.map((c) => c.key), ["zai/glm-4", "zai/glm-5.3"]);
  assert.deepEqual(kept[0], { key: "zai/glm-4", provider: "zai", model: "glm-4" });
  assert.deepEqual(providerChoices(choices, { providers: ["deepseek"] }), ["deepseek", "openai", "zai"]);
});

test("the picker's word", () => {
  assert.equal(pickedLabel([], "All providers", "provider", "providers"), "All providers");
  assert.equal(pickedLabel(["zai"], "All providers", "provider", "providers", (id) => id.toUpperCase()), "ZAI");
  assert.equal(pickedLabel(["a", "b", "c"], "All providers", "provider", "providers"), "3 providers");
});

test("7 and 30 days end today and fill the days nothing was spent", () => {
  const bars = costBars([{ day: "2026-10-05", usd: 2 }, { day: "2026-10-01", usd: 1 }, { day: "2026-09-01", usd: 9 }], "7d", "2026-10-05");
  assert.equal(bars.length, 7);
  assert.equal(bars[0]!.from, "2026-09-29");
  assert.equal(bars[6]!.from, "2026-10-05");
  assert.deepEqual(bars.map((b) => b.usd), [0, 0, 1, 0, 0, 0, 2], "the day outside the range is not drawn");
  const month = costBars([], "30d", "2026-03-30");
  assert.equal(month.length, 30);
  // Across the March DST change, still one bar per calendar day.
  assert.equal(month[0]!.from, "2026-03-01");
  assert.equal(new Set(month.map((b) => b.from)).size, 30);
});

test("All starts at the first day with spend; a long range becomes weeks starting Monday", () => {
  assert.deepEqual(costBars([], "all", "2026-10-05"), [{ from: "2026-10-05", to: "2026-10-05", usd: 0 }]);
  const short = costBars([{ day: "2026-10-03", usd: 1 }], "all", "2026-10-05");
  assert.deepEqual(short.map((b) => b.from), ["2026-10-03", "2026-10-04", "2026-10-05"]);
  // 2026-06-03 is a Wednesday; today 2026-10-05 is a Monday.
  const long = costBars([{ day: "2026-06-03", usd: 1 }, { day: "2026-06-07", usd: 2 }, { day: "2026-06-08", usd: 4 }, { day: "2026-10-05", usd: 8 }], "all", "2026-10-05");
  assert.ok(long.length < DAY_BARS_MAX);
  assert.deepEqual(long[0], { from: "2026-06-03", to: "2026-06-07", usd: 3 }, "the first week is partial, up to Sunday");
  assert.deepEqual(long[1], { from: "2026-06-08", to: "2026-06-14", usd: 4 });
  assert.deepEqual(long.at(-1), { from: "2026-10-05", to: "2026-10-05", usd: 8 });
  assert.equal(long.reduce((s, b) => s + b.usd, 0), 15, "weeks add up to the days");
});

test("bar heights are shares of the tallest; nothing spent is all zero", () => {
  const bars = costBars([{ day: "2026-10-04", usd: 2 }, { day: "2026-10-05", usd: 4 }], "7d", "2026-10-05");
  assert.equal(barShare(bars[6]!, bars), 1);
  assert.equal(barShare(bars[5]!, bars), 0.5);
  const none = costBars([], "7d", "2026-10-05");
  assert.ok(none.every((b) => barShare(b, none) === 0));
});
