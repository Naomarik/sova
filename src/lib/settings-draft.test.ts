import assert from "node:assert/strict";
import { test } from "node:test";
import type { MeshSettings, SummarizerSettings } from "../../shared/protocol";
import { acceptMeshSave, meshChanges, meshDirty, meshDraft, meshDraftIssue, meshDraftOf, resetMeshDraft, sameMesh, setMeshDraft, setMeshSaved } from "./mesh-draft";
import { EMPTY_POLICY, rebasePolicy, samePolicy, setModelEnabled, setProviderEnabled, type ModelPolicy } from "./model-policy";
import { createDraftStore, dirtyForms, formNames, gatedForms, resetAllDrafts, saveRebased } from "./settings-draft";
import { rebaseSummarizer, sameSummarizer, summarizerComplete } from "./summarizer-form";
// Every Save-gated form's store, so the registry below is the app's whole registry.
import "./decision-draft";
import "./delegate-draft";
import "./experimental-draft";
import "./model-policy-draft";
import "./overseer-draft";
import "./spec-draft";
import "./summarizer-draft";
import "./team-draft";

interface Doc {
  a: number;
  b: number;
}
const same = (x: Doc, y: Doc) => x.a === y.a && x.b === y.b;

test("a draft is seeded by the first load, kept across reloads, and dropped by the dialog's reset", () => {
  const s = createDraftStore<Doc, Doc>({ tab: "general", label: "Test Keep", toDraft: (d) => ({ ...d }), same });
  assert.equal(s.dirty(), false, "nothing loaded: nothing to lose");
  s.setSaved({ a: 1, b: 1 });
  assert.deepEqual(s.draft(), { a: 1, b: 1 });
  s.setDraft({ a: 2, b: 1 });
  assert.equal(s.dirty(), true);
  s.setSaved({ a: 1, b: 5 }); // the tab remounts: a fresh read
  assert.deepEqual(s.draft(), { a: 2, b: 1 }, "without rebase a kept draft is never overwritten");
  s.discard();
  assert.deepEqual(s.draft(), { a: 1, b: 5 }, "Discard: back to what's saved");
  assert.equal(s.dirty(), false);
  s.setDraft({ a: 3, b: 5 });
  s.acceptSave({ a: 3, b: 5 });
  assert.equal(s.dirty(), false, "a landed save makes the draft the saved copy");
  s.reset();
  assert.equal(s.draft(), null);
  s.acceptSave({ a: 9, b: 9 });
  assert.equal(s.draft(), null, "a save landing after the dialog closed re-seeds nothing");
});

test("a rebasing store keeps the user's fields and takes the rest from each fresh read", () => {
  const s = createDraftStore<Doc, Doc>({
    tab: "general",
    label: "Test Rebase",
    toDraft: (d) => ({ ...d }),
    same,
    rebase: (d, base, fresh) => ({ a: d.a === base.a ? fresh.a : d.a, b: d.b === base.b ? fresh.b : d.b }),
  });
  s.setSaved({ a: 1, b: 1 });
  s.setDraft({ a: 2, b: 1 });
  s.setSaved({ a: 7, b: 8 });
  assert.deepEqual(s.draft(), { a: 2, b: 8 });
  assert.deepEqual(s.saved(), { a: 7, b: 8 });
  s.reset();
});

test("the registry: every server-backed tab has a gated form, the browser-local ones none; names in rail order", () => {
  const real = gatedForms().filter((f) => !f.label.startsWith("Test"));
  assert.deepEqual(
    real.map((f) => `${f.tab}:${f.label}`),
    ["models:Models", "modes:Delegate", "modes:Spec", "teams:Teams", "overseer:Overseer", "decisions:Decisions", "summaries:Summaries", "mesh:Mesh", "experimental:Experimental"],
  );
  assert.equal(formNames([]), "");
  assert.equal(formNames([{ label: "Models" }]), "Models");
  assert.equal(formNames([{ label: "Models" }, { label: "Decisions" }]), "Models and Decisions");
  assert.equal(formNames([{ label: "Models" }, { label: "Spec" }, { label: "Mesh" }]), "Models, Spec and Mesh");
});

test("dirtyForms names what holds edits; resetAllDrafts forgets every form", () => {
  resetAllDrafts();
  assert.deepEqual(dirtyForms(), []);
  const saved: MeshSettings = { hostLabel: "laptop", sync: { settings: true, themes: true, extensions: true, logins: true }, frontDoor: null };
  setMeshSaved(saved);
  assert.deepEqual(dirtyForms(), [], "loaded, unedited: nothing held");
  setMeshDraft({ ...meshDraft()!, hostLabel: "desk" });
  assert.deepEqual(dirtyForms().map((f) => f.label), ["Mesh"]);
  resetAllDrafts();
  assert.equal(meshDraft(), null);
  assert.deepEqual(dirtyForms(), []);
});

