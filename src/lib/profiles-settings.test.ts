import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, type JoinedProfile, type Profile } from "../../shared/profiles";
import type { SubagentProfile } from "../../shared/subagent-profiles";
import type { WorkerChoice } from "../../shared/protocol";
import { firstIssue } from "../../shared/form-rules";
import {
  alsoUsedBy,
  canonical,
  chatRefOf,
  choiceOfRef,
  draftOf,
  footprintOfDraft,
  listGroups,
  OFF_KEY,
  profilesDraftFields,
  setAllTo,
  sharersOf,
  typedDraft,
  withDeleted,
  withDuplicate,
  withNewProfile,
  type ProfilesDraft,
} from "./profiles-settings";

const w = (backend: WorkerChoice["backend"], model: string, effort: string): WorkerChoice => ({ backend, model, effort });
function lib(id: string, name: string, over: Partial<SubagentProfile> = {}): SubagentProfile {
  return {
    id,
    name,
    delegate: {
      planning: { primary: w("claude-code", "claude-opus-5-5", "medium"), fallback: null },
      investigation: { primary: w("claude-code", "claude-opus-5-5", "high"), fallback: null },
      routine: { primary: w("pi", "zai/glm-5.3", "low"), fallback: w("claude-code", "claude-opus-5-5", "low") },
      complex: { primary: w("claude-code", "claude-opus-5-5", "xhigh"), fallback: null },
    },
    teams: null,
    members: null,
    specWriter: { primary: w("claude-code", "claude-opus-5-5", "high"), fallback: null },
    ...over,
  };
}
function session(id: string, label: string, over: Partial<Profile> = {}): Profile {
  return { id, label, icon: "grid", description: "", remove: [], grant: [], singleton: false, limits: { ...DEFAULT_LIMITS }, overseerMayStart: false, ...over };
}
function joined(over: Partial<JoinedProfile> & Pick<JoinedProfile, "key" | "kind" | "group" | "name">): JoinedProfile {
  return { id: over.key.split(":").pop()!, footprint: "fp", providers: [], helperRoles: 0, ...over };
}
const OFF = joined({ key: OFF_KEY, id: "off", kind: "off", group: "builtin", name: "Off", footprint: "Keeps the chat's own model" });
const claude = joined({ key: "user:claude", kind: "pair", group: "yours", name: "Claude", session: { ...session("claude", "Claude", { model: "claude-code-cli/claude-opus-5-5", thinking: "high", subagents: "c" }), source: "user", key: "user:claude" }, libraryId: "c", library: lib("c", "Claude"), footprint: "Opus 5.5 + glm-5.3" });
const twin = joined({ key: "user:twin", kind: "pair", group: "yours", name: "Twin", session: { ...session("twin", "Twin", { subagents: "c" }), source: "user", key: "user:twin" }, libraryId: "c", library: lib("c", "Claude") });
const libOnly = joined({ key: "library:fast", kind: "library", group: "yours", name: "Fast", libraryId: "fast", library: lib("fast", "Fast") });
const project = joined({ key: "project:/r#rel", kind: "project", group: "project", name: "Release checker", approval: "needed", libraryId: "c", library: lib("c", "Claude") });
const WIRE = [OFF, claude, twin, libOnly, project];

test("the draft holds yours only, each library half once, and the default", () => {
  const d = draftOf(WIRE, "user:claude");
  assert.deepEqual(d.rows.map((r) => r.key), ["user:claude", "user:twin", "library:fast"], "no Off, no project's");
  assert.deepEqual(Object.keys(d.library).sort(), ["c", "fast"], "a shared half is one entry");
  assert.equal(d.rows[0]!.model, "claude-code-cli/claude-opus-5-5");
  assert.equal(d.rows[2]!.starts, null, "a library-only profile has no When a Chat Starts half yet");
  assert.equal(d.default, "user:claude");
  assert.ok(!("id" in d.library.c!) && !("name" in d.library.c!), "a half is the library profile less its id and name");
});

