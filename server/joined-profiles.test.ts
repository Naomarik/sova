// Run: pnpm test -- server/joined-profiles.test.ts. Pure: the joined list, its footprints, the built-in
// profiles and what takes their place, and the default as read from its file or, before one is chosen,
// from the older default files, else the built-in profile the connected accounts give.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildJoined, joinedFootprint, pickJoined } from "./joined-profiles";
import { defaultAmong, olderDefaultsOf } from "./default-profile";
import { DEFAULT_LIMITS, DEFAULT_PROFILE, KEEPS_OWN_MODEL, OFF_KEY, type ListedProfile } from "../shared/profiles";
import type { SubagentProfile } from "../shared/subagent-profiles";
import { BUILTIN_PROFILE_IDS, type ConnectedAccounts } from "../pi-config/extensions/subagents/builtin-profiles.ts";
import { builtinSessionProfile } from "./profile-sources";

const worker = (model: string, backend: "pi" | "claude-code" = "pi") => ({ backend, model, effort: "high" });
const lib = (id: string, name: string, model = "openai-codex/gpt-6.1-sol"): SubagentProfile => ({
  id,
  name,
  delegate: {
    planning: { primary: worker(model), fallback: null },
    investigation: { primary: worker(model), fallback: null },
    routine: { primary: worker("zai/glm-5.3"), fallback: null },
    complex: { primary: worker(model), fallback: worker("claude-opus-5-5", "claude-code") },
  } as unknown as SubagentProfile["delegate"],
  teams: null,
  members: null,
  specWriter: null,
});
const session = (id: string, label: string, extra: Partial<ListedProfile> = {}, source: ListedProfile["source"] = "user"): ListedProfile => ({
  id, label, icon: "wrench", description: "", remove: [], grant: [], singleton: false, limits: DEFAULT_LIMITS, overseerMayStart: false,
  source, key: source === "project" ? `project:/p#${id}` : `${source}:${id}`, ...extra,
});
const off = { ...DEFAULT_PROFILE, source: "sova" as const, key: OFF_KEY };
const builtins = BUILTIN_PROFILE_IDS.map((id) => ({ ...builtinSessionProfile(id), source: "sova" as const, key: `sova:${id}` }));
const ALL: ConnectedAccounts = { claude: true, openai: true, ollamaCloud: true };

function rows(yours: ListedProfile[], library: SubagentProfile[], project: ListedProfile[] = [], connected: ConnectedAccounts = ALL) {
  return buildJoined({
    // As profile-sources lists them: Default (never a row), then the built-in ones yours don't replace by id.
    sources: { builtins: [off, ...builtins.filter((b) => !yours.some((y) => y.id === b.id))], yours, project: { state: "ok", profiles: project } },
    library: { state: "ok", file: "/x/subagent-profiles.json", value: { version: 1, profiles: library } },
    connected,
  });
}