test("saveRebased reads first, writes the rebased draft, and writes nothing when the file already says it", async () => {
  const writes: Doc[] = [];
  const io = (fresh: Doc) => ({
    read: async () => fresh,
    settingsOf: (d: Doc) => d,
    rebase: (d: Doc, base: Doc, f: Doc) => ({ a: d.a === base.a ? f.a : d.a, b: d.b === base.b ? f.b : d.b }),
    same,
    write: async (d: Doc) => (writes.push(d), d),
  });
  const r = await saveRebased({ a: 2, b: 1 }, { a: 1, b: 1 }, io({ a: 1, b: 9 }));
  assert.deepEqual(writes, [{ a: 2, b: 9 }], "the user's a, the file's newer b");
  assert.equal(r.wrote, true);
  const none = await saveRebased({ a: 2, b: 1 }, { a: 1, b: 1 }, io({ a: 2, b: 1 }));
  assert.equal(none.wrote, false);
  assert.equal(writes.length, 1);
});

test("model policy: the same rules in any order or case; a rebase keeps the TUI's entries and the user's moves", () => {
  const p = (x: Partial<ModelPolicy>): ModelPolicy => ({ ...EMPTY_POLICY, ...x });
  assert.ok(samePolicy(p({ disabledModels: ["a/x", "b/y"] }), p({ disabledModels: ["B/Y", "a/x"] })));
  assert.ok(!samePolicy(p({ disabledModels: ["a/x"] }), p({})));
  const base = p({ disabledModels: ["openai/gpt-5.2"] });
  const mine = setModelEnabled(setModelEnabled(base, "openai/gpt-5.2", true), "zai/glm-5.3", false);
  const fresh = p({ disabledModels: ["openai/gpt-5.2", "xai/grok-5"], subagentDisabledProviders: ["ollama"] });
  const next = rebasePolicy(mine, base, fresh);
  assert.deepEqual(new Set(next.disabledModels), new Set(["xai/grok-5", "zai/glm-5.3"]), "the user's on and off, and the TUI's off");
  assert.deepEqual(next.subagentDisabledProviders, ["ollama"], "a list the user never touched is the file's");
  assert.ok(samePolicy(rebasePolicy(base, base, fresh), fresh), "no moves: the file as it is");
  const off = setProviderEnabled(p({ disabledModels: ["openai/a"] }), "openai", false);
  assert.deepEqual(rebasePolicy(off, p({ disabledModels: ["openai/a"] }), p({ disabledModels: ["openai/a"] })), off);
});

test("summaries: a slot the user left alone follows the file; Save waits for a whole, distinct chain", () => {
  const haiku = { backend: "claude-code" as const, model: "haiku" };
  const glm = { backend: "pi" as const, model: "zai/glm-5.3" };
  const base: SummarizerSettings = { primary: haiku, fallback: null };
  const fresh: SummarizerSettings = { primary: haiku, fallback: glm };
  const mine: SummarizerSettings = { primary: { backend: "pi", model: "zai/glm-5.2" }, fallback: null };
  assert.deepEqual(rebaseSummarizer(mine, base, fresh), { primary: mine.primary, fallback: glm });
  assert.ok(sameSummarizer(rebaseSummarizer(base, base, fresh), fresh));
  assert.ok(!summarizerComplete({ primary: { backend: "pi", model: "" }, fallback: null }), "a blank model");
  assert.ok(!summarizerComplete({ primary: haiku, fallback: haiku }), "a fallback that is its own primary");
  assert.ok(summarizerComplete({ primary: haiku, fallback: null }));
});

test("mesh: a save sends only the fields and sync categories that changed; a blank name can't be saved", () => {
  const saved: MeshSettings = { hostLabel: "laptop", sync: { settings: true, themes: true, extensions: true, logins: true }, frontDoor: null, loginKinds: "all" };
  const d = meshDraftOf(saved);
  assert.deepEqual(meshChanges(d, saved), {});
  assert.ok(sameMesh({ ...d, hostLabel: " laptop ", frontDoor: "  " }, saved), "spaces alone are no change");
  assert.deepEqual(meshChanges({ ...d, hostLabel: " desk ", sync: { ...d.sync, themes: false } }, saved), { hostLabel: "desk", sync: { themes: false } });
  assert.deepEqual(meshChanges({ ...d, frontDoor: "https://sova.example" }, saved), { frontDoor: "https://sova.example" });
  assert.deepEqual(meshChanges({ ...d, loginKinds: "api-keys" }, saved), { loginKinds: "api-keys" });
  assert.deepEqual(meshChanges(meshDraftOf({ ...saved, frontDoor: "https://x" }), { ...saved, frontDoor: "https://x" }), {});
  assert.deepEqual(meshChanges({ ...meshDraftOf({ ...saved, frontDoor: "https://x" }), frontDoor: "" }, { ...saved, frontDoor: "https://x" }), { frontDoor: null }, "cleared: null");
  assert.equal(meshDraftIssue({ ...d, hostLabel: "  " }), "This host needs a name.");
  assert.equal(meshDraftIssue(d), null);
  resetMeshDraft();
  setMeshSaved(saved);
  setMeshDraft({ ...meshDraft()!, hostLabel: "desk" });
  assert.equal(meshDirty(), true);
  acceptMeshSave({ ...saved, hostLabel: "desk" });
  assert.equal(meshDirty(), false);
  resetMeshDraft();
});