test("the list: Yours in the draft's order, This project, Built in with Off first; chips by key", () => {
  const d = draftOf(WIRE, "user:claude");
  const g = listGroups(d, WIRE, d);
  assert.deepEqual(g.yours.map((r) => r.name), ["Claude", "Twin", "Fast"]);
  assert.deepEqual(g.project.map((r) => r.name), ["Release checker"]);
  assert.deepEqual(g.builtin.map((r) => r.key), [OFF_KEY]);
  assert.equal(g.yours[0]!.isDefault, true);
  assert.equal(g.project[0]!.needsApproval, true, "a project profile needing approval says so");
  assert.equal(g.yours[0]!.footprint, "Opus 5.5 + glm-5.3", "an unchanged profile keeps the server's footprint");
  const renamed: ProfilesDraft = JSON.parse(JSON.stringify(d));
  renamed.rows[0]!.model = null;
  renamed.library.c!.delegate.routine.primary = w("claude-code", "claude-opus-5-5", "low");
  assert.equal(listGroups(renamed, WIRE, d).yours[0]!.footprint, "Opus 5.5", "an edited one is worked out from the draft");
  const offDefault = { ...d, default: OFF_KEY };
  assert.equal(listGroups(offDefault, WIRE, d).builtin[0]!.isDefault, true, "Off can be the default");
});

test("the footprint: distinct models, the chat's own first, at most 3 then +N; none reads as the chat's own", () => {
  const h = { ...lib("x", "x") } as SubagentProfile;
  h.delegate.planning.primary = w("pi", "a/one", "low");
  h.delegate.investigation.primary = w("pi", "b/two", "low");
  h.delegate.routine.primary = w("pi", "c/three", "low");
  h.delegate.complex.primary = w("pi", "d/four", "low");
  h.specWriter = null;
  const row = { key: "k", name: "n", starts: null, model: "claude-code-cli/claude-opus-5-5", thinking: null, lib: "x" };
  assert.equal(footprintOfDraft(row, h), "Opus 5.5 + one + two +2");
  assert.equal(footprintOfDraft({ ...row, model: null, lib: null }, undefined), "Keeps the chat's own model");
  assert.equal(footprintOfDraft({ ...row, model: null }, { ...h, members: w("pi", "z/members", "low") }), "one + two + three +1", "a saved members value is no model of the profile's");
});

