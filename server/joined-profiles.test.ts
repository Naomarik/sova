// Run: pnpm test -- server/joined-profiles.test.ts. Pure: the joined list, its footprints, and the
// default as read from its file or, before one is chosen, from the older default files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildJoined, joinedFootprint, pickJoined } from "./joined-profiles";
import { defaultAmong, olderDefaultsOf } from "./default-profile";
import { DEFAULT_LIMITS, DEFAULT_PROFILE, KEEPS_OWN_MODEL, OFF_KEY, type ListedProfile } from "../shared/profiles";
import type { SubagentProfile } from "../shared/subagent-profiles";

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

function rows(yours: ListedProfile[], library: SubagentProfile[], project: ListedProfile[] = []) {
  return buildJoined({
    sources: { builtins: [off], yours, project: { state: "ok", profiles: project } },
    library: { state: "ok", file: "/x/subagent-profiles.json", value: { version: 1, profiles: library } },
  });
}

describe("the joined list", () => {
  test("a pair is one row; an unlinked library profile and an unlinked session profile are rows of their own; Off is first", () => {
    const r = rows(
      [session("claude", "Claude", { model: "claude-code-cli/claude-opus-5-5", subagents: "claude-lib" }), session("plain", "Plain")],
      [lib("claude-lib", "Claude helpers"), lib("solo", "Solo")],
    );
    assert.deepEqual(r.map((x) => [x.key, x.kind, x.name]), [
      [OFF_KEY, "off", "Off"],
      ["user:claude", "pair", "Claude"],
      ["user:plain", "session", "Plain"],
      ["library:solo", "library", "Solo"],
    ]);
    const pair = r[1]!;
    assert.equal(pair.libraryId, "claude-lib");
    assert.equal(pair.library?.name, "Claude helpers");
    assert.equal(pair.helperRoles, 4);
    const withMembers = rows([session("m", "M", { subagents: "ml" })], [{ ...lib("ml", "ML"), members: worker("b/two") }]);
    assert.equal(withMembers.find((x) => x.key === "user:m")!.helperRoles, 4, "members are no helper role of a profile's");
    // The chat's own model first, Claude by its catalog name, then the helpers' distinct primaries.
    assert.equal(pair.footprint, "Opus 5.5 + gpt-6.1-sol + glm-5.3");
    assert.deepEqual(pair.providers.sort(), ["claude", "openai-codex", "zai"]);
    assert.equal(r[2]!.footprint, KEEPS_OWN_MODEL, "no models: the chat keeps its own");
    assert.equal(r[2]!.helperRoles, 0);
    assert.equal(r[3]!.footprint, "gpt-6.1-sol + glm-5.3", "a library-only row shows its helpers' models");
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
    assert.equal(pickJoined(r, "off")?.kind, "off");
    assert.equal(pickJoined(r, "project:/p#same")?.name, "Theirs");
  });

  test("a model the registry names shows by that name; a Claude model by its catalog name; anything else by its id", () => {
    const names = new Map([["openai-codex/gpt-6.1-sol", "GPT-6.1 Sol"]]);
    assert.equal(joinedFootprint("claude-code-cli/claude-opus-5-5", lib("x", "X"), 3, names), "Opus 5.5 + GPT-6.1 Sol + glm-5.3");
  });

  test("the footprint stops at three models, then +N", () => {
    const l = lib("x", "X", "a/one");
    l.members = worker("b/two");
    l.specWriter = { primary: worker("c/three"), fallback: null } as SubagentProfile["specWriter"];
    assert.equal(joinedFootprint("d/zero", l), "zero + one + glm-5.3 +2", "five primaries; fallbacks never count");
  });
});

describe("the default", () => {
  const list = rows(
    [session("zeta", "Zeta", { subagents: "lib1" }), session("alpha", "Alpha", { subagents: "lib1", mode: "delegate", model: "openai/gpt-5.5", thinking: "high" }), session("bare", "Bare"), session("offs", "Offs", { subagents: "off" }), session("gone", "Gone", { subagents: "nope" })],
    [lib("lib1", "Lib one"), lib("solo", "Solo")],
  );

  test("a chosen default names its row by id; one naming no profile here reads as Off, saying so", () => {
    assert.equal(defaultAmong(list, { state: "ok", profile: "zeta" }, "off").row.key, "user:zeta");
    assert.equal(defaultAmong(list, { state: "ok", profile: "off" }, "lib1").row.kind, "off");
    const gone = defaultAmong(list, { state: "ok", profile: "nope" }, "lib1");
    assert.equal(gone.row.kind, "off");
    assert.match(gone.info.note ?? "", /"nope", isn't a profile here/);
    assert.equal(gone.info.chosen, true);
  });

  test("not chosen yet: the pair linking the saved default helpers, the first by name; else that library row; else Off", () => {
    const d = defaultAmong(list, { state: "absent" }, "lib1");
    assert.deepEqual([d.row.key, d.info.chosen], ["user:alpha", false]);
    assert.equal(defaultAmong(list, { state: "absent" }, "solo").row.key, "library:solo");
    assert.equal(defaultAmong(list, { state: "absent" }, "off").row.kind, "off");
  });

  test("choosing writes to the older files only what the profile sets", () => {
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.id === "alpha")!), { mode: { mode: "delegate" }, model: "openai/gpt-5.5", thinking: "high", subagents: "lib1" });
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.id === "bare")!), {}, "a profile with no helpers leaves the default helpers as they stand");
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.id === "offs")!), { subagents: "off" }, "a profile naming Off writes off");
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.id === "gone")!), {}, "a link whose half isn't here writes nothing there");
    assert.deepEqual(olderDefaultsOf(list[0]!), { subagents: "off" }, "Off");
    assert.deepEqual(olderDefaultsOf(list.find((r) => r.key === "library:solo")!), { subagents: "solo" });
  });
});