describe("the joined list", () => {
  test("a pair is one row; an unlinked library profile and an unlinked session profile are rows of their own; there is no Off row", () => {
    const r = rows(
      [session("work", "Work", { model: "claude-code-cli/claude-opus-5-5", subagents: "claude-lib" }), session("plain", "Plain")],
      [lib("claude-lib", "Claude helpers"), lib("solo", "Solo")],
      [],
      { claude: false, openai: false, ollamaCloud: false },
    );
    assert.deepEqual(r.map((x) => [x.key, x.kind, x.name]), [
      ["user:plain", "session", "Plain"],
      ["library:solo", "library", "Solo"],
      ["user:work", "pair", "Work"],
      ["sova:claude", "builtin", "Claude"],
    ]);
    const pair = r[2]!;
    assert.equal(pair.libraryId, "claude-lib");
    assert.equal(pair.library?.name, "Claude helpers");
    assert.equal(pair.helperRoles, 4);
    const withMembers = rows([session("m", "M", { subagents: "ml" })], [{ ...lib("ml", "ML"), members: worker("b/two") as never }]);
    assert.equal(withMembers.find((x) => x.key === "user:m")!.helperRoles, 4, "members are no helper role of a profile's");
    // The chat's own model first, Claude by its catalog name, then the helpers' distinct primaries.
    assert.equal(pair.footprint, "Opus 5.5 + gpt-6.1-sol + glm-5.3");
    assert.deepEqual(pair.providers.sort(), ["claude", "openai-codex", "zai"]);
    assert.equal(r[0]!.footprint, KEEPS_OWN_MODEL, "no models: the chat keeps its own");
    assert.equal(r[0]!.helperRoles, 0);
    assert.equal(r[1]!.footprint, "gpt-6.1-sol + glm-5.3", "a library-only row shows its helpers' models");
  });

  test("built-in profiles: listed when their account is connected (Claude alone when none is), unless a row of yours takes their place", () => {
    // [connected, yours, library, the built-in rows listed, the rows of yours that take a place]
    const none: ConnectedAccounts = { claude: false, openai: false, ollamaCloud: false };
    const cases: [ConnectedAccounts, ListedProfile[], SubagentProfile[], string[], [string, string][]][] = [
      [none, [], [], ["sova:claude"], []],
      [{ ...none, openai: true }, [], [], ["sova:openai"], []],
      [{ ...none, ollamaCloud: true }, [], [], ["sova:deepseek"], []],
      [ALL, [], [], ["sova:claude", "sova:openai", "sova:deepseek"], []],
      // The seeded starter takes Claude's place, named Claude; a profile named OpenAI takes OpenAI's.
      [ALL, [], [lib("my-setup", "My setup"), lib("x", "openai")], ["sova:deepseek"], [["library:my-setup", "sova:claude"], ["library:x", "sova:openai"]]],
      // Make It Yours: the same id, both halves.
      [ALL, [session("claude", "Claude", { subagents: "claude" })], [lib("claude", "Claude")], ["sova:openai", "sova:deepseek"], [["user:claude", "sova:claude"]]],
      // This computer: session profiles claude and openai, the starter linked by claude and named "claude".
      [ALL, [session("claude", "Claude", { subagents: "my-setup" }), session("openai", "OpenAI", { subagents: "openai-gpt" })], [lib("my-setup", "claude"), lib("openai-gpt", "OpenAI GPT")], ["sova:deepseek"], [["user:claude", "sova:claude"], ["user:openai", "sova:openai"]]],
      // A shadow of an account not connected is listed all the same: it is yours.
      [none, [], [lib("my-setup", "My setup")], [], [["library:my-setup", "sova:claude"]]],
    ];
    for (const [connected, yours, library, listed, replaced] of cases) {
      const label = `${JSON.stringify(connected)} ${yours.map((y) => y.id)} ${library.map((l) => l.id)}`;
      const r = rows(yours, library, [], connected);
      assert.deepEqual(r.filter((x) => x.group === "builtin").map((x) => x.key), listed, label);
      assert.deepEqual(r.filter((x) => x.replaces).map((x) => [x.key, x.replaces]), replaced, label);
      assert.equal(r.some((x) => x.kind === "off" || x.key === OFF_KEY), false, label);
      const names = r.map((x) => x.name.toLowerCase());
      assert.equal(new Set(names).size, names.length, `${label}: each name once`);
    }
    // The seeded starter reads as Claude in both its row and its helper half, and its file isn't touched to do so.
    const starter = lib("my-setup", "My setup");
    const r = rows([], [starter]);
    const row = r.find((x) => x.key === "library:my-setup")!;
    assert.deepEqual([row.name, row.library?.name], ["Claude", "Claude"]);
    assert.equal(starter.name, "My setup");
    // A built-in row has both halves: the chat's own model and its helpers.
    const claude = rows([], []).find((x) => x.key === "sova:claude")!;
    assert.equal(claude.session?.model, "claude-code-cli/claude-opus-5-5");
    assert.equal(claude.library?.delegate.planning.primary.model, "claude-fable-5-2");
    assert.equal(rows([], []).find((x) => x.key === "sova:openai")!.session?.model, "openai-codex/gpt-6.2-sol");
  });

  test("a link to a library profile this device lacks keeps the row, with no helpers and the reason", () => {
    const r = rows([session("gone", "Gone", { subagents: "nope" })], []);
    const row = r.find((x) => x.key === "user:gone")!;
    assert.equal(row.kind, "pair");
    assert.equal(row.library, undefined);
    assert.match(row.linkMissing ?? "", /"nope".*aren't on this device/);
  });

  test("a library half two profiles link is shared: each names the other, and it is no row of its own", () => {
    const r = rows([session("a", "Alpha", { subagents: "shared" }), session("b", "Beta", { subagents: "shared" })], [lib("shared", "Shared")], [session("p", "Proj", { subagents: "shared" }, "project")]);
    assert.equal(r.some((x) => x.key === "library:shared"), false);
    assert.deepEqual(r.find((x) => x.id === "a")!.alsoUsedBy, ["Beta", "Proj"]);
    assert.deepEqual(r.find((x) => x.id === "p")!.alsoUsedBy, ["Alpha", "Beta"]);
  });

  test("a library profile only a project profile links is that profile's Models part, not a row of its own", () => {
    const r = rows([], [lib("x", "X")], [session("p", "Proj", { subagents: "x" }, "project")]);
    assert.equal(r.some((x) => x.key === "library:x"), false);
    assert.equal(r.find((x) => x.id === "p")!.library?.id, "x");
  });

  test("a bare id is yours first, then a library-only row, then this project's", () => {
    const r = rows([session("same", "Mine")], [lib("solo", "Solo")], [session("same", "Theirs", {}, "project"), session("only-p", "OnlyP", {}, "project")]);
    assert.equal(pickJoined(r, "same")?.name, "Mine");
    assert.equal(pickJoined(r, "solo")?.kind, "library");
    assert.equal(pickJoined(r, "only-p")?.kind, "project");
    assert.equal(pickJoined(r, "off"), null, "an older build's Off names no row");
    assert.equal(pickJoined(r, "project:/p#same")?.name, "Theirs");
    // A built-in profile a row of yours takes the place of finds that row; helpers alone find the row carrying them.
    const mine = rows([session("claude", "Claude", { subagents: "my-setup" })], [lib("my-setup", "claude")]);
    assert.equal(pickJoined(mine, "sova:claude")?.key, "user:claude");
    assert.equal(pickJoined(mine, "library:my-setup")?.key, "user:claude");
    assert.equal(pickJoined(mine, "sova:openai")?.key, "sova:openai");
  });

  test("a model the registry names shows by that name; a Claude model by its catalog name; anything else by its id", () => {
    const names = new Map([["openai-codex/gpt-6.1-sol", "GPT-6.1 Sol"]]);
    assert.equal(joinedFootprint("claude-code-cli/claude-opus-5-5", lib("x", "X"), 3, names), "Opus 5.5 + GPT-6.1 Sol + glm-5.3");
  });

  test("the footprint stops at three models, then +N", () => {
    const l = lib("x", "X", "a/one");
    l.reviewer = { primary: worker("b/two"), fallback: null } as SubagentProfile["reviewer"];
    l.specWriter = { primary: worker("c/three"), fallback: null } as SubagentProfile["specWriter"];
    assert.equal(joinedFootprint("d/zero", l), "zero + one + glm-5.3 +2", "five primaries; fallbacks never count");
  });
});

describe("the default", () => {
  const list = rows(
    [session("zeta", "Zeta", { subagents: "lib1" }), session("alpha", "Alpha", { subagents: "lib1", mode: "delegate", model: "openai/gpt-5.5", thinking: "high" }), session("bare", "Bare"), session("offs", "Offs", { subagents: "off" }), session("gone", "Gone", { subagents: "nope" })],
    [lib("lib1", "Lib one"), lib("solo", "Solo")],
  );

  test("a chosen default names its row by id; Off or one naming no profile here reads as not chosen, saying why", () => {
    assert.deepEqual([defaultAmong(list, { state: "ok", profile: "zeta" }, null).row.key, defaultAmong(list, { state: "ok", profile: "zeta" }, null).info.chosen], ["user:zeta", true]);
    const off = defaultAmong(list, { state: "ok", profile: "off" }, "lib1");
    assert.deepEqual([off.row.key, off.info.chosen, off.info.note], ["user:alpha", false, undefined], "an older build's Off: as if none was chosen");
    const gone = defaultAmong(list, { state: "ok", profile: "nope" }, "lib1");
    assert.equal(gone.row.key, "user:alpha");
    assert.match(gone.info.note ?? "", /"nope", isn't a profile here, so new chats start on Alpha/);
    assert.equal(gone.info.chosen, false);
  });

  test("not chosen yet: the pair linking the saved default helpers, the first by name; else that library row; else the built-in fallback", () => {
    const d = defaultAmong(list, { state: "absent" }, "lib1");
    assert.deepEqual([d.row.key, d.info.chosen], ["user:alpha", false]);
    assert.equal(defaultAmong(list, { state: "absent" }, "solo").row.key, "library:solo");
    for (const fallback of ["claude", "openai", "deepseek"])
      assert.equal(defaultAmong(list, { state: "absent" }, fallback, fallback).row.key, `sova:${fallback}`, fallback);
    // The fallback's place taken by a row of yours: that row.
    const mine = rows([], [lib("my-setup", "My setup")]);
    assert.equal(defaultAmong(mine, { state: "absent" }, "claude", "claude").row.key, "library:my-setup");
    assert.equal(defaultAmong(mine, { state: "absent" }, "claude", "claude").row.name, "Claude");
  });

  test("choosing writes to the older files only what the profile sets, and never \"off\"", () => {
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.id === "alpha")!), { mode: { mode: "delegate" }, model: "openai/gpt-5.5", thinking: "high", subagents: "lib1" });
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.id === "bare")!), {}, "a profile with no helpers leaves the default helpers as they stand");
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.id === "offs")!), {}, "an older profile naming Off: no helpers of its own");
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.id === "gone")!), {}, "a link whose half isn't here writes nothing there");
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.key === "library:solo")!), { subagents: "solo" });
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.key === "sova:openai")!), { model: "openai-codex/gpt-6.2-sol", thinking: "medium", subagents: "openai" });
  });
});