test("Set All To: every model row to the pick on its own backend, This chat included; each effort kept where the model takes it", () => {
  const d = draftOf(WIRE, "user:claude");
  const next = setAllTo(d, "user:claude", { backend: "pi", model: "openai/gpt-6.1-sol" }, {
    efforts: () => ["low", "medium", "high"],
    levels: () => ["off", "low", "medium"],
  });
  const h = next.library.c!;
  assert.deepEqual(Object.values(h.delegate).map((r) => [r.primary.backend, r.primary.model, r.primary.effort]), [
    ["pi", "openai/gpt-6.1-sol", "medium"],
    ["pi", "openai/gpt-6.1-sol", "high"],
    ["pi", "openai/gpt-6.1-sol", "low"],
    ["pi", "openai/gpt-6.1-sol", ""],
  ], "xhigh isn't the new model's: left blank, so Save waits");
  assert.deepEqual(h.specWriter!.primary, w("pi", "openai/gpt-6.1-sol", "high"));
  assert.deepEqual(h.delegate.routine.fallback, w("claude-code", "claude-opus-5-5", "low"), "fallbacks stay");
  assert.equal(h.teams, null, "a row holding no model (the roles on the default model) stays");
  assert.equal(h.members, null);
  const withMembers: ProfilesDraft = JSON.parse(JSON.stringify(d));
  withMembers.library.c!.members = w("pi", "zai/glm-5.3", "low");
  const set = setAllTo(withMembers, "user:claude", { backend: "pi", model: "openai/gpt-6.1-sol" }, { efforts: () => null, levels: () => null });
  assert.deepEqual(set.library.c!.members, w("pi", "zai/glm-5.3", "low"), "Set All has no Members target: a saved value is left as it is");
  const chat = next.rows.find((r) => r.key === "user:claude")!;
  assert.equal(chat.model, "openai/gpt-6.1-sol", "This chat moves too");
  assert.equal(chat.thinking, "", "high isn't on the new model's ladder: left blank, as a helper row's is");
  assert.equal(d.library.c!.delegate.planning.primary.model, "claude-opus-5-5", "the draft it was given is untouched");
  assert.notEqual(firstIssue(profilesDraftFields(next, d)), null, "a blanked effort holds Save");
  // This chat's blank effort holds Save on its own, every helper row complete (§app.settings-dialog/profile-set-all).
  const onlyChat = setAllTo(d, "user:claude", { backend: "pi", model: "openai/gpt-6.1-sol" }, { efforts: () => null, levels: () => ["off", "low"] });
  assert.equal(firstIssue(profilesDraftFields(onlyChat, d))?.message, "Claude's This chat rows each need a model and an effort.");
  const chosen: ProfilesDraft = JSON.parse(JSON.stringify(onlyChat));
  chosen.rows[0]!.thinking = "low";
  assert.equal(firstIssue(profilesDraftFields(chosen, d)), null, "choosing an effort clears it");
  chosen.rows[0]!.thinking = null;
  assert.equal(firstIssue(profilesDraftFields(chosen, d)), null, "so does Its default (no effort saved)");
  const kept = setAllTo(d, "user:claude", { backend: "claude-code", model: "claude-sonnet-5-5" }, { efforts: () => null, levels: () => null });
  assert.equal(kept.rows[0]!.model, "claude-code-cli/claude-sonnet-5-5", "a Claude Code pick is the chat's claude-code-cli ref");
  assert.equal(kept.rows[0]!.thinking, "high", "a ladder nobody can say keeps the effort");
  assert.ok(Object.values(kept.library.c!.delegate).every((r) => r.primary.effort !== ""), "efforts nobody can check are kept");
});

test("the chat's own ref and a helper's pick map both ways", () => {
  assert.equal(chatRefOf("claude-code", "claude-opus-5-5"), "claude-code-cli/claude-opus-5-5");
  assert.equal(chatRefOf("pi", "zai/glm-5.3"), "zai/glm-5.3");
  assert.deepEqual(choiceOfRef("claude-code-cli/claude-opus-5-5"), { backend: "claude-code", model: "claude-opus-5-5" });
  assert.deepEqual(choiceOfRef("zai/glm-5.3"), { backend: "pi", model: "zai/glm-5.3" });
});

test("Also used by: the other profiles linking the same library half, yours then the project's", () => {
  const d = draftOf(WIRE, "user:claude");
  assert.deepEqual(sharersOf(d, "user:claude", WIRE), ["Twin", "Release checker"]);
  assert.deepEqual(sharersOf(d, "library:fast", WIRE), []);
  assert.equal(alsoUsedBy([]), null);
  assert.equal(alsoUsedBy(["Twin"]), "Also used by Twin");
  assert.equal(alsoUsedBy(["Twin", "Release checker"]), "Also used by Twin and Release checker");
  assert.equal(alsoUsedBy(["A", "B", "C", "D"]), "Also used by A and 3 others");
});

