// Run: pnpm test -- server/profile-editor.test.ts. Uses a throwaway PI_CODING_AGENT_DIR in the OS
// temp dir; ~/.pi is never read or written.
//
// Settings → Profiles' writes (§chat.profiles/joined): each half through its own writer and only when
// it changed, names kept in step, a shared library half kept, the default refused for deletion, and
// choosing a default keeping the older default files written (§chat.profiles/default).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-profile-editor-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const stateDir = join(agentDir, "sova");
mkdirSync(stateDir, { recursive: true });
const yoursFile = join(stateDir, "session-profiles.json");
const libFile = join(agentDir, "subagent-profiles.json");
const libDefaultFile = join(agentDir, "subagent-profiles-default.json");
const modeFile = join(agentDir, "mode.json");
const defaultsFile = join(stateDir, "defaults.json");
const defaultProfileFile = join(stateDir, "default-profile.json");

const sp = await import("../pi-config/extensions/subagents/subagent-profiles.ts");
const { saveMine, deleteMine, duplicateMine, saveCurrentAsProfile, updateFromChat } = await import("./profile-editor");
const { chooseDefaultProfile, resolveDefaultProfile } = await import("./default-profile");
const { joinedProfiles, pickJoined } = await import("./joined-profiles");
const { DEFAULT_LIMITS } = await import("../shared/profiles");
const { saveSubagentProfiles, rebaseProfiles } = await import("./subagent-profiles");
const { DocSync } = await import("./sync/docs");
const { LIBRARY_KEY } = await import("./sync/kept");

// No model list: every worker is "not verified", a warning, never a refusal.
const sources = {
  piModels: async () => { throw new Error("offline"); },
  claudeModels: async () => { throw new Error("offline"); },
  policy: () => ({ version: 1 as const, disabledProviders: [], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }),
};
const deps = { sources };
const read = (f: string) => readFileSync(f, "utf8");
const json = <T,>(f: string) => JSON.parse(read(f)) as T;
type Yours = { version: 1; profiles: Record<string, unknown>[] };
type Lib = { version: 1; profiles: { id: string; name: string; members: unknown; alignment?: unknown }[] };
const helpers = (p: { id: string; name: string } & Record<string, unknown>) => {
  const { id: _i, name: _n, ...rest } = p;
  return rest as Record<string, unknown>;
};
const starts = { remove: [], grant: [], singleton: false, limits: DEFAULT_LIMITS, overseerMayStart: false };