test("New Profile: under Yours, named New profile, the source's models, both halves; Duplicate copies its own half", () => {
  const d = draftOf(WIRE, "user:claude");
  const src = d.rows[0]!;
  const { draft, key } = withNewProfile(d, { model: src.model, thinking: src.thinking, helpers: d.library.c! }, null);
  const row = draft.rows.at(-1)!;
  assert.equal(row.key, key);
  assert.equal(row.name, "New profile");
  assert.equal(row.model, src.model);
  assert.ok(row.starts, "a new profile has both halves");
  assert.notEqual(row.lib, "c", "its own library half, never the source's");
  assert.equal(canonical(draft.library[row.lib!]), canonical(d.library.c));
  assert.equal(withNewProfile(draft, null, d.library.c!).draft.rows.at(-1)!.name, "New profile 2");
  const dup = withDuplicate(d, "user:twin", null);
  const copy = dup.draft.rows.at(-1)!;
  assert.equal(copy.name, "Twin copy");
  assert.notEqual(copy.lib, "c");
});

test("Delete: refused for the default; a library half another profile links stays, the last one's goes", () => {
  const d = draftOf(WIRE, "user:claude");
  assert.equal(withDeleted(d, "user:claude"), "Make another profile the default first.");
  const one = withDeleted(d, "user:twin") as ProfilesDraft;
  assert.ok(one.library.c, "Claude still links it");
  const two = withDeleted({ ...one, default: OFF_KEY }, "user:claude") as ProfilesDraft;
  assert.equal(two.library.c, undefined, "nobody links it now");
});

test("what Save waits for: a name's rules, then each library half's rows, in the editor's sentences", () => {
  const d = draftOf(WIRE, "user:claude");
  assert.equal(firstIssue(profilesDraftFields(d, d)), null);
  const bad = (edit: (x: ProfilesDraft) => void) => {
    const x: ProfilesDraft = JSON.parse(JSON.stringify(d));
    edit(x);
    return firstIssue(profilesDraftFields(x, d))?.message ?? null;
  };
  assert.equal(bad((x) => (x.rows[1]!.name = "claude")), "Another profile has this name.");
  assert.equal(bad((x) => (x.rows[1]!.name = "Off")), `Profile name can't be "Off", the built-in profile's.`);
  assert.equal(bad((x) => (x.rows[1]!.name = "x".repeat(49))), "Profile name can be at most 48 characters.");
  assert.equal(bad((x) => (x.library.fast!.delegate.planning.primary.effort = "")), "Fast's Delegate rows each need a model and an effort.");
  assert.match(bad((x) => (x.rows[0]!.starts!.grant = ["sessions.read"], ((x.rows[0]!.starts!.limits as unknown as Record<string, unknown>).hops = "1."))) ?? "", /Hops/);
});

test("an older profile's longer name reads until renamed", () => {
  const long = "y".repeat(55);
  const old = joined({ key: "user:old", kind: "session", group: "yours", name: long, session: { ...session("old", long), source: "user", key: "user:old" } });
  const d = draftOf([OFF, old], OFF_KEY);
  assert.equal(firstIssue(profilesDraftFields(d, d)), null, "kept as it is, it saves");
  const renamed: ProfilesDraft = JSON.parse(JSON.stringify(d));
  renamed.rows[0]!.name = long + "z";
  assert.equal(firstIssue(profilesDraftFields(renamed, d))?.message, "Profile name can be at most 48 characters.");
});

test("a limit box's typed text saves as its number", () => {
  const d = draftOf(WIRE, "user:claude");
  const x: ProfilesDraft = JSON.parse(JSON.stringify(d));
  (x.rows[0]!.starts!.limits as unknown as Record<string, unknown>).hops = "7";
  assert.equal(typedDraft(x).rows[0]!.starts!.limits.hops, 7);
});

test("a save's notes are the profiles it touched, one banner's worth; a note about another profile isn't this save's", async () => {
  const { notesFor } = await import("./profiles-draft");
  const notes = ["OpenAI: Planning primary: gpt-6.1-sol isn't offered by pi", "Claude: Routine fallback: not verified", "Not verified, because pi couldn't list its models: Claude: Planning, Ollama: Routine"];
  assert.deepEqual(notesFor(notes, new Set(["Claude"])), [notes[1], notes[2]]);
  assert.deepEqual(notesFor(notes, new Set(["Tester"])), []);
});