beforeEach(() => {
  for (const f of [yoursFile, libFile, libDefaultFile, modeFile, defaultsFile, defaultProfileFile]) rmSync(f, { force: true });
  sp.writeSubagentProfiles(agentDir, { version: 1, profiles: [sp.legacyProfile(agentDir, "house", "House"), sp.legacyProfile(agentDir, "shared", "Shared")] });
  sp.writeProfilesDefault(agentDir, { version: 1, default: "house" });
  writeFileSync(yoursFile, JSON.stringify({
    version: 1,
    profiles: [
      { id: "house", label: "House", model: "openai/gpt-5.5", subagents: "house" },
      { id: "a", label: "Alpha", subagents: "shared" },
      { id: "b", label: "Beta", subagents: "shared" },
      { id: "plain", label: "Plain" },
    ],
  }, null, 2));
  writeFileSync(modeFile, JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
  writeFileSync(defaultsFile, JSON.stringify({ version: 1, model: "anthropic/claude-x" }));
});

describe("saving one of yours", () => {
  test("a new profile creates both halves under one id, linked", async () => {
    const r = await saveMine({ name: "Night shift", starts: { ...starts, mode: "delegate" }, model: "openai/gpt-5.5", thinking: "high" }, deps);
    assert.ok(r.ok, !r.ok ? r.error : "");
    assert.equal(r.ok && r.savedKey, "user:night-shift");
    const s = json<Yours>(yoursFile).profiles.at(-1)!;
    assert.deepEqual([s.id, s.label, s.subagents, s.mode, s.model, s.thinking], ["night-shift", "Night shift", "night-shift", "delegate", "openai/gpt-5.5", "high"]);
    const l = json<Lib>(libFile).profiles.at(-1)!;
    assert.deepEqual([l.id, l.name], ["night-shift", "Night shift"]);
    const row = pickJoined(await joinedProfiles(), "night-shift")!;
    assert.equal(row.kind, "pair");
  });

  test("a change to one half leaves the other's file byte for byte, its date too", async () => {
    const libBefore = read(libFile);
    const libTime = statSync(libFile).mtimeMs;
    const r = await saveMine({ key: "user:house", name: "House", starts: { ...starts, singleton: true } }, deps);
    assert.ok(r.ok, !r.ok ? r.error : "");
    assert.equal(json<Yours>(yoursFile).profiles[0]!.singleton, true);
    assert.equal(read(libFile), libBefore);
    assert.equal(statSync(libFile).mtimeMs, libTime);
    const yoursBefore = read(yoursFile);
    const yoursTime = statSync(yoursFile).mtimeMs;
    const house = json<Lib>(libFile).profiles.find((p) => p.id === "house")!;
    const r2 = await saveMine({ key: "user:house", name: "House", helpers: { ...helpers(house), alignment: { eagerness: "careful" } } as never }, deps);
    assert.ok(r2.ok, !r2.ok ? r2.error : "");
    assert.deepEqual(json<Lib>(libFile).profiles.find((p) => p.id === "house")!.alignment, { eagerness: "careful" });
    assert.equal(read(yoursFile), yoursBefore);
    assert.equal(statSync(yoursFile).mtimeMs, yoursTime);
    // Saving what is already saved writes nothing at all.
    const both = [read(yoursFile), read(libFile)];
    const r3 = await saveMine({ key: "user:house", name: "House", starts: { ...starts, singleton: true }, model: "openai/gpt-5.5" }, deps);
    assert.ok(r3.ok);
    assert.deepEqual([read(yoursFile), read(libFile)], both);
  });

  test("a rename renames both halves; a shared library half keeps its name", async () => {
    assert.ok((await saveMine({ key: "user:house", name: "Home" }, deps)).ok);
    assert.equal(json<Yours>(yoursFile).profiles[0]!.label, "Home");
    assert.equal(json<Lib>(libFile).profiles.find((p) => p.id === "house")!.name, "Home");
    assert.ok((await saveMine({ key: "user:a", name: "Aleph" }, deps)).ok);
    assert.equal(json<Yours>(yoursFile).profiles[1]!.label, "Aleph");
    assert.equal(json<Lib>(libFile).profiles.find((p) => p.id === "shared")!.name, "Shared");
  });

  test("an edit through one profile changes a shared half for each", async () => {
    const shared = json<Lib>(libFile).profiles.find((p) => p.id === "shared")!;
    assert.ok((await saveMine({ key: "user:a", name: "Alpha", helpers: { ...helpers(shared), alignment: { style: "pm" } } as never }, deps)).ok);
    const rows = await joinedProfiles();
    assert.deepEqual(rows.find((r) => r.id === "b")!.library?.alignment, { style: "pm" });
    assert.deepEqual(rows.find((r) => r.id === "a")!.alsoUsedBy, ["Beta"]);
  });

  test("a library-only profile gets its session half, linked under its id, only when something only that half holds is set", async () => {
    sp.writeSubagentProfiles(agentDir, { version: 1, profiles: [...json<Lib>(libFile).profiles, sp.legacyProfile(agentDir, "solo", "Solo")] });
    const before = read(yoursFile);
    assert.ok((await saveMine({ key: "library:solo", name: "Solo", starts }, deps)).ok);
    assert.equal(read(yoursFile), before, "a starts part that sets nothing makes no session half");
    const r = await saveMine({ key: "library:solo", name: "Solo", starts, model: "openai/gpt-5.5" }, deps);
    assert.equal(r.ok && r.savedKey, "user:solo");
    const s = json<Yours>(yoursFile).profiles.at(-1)!;
    assert.deepEqual([s.id, s.label, s.subagents, s.model], ["solo", "Solo", "solo", "openai/gpt-5.5"]);
    assert.equal(pickJoined(await joinedProfiles(), "solo")!.kind, "pair");
  });

  test("names follow one rule: at most 48, not blank, not Off, not another profile's (any case)", async () => {
    const before = [read(yoursFile), read(libFile)];
    const name = async (n: string) => {
      const r = await saveMine({ name: n }, deps);
      return r.ok ? null : [r.error, r.field];
    };
    assert.deepEqual(await name("x".repeat(49)), ["Profile name can be at most 48 characters.", "name"]);
    assert.deepEqual(await name("  "), ["Profile name can't be empty.", "name"]);
    assert.deepEqual(await name("off"), [`Profile name can't be "Off", the built-in profile's.`, "name"]);
    assert.deepEqual(await name("beta"), ["Another profile has this name.", "name"]);
    assert.deepEqual([read(yoursFile), read(libFile)], before, "a refused name writes nothing");
  });

  test("a yours file that can't be read refuses before either half is written", async () => {
    writeFileSync(yoursFile, "{ nope");
    const lib = read(libFile);
    const r = await saveMine({ name: "Fresh" }, deps);
    assert.equal(r.ok, false);
    assert.equal(read(libFile), lib);
    assert.equal(read(yoursFile), "{ nope");
  });

  test("a project's or a shipped profile, and Off, aren't changed here", async () => {
    const r = await saveMine({ key: "sova:default", name: "Off" }, deps);
    assert.equal(r.ok, false);
  });
});

describe("a saved Members value (retired, kept for older hosts)", () => {
  const value = { backend: "pi", model: "zai/glm-5.3", effort: "low" };
  const lib = (id: string) => json<Lib>(libFile).profiles.find((p) => p.id === id)!;
  beforeEach(() => {
    const house = sp.legacyProfile(agentDir, "house", "House");
    sp.writeSubagentProfiles(agentDir, { version: 1, profiles: [{ ...house, members: value as never }, sp.legacyProfile(agentDir, "shared", "Shared")] });
  });

  test("an edit keeps it, whatever the sent helpers say; a rename too", async () => {
    const { members: _m, ...sent } = helpers(lib("house"));
    for (const helpersSent of [{ ...helpers(lib("house")), alignment: { style: "pm" } }, { ...sent, alignment: { style: "simplified" } }, { ...sent, members: null, alignment: { eagerness: "careful" } }]) {
      const r = await saveMine({ key: "user:house", name: "House", helpers: helpersSent as never }, deps);
      assert.ok(r.ok, !r.ok ? r.error : "");
      assert.equal(lib("house").alignment !== undefined, true);
      assert.deepEqual(lib("house").members, value);
    }
    assert.ok((await saveMine({ key: "user:house", name: "Home" }, deps)).ok);
    assert.deepEqual(lib("house").members, value);
  });

  test("a new profile, a Duplicate and Save Current As Profile each write null; the original keeps its value", async () => {
    assert.ok((await saveMine({ name: "Fresh", helpers: helpers(lib("house")) as never }, deps)).ok);
    assert.ok((await duplicateMine("user:house", deps)).ok);
    assert.ok((await saveCurrentAsProfile("From chat", { helpers: "house" }, deps)).ok);
    for (const id of ["fresh", "house-copy", "from-chat"]) assert.equal(lib(id).members, null, id);
    assert.deepEqual(lib("house").members, value);
  });
});

describe("a library change that arrives while a save checks its models", () => {
  type Sources = typeof sources;
  let n = 0;
  /** Host o is this library; host a, a device whose clock runs ahead, has added Z and edited Shared. `sources` delivers that mid-save. */
  function arrival() {
    const base = join(agentDir, `arrival-${++n}`);
    const device = (id: string, dir: string, ahead = 0) => {
      const stateDirOf = join(base, `state-${id}`);
      mkdirSync(stateDirOf, { recursive: true });
      return new DocSync({ hostId: id, agentDir: dir, stateDir: stateDirOf, sidecarPath: join(stateDirOf, "doc-sync.json"), categoryEnabled: () => true, now: () => Date.now() + ahead, log: () => {} });
    };
    const aDir = join(base, "a");
    mkdirSync(aDir, { recursive: true });
    const o = device("o", agentDir);
    const a = device("a", aDir, 60_000);
    writeFileSync(join(aDir, "subagent-profiles.json"), read(libFile));
    o.observe();
    a.observe();
    const library = sp.readSubagentProfiles(aDir) as { state: "ok"; value: { version: 1; profiles: { id: string }[] } };
    const profiles = library.value.profiles.map((p) => (p.id === "shared" ? { ...p, alignment: { style: "pm" } } : p));
    sp.writeSubagentProfiles(aDir, { version: 1, profiles: [...profiles, sp.legacyProfile(aDir, "z", "Z")] });
    a.observe();
    let delivered = false;
    const during: Sources = {
      ...sources,
      piModels: async () => {
        if (!delivered) {
          delivered = true;
          assert.equal(o.apply(LIBRARY_KEY, a.doc(LIBRARY_KEY)!), null, "the arrival is taken");
        }
        throw new Error("offline");
      },
    };
    return { during, o, a, aDir, wasDelivered: () => delivered };
  }
  const lib = (id: string) => json<Lib>(libFile).profiles.find((p) => p.id === id);
  const paths: [string, (s: Sources) => Promise<{ ok?: boolean; error?: string }>, () => void][] = [
    ["an edit", (s) => saveMine({ key: "user:house", name: "House", helpers: { ...helpers(lib("house")!), alignment: { eagerness: "careful" } } as never }, { sources: s }), () => assert.deepEqual(lib("house")!.alignment, { eagerness: "careful" })],
    ["a rename with an edit", (s) => saveMine({ key: "user:house", name: "Home", helpers: { ...helpers(lib("house")!), alignment: { eagerness: "careful" } } as never }, { sources: s }), () => assert.equal(lib("house")!.name, "Home")],
    ["a new profile", (s) => saveMine({ name: "Fresh", helpers: helpers(lib("house")!) as never }, { sources: s }), () => assert.ok(lib("fresh"))],
    ["a Duplicate", (s) => duplicateMine("user:house", { sources: s }), () => assert.ok(lib("house-copy"))],
    ["Save Current As Profile", (s) => saveCurrentAsProfile("From chat", { helpers: "house" }, { sources: s }), () => assert.ok(lib("from-chat"))],
    ["a whole-library save", (s) => saveSubagentProfiles({ version: 1, profiles: json<Lib>(libFile).profiles.map((p) => (p.id === "house" ? { ...p, alignment: { eagerness: "careful" } } : p)) }, s, agentDir), () => assert.deepEqual(lib("house")!.alignment, { eagerness: "careful" })],
  ];
  for (const [what, save, saved] of paths) {
    test(`${what}: what arrived stays, no deletion is stamped or synced, and the save still lands`, async () => {
      const { during, o, a, aDir, wasDelivered } = arrival();
      const r = await save(during);
      assert.ok(r.ok !== false && !r.error, r.error ?? "");
      assert.ok(wasDelivered(), "the model check ran, and the arrival came during it");
      saved();
      assert.ok(lib("z"), "the profile that arrived is still in the file");
      assert.deepEqual(lib("shared")!.alignment, { style: "pm" }, "another profile's arriving edit stays");
      o.observe();
      const stamp = o.recordsSnapshot()[LIBRARY_KEY]!.items!.z!;
      assert.notEqual(stamp.hash, null, "no deletion stamp");
      assert.equal(stamp.origin, "a", "z is still the other device's, untouched here");
      a.apply(LIBRARY_KEY, o.doc(LIBRARY_KEY)!);
      assert.ok(sp.readSubagentProfiles(aDir).state === "ok" && JSON.parse(read(join(aDir, "subagent-profiles.json"))).profiles.some((p: { id: string }) => p.id === "z"), "and none reaches the other device");
    });
  }

  test("a whole-library save that leaves a profile out still deletes it, and nothing else", async () => {
    const { during, o } = arrival();
    const r = await saveSubagentProfiles({ version: 1, profiles: json<Lib>(libFile).profiles.filter((p) => p.id !== "shared") }, during, agentDir);
    assert.ok(!("error" in r));
    assert.equal(lib("shared"), undefined);
    assert.ok(lib("z"));
    o.observe();
    assert.equal(o.recordsSnapshot()[LIBRARY_KEY]!.items!.shared!.hash, null);
  });

  test("the rule, per profile: the save's own changes go on top of the library as it stands now", () => {
    const p = (id: string, name = id) => ({ ...sp.legacyProfile(agentDir, id, name) });
    const ids = (l: { id: string; name: string }[]) => l.map((x) => `${x.id}:${x.name}`);
    const base = [p("kept"), p("edited"), p("gone"), p("deleted-there")];
    const saved = [p("kept"), p("edited", "New name"), p("deleted-there"), p("added")];
    const now = [p("kept", "Changed there"), p("edited"), p("gone"), p("arrived")];
    assert.deepEqual(ids(rebaseProfiles(base, saved, now)), ["kept:Changed there", "edited:New name", "added:added", "arrived:arrived"]);
  });
});

describe("duplicating and deleting", () => {
  test("Duplicate copies both halves under new ids, linked, as {name} copy", async () => {
    const r = await duplicateMine("user:house", deps);
    assert.ok(r.ok, !r.ok ? r.error : "");
    const s = json<Yours>(yoursFile).profiles.at(-1)!;
    assert.deepEqual([s.id, s.label, s.subagents, s.model], ["house-copy", "House copy", "house-copy", "openai/gpt-5.5"]);
    const l = json<Lib>(libFile).profiles.at(-1)!;
    assert.deepEqual([l.id, l.name], ["house-copy", "House copy"]);
    assert.ok((await duplicateMine("user:house", deps)).ok);
    assert.equal(json<Yours>(yoursFile).profiles.at(-1)!.label, "House copy 2");
  });

  test("deleting the default is refused, the derived default included", async () => {
    // No default-profile.json: the pair linking the saved default helpers ("house") is the default.
    assert.equal(existsSync(defaultProfileFile), false);
    const r = await deleteMine("user:house", deps);
    assert.deepEqual(r.ok ? null : [r.status, r.error], [409, "Make another profile the default first."]);
  });

  test("deleting a pair deletes both halves; a library half another profile links stays", async () => {
    await chooseDefaultProfile(pickJoined(await joinedProfiles(), "plain")!, await joinedProfiles());
    const libBefore = [read(libFile), statSync(libFile).mtimeMs];
    assert.ok((await deleteMine("user:a", deps)).ok);
    assert.equal(json<Yours>(yoursFile).profiles.some((p) => p.id === "a"), false);
    assert.deepEqual([read(libFile), statSync(libFile).mtimeMs], libBefore, "the shared half's file isn't rewritten");
    assert.ok(json<Lib>(libFile).profiles.some((p) => p.id === "shared"), "Beta still links it");
    assert.ok((await deleteMine("user:b", deps)).ok);
    assert.equal(json<Lib>(libFile).profiles.some((p) => p.id === "shared"), false, "the last linker took it");
    assert.ok((await deleteMine("user:house", deps)).ok);
    assert.equal(json<Lib>(libFile).profiles.some((p) => p.id === "house"), false);
  });
});

describe("the default", () => {
  test("choosing a profile writes default-profile.json and, for what it sets, the three older files", async () => {
    await saveMine({ name: "Night", starts: { ...starts, mode: "delegate", minorModes: ["spec"] }, model: "openai/gpt-5.5", thinking: "high" }, deps);
    const rows = await joinedProfiles();
    chooseDefaultProfile(pickJoined(rows, "night")!, rows);
    assert.deepEqual(json(defaultProfileFile), { version: 1, profile: "night" });
    assert.equal(json<{ default: string }>(libDefaultFile).default, "night");
    const mode = json<{ mode: string; minorModes: string[] }>(modeFile);
    assert.deepEqual([mode.mode, mode.minorModes], ["delegate", ["spec"]]);
    assert.deepEqual(json<{ model: string; thinking: string }>(defaultsFile), { version: 1, model: "openai/gpt-5.5", thinking: "high" });
    const d = await resolveDefaultProfile();
    assert.deepEqual([d.row.key, d.info.chosen], ["user:night", true]);
  });

  test("a profile with no helpers leaves the saved default helpers as they stand, byte for byte", async () => {
    const before = [read(libDefaultFile), statSync(libDefaultFile).mtimeMs];
    const rows = await joinedProfiles();
    chooseDefaultProfile(pickJoined(rows, "plain")!, rows);
    assert.deepEqual(json(defaultProfileFile), { version: 1, profile: "plain" });
    assert.deepEqual([read(libDefaultFile), statSync(libDefaultFile).mtimeMs], before);
  });

  test("Off writes off for the helpers and leaves mode.json and defaults.json byte for byte", async () => {
    const mode = read(modeFile);
    const defaults = read(defaultsFile);
    const times = [statSync(modeFile).mtimeMs, statSync(defaultsFile).mtimeMs];
    const rows = await joinedProfiles();
    chooseDefaultProfile(pickJoined(rows, "off")!, rows);
    assert.deepEqual(json(defaultProfileFile), { version: 1, profile: "off" });
    assert.equal(json<{ default: string }>(libDefaultFile).default, "off");
    assert.equal(read(modeFile), mode);
    assert.equal(read(defaultsFile), defaults);
    assert.deepEqual([statSync(modeFile).mtimeMs, statSync(defaultsFile).mtimeMs], times);
  });

  test("before one is chosen nothing is written, and no profile's save moves it", async () => {
    await resolveDefaultProfile();
    await saveMine({ key: "user:house", name: "House", model: "zai/glm-5.3" }, deps);
    assert.equal(existsSync(defaultProfileFile), false);
    assert.equal(json<{ model: string }>(defaultsFile).model, "anthropic/claude-x");
  });
});

describe("from a chat", () => {
  test("Save Current As Profile copies the chat's helpers; Off saves none", async () => {
    const r = await saveCurrentAsProfile("From chat", { model: "openai/gpt-5.5", thinking: "low", helpers: "house" }, deps);
    assert.ok(r.ok, !r.ok ? r.error : "");
    const s = json<Yours>(yoursFile).profiles.at(-1)!;
    assert.deepEqual([s.label, s.subagents, s.model, s.thinking, s.icon], ["From chat", "from-chat", "openai/gpt-5.5", "low", "wrench"]);
    assert.equal(json<Lib>(libFile).profiles.at(-1)!.name, "From chat");
    const lib = read(libFile);
    assert.ok((await saveCurrentAsProfile("Bare chat", { helpers: "off" }, deps)).ok);
    assert.equal(json<Yours>(yoursFile).profiles.at(-1)!.subagents, "off");
    assert.equal(read(libFile), lib, "Off copies no helpers");
  });

  test("Update {name} saves the chat's model, effort and modes into its profile, never its helpers", async () => {
    const lib = read(libFile);
    const r = await updateFromChat("user:house", { model: "zai/glm-5.3", thinking: "high", mode: "delegate", minorModes: ["align", "memory"] }, deps);
    assert.ok(r.ok, !r.ok ? r.error : "");
    const s = json<Yours>(yoursFile).profiles[0]!;
    assert.deepEqual([s.model, s.thinking, s.mode, s.minorModes, s.subagents], ["zai/glm-5.3", "high", "delegate", ["align"], "house"]);
    assert.equal(read(libFile), lib);
    assert.equal((await updateFromChat("sova:default", {}, deps)).ok, false, "Off saves nothing");
  });
});
