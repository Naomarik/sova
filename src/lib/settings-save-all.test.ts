import assert from "node:assert/strict";
import { test } from "node:test";
import type { DelegateSettings, SummarizerSettings } from "../../shared/protocol";
import type { TeamDefaults } from "../../shared/team-defaults";
import { decisionDraftProblem } from "./decision-draft";
import { draftOf } from "./decision-form";
import { delegateDraftProblem } from "./delegate-draft";
import { cloneSettings, draftComplete, draftConflicts } from "./delegate-form";
import {
  createDraftStore,
  dirtyForms,
  discardAllDrafts,
  failedForms,
  footerStatus,
  invalidForms,
  resetAllDrafts,
  saveAllDrafts,
  SaveFailed,
  savingAny,
} from "./settings-draft";
import { specDraftProblem } from "./spec-draft";
import { specDraftComplete, specDraftConflict } from "./spec-form";
import { summarizerDraftProblem } from "./summarizer-draft";
import { summarizerComplete } from "./summarizer-form";
import { teamDraftProblem } from "./team-draft";
import { cloneTeam, teamDraftComplete, teamDraftConflict } from "./team-form";

interface Doc {
  v: number;
}
const same = (a: Doc, b: Doc) => a.v === b.v;

/** A promise the test settles by hand, so "in flight" is a state the test holds, not a race. */
function gate<T>() {
  let open!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((open = res), (fail = rej)));
  return { promise, open, fail };
}

/** A form whose writes the test records, and fails when told to. */
function form(label: string, opts: { tab?: "models" | "modes" | "teams" | "mesh"; problem?: (d: Doc) => string | null; fail?: () => Error | null } = {}) {
  const writes: Doc[] = [];
  const store = createDraftStore<Doc, Doc>({
    tab: opts.tab ?? "models",
    label,
    toDraft: (d) => ({ ...d }),
    same,
    problem: opts.problem,
    write: async (d) => {
      const err = opts.fail?.();
      if (err) throw err;
      writes.push({ ...d });
      return { saved: { ...d }, warnings: d.v === 99 ? ["Not verified"] : [], result: { ...d } };
    },
  });
  store.setSaved({ v: 1 });
  return { store, writes };
}

test("Save writes every dirty form on every tab, and only those; each then reads as saved", async () => {
  resetAllDrafts();
  const models = form("Test Models", { tab: "models" });
  const delegate = form("Test Delegate", { tab: "modes" });
  const clean = form("Test Clean", { tab: "mesh" });
  models.store.setDraft({ v: 2 });
  delegate.store.setDraft({ v: 99 });
  assert.deepEqual(
    dirtyForms().map((f) => f.label),
    ["Test Models", "Test Delegate"],
    "rail order: Models before Modes",
  );
  const { saved, failed } = await saveAllDrafts();
  assert.deepEqual(saved.map((f) => f.label), ["Test Models", "Test Delegate"]);
  assert.deepEqual(failed, []);
  assert.deepEqual(models.writes, [{ v: 2 }]);
  assert.deepEqual(delegate.writes, [{ v: 99 }]);
  assert.deepEqual(clean.writes, [], "a clean form writes nothing");
  assert.deepEqual(dirtyForms(), []);
  assert.deepEqual(delegate.store.warnings(), ["Not verified"], "the save's notes stay with the form");
  assert.deepEqual(delegate.store.result(), { v: 99 });
  resetAllDrafts();
  assert.deepEqual(delegate.store.warnings(), [], "a closed dialog forgets the notes");
  assert.equal(delegate.store.result(), null);
});

test("an invalid dirty form holds every save; a clean invalid form holds none", async () => {
  resetAllDrafts();
  const good = form("Test Good");
  const bad = form("Test Bad", { tab: "teams", problem: (d) => (d.v < 0 ? "Test Bad needs a positive number." : null) });
  good.store.setDraft({ v: 2 });
  bad.store.setDraft({ v: -1 });
  assert.deepEqual(invalidForms().map((f) => f.label), ["Test Bad"]);
  assert.equal(bad.store.problem(), "Test Bad needs a positive number.");
  const r = await saveAllDrafts();
  assert.deepEqual([r.saved, r.failed], [[], []]);
  assert.deepEqual(good.writes, [], "nothing is written while any dirty form is invalid");
  assert.equal(await bad.store.save(), "skipped", "a form never writes an invalid draft, even asked directly");
  // The same invalid value, saved: the form is clean, so it holds nothing.
  bad.store.setSaved({ v: -1 }, { replaceDraft: true });
  assert.deepEqual(invalidForms(), []);
  assert.deepEqual((await saveAllDrafts()).saved.map((f) => f.label), ["Test Good"]);
  resetAllDrafts();
});

test("a failed save leaves the others saved; the failure stays with its form until an edit, a discard, or a close", async () => {
  resetAllDrafts();
  let failNext = true;
  const models = form("Test Models");
  const delegate = form("Test Delegate", { tab: "modes", fail: () => (failNext ? new Error("Server said no.") : null) });
  const spec = form("Test Spec", { tab: "modes", fail: () => (failNext ? new SaveFailed("Notes conflict", true) : null) });
  models.store.setDraft({ v: 2 });
  delegate.store.setDraft({ v: 3 });
  spec.store.setDraft({ v: 4 });
  const { saved, failed } = await saveAllDrafts();
  assert.deepEqual(saved.map((f) => f.label), ["Test Models"]);
  assert.deepEqual(failed.map((f) => f.label), ["Test Delegate", "Test Spec"], "rail order, then by name within a tab");
  assert.equal(models.store.dirty(), false, "the successful save stands");
  assert.deepEqual(delegate.store.draft(), { v: 3 }, "a failed form keeps its edit");
  assert.deepEqual(delegate.store.error(), { message: "Server said no", partial: false }, "the banner adds its own period");
  assert.deepEqual(spec.store.error(), { message: "Notes conflict", partial: true });
  assert.deepEqual(failedForms().map((f) => f.label), ["Test Delegate", "Test Spec"]);
  assert.equal(
    footerStatus({ saving: false, dirty: dirtyForms(), problem: null, failed: failedForms(), lastSaved: saved }),
    "Saved Test Models; Test Delegate and Test Spec failed.",
  );

  delegate.store.setDraft({ v: 5 });
  assert.equal(delegate.store.error(), null, "an edit clears the form's error");
  spec.store.discard();
  assert.equal(spec.store.error(), null, "so does a discard");
  assert.equal(spec.store.dirty(), false);

  failNext = false;
  assert.deepEqual((await saveAllDrafts()).saved.map((f) => f.label), ["Test Delegate"], "the retry writes what's still dirty");
  resetAllDrafts();
});

test("Discard reverts every form on every tab, whether its tab is showing or not", () => {
  resetAllDrafts();
  const a = form("Test A", { tab: "models" });
  const b = form("Test B", { tab: "mesh" });
  a.store.setDraft({ v: 7 });
  b.store.setDraft({ v: 8 });
  discardAllDrafts();
  assert.deepEqual([a.store.draft(), b.store.draft()], [{ v: 1 }, { v: 1 }]);
  assert.deepEqual(dirtyForms(), []);
  resetAllDrafts();
});

test("one write at a time per form, even across a close and reopen; a save that lands after the close reports nothing", async () => {
  resetAllDrafts();
  const g = gate<void>();
  let writes = 0;
  const store = createDraftStore<Doc, Doc>({
    tab: "models",
    label: "Test Slow",
    toDraft: (d) => ({ ...d }),
    same,
    write: async (d) => {
      writes++;
      await g.promise;
      throw new Error(`failed ${d.v}`);
    },
  });
  store.setSaved({ v: 1 });
  store.setDraft({ v: 2 });
  const first = saveAllDrafts();
  assert.equal(store.saving(), true);
  assert.equal(savingAny(), true);
  assert.deepEqual(await saveAllDrafts(), { saved: [], failed: [] }, "Save waits for the save in flight");
  assert.equal(await store.save(), "skipped", "and so does the form itself");
  resetAllDrafts(); // the dialog closes mid-save
  store.setSaved({ v: 1 }); // and reopens
  store.setDraft({ v: 3 });
  assert.equal(await store.save(), "skipped", "the old save still holds the file");
  assert.equal(writes, 1);
  g.open();
  assert.deepEqual((await first).failed.map((f) => f.label), ["Test Slow"]);
  assert.equal(store.error(), null, "an error from before the close isn't shown in the reopened dialog");
  assert.deepEqual(store.draft(), { v: 3 }, "nor does it touch the new draft");
  assert.equal(store.saving(), false);
  resetAllDrafts();
});

test("refreshSaved rebases a kept draft onto a read taken after a failed save, and never re-seeds a forgotten one", () => {
  const store = createDraftStore<{ a: number; b: number }, { a: number; b: number }>({
    tab: "overseer",
    label: "Test Refresh",
    toDraft: (d) => ({ ...d }),
    same: (x, y) => x.a === y.a && x.b === y.b,
    rebase: (d, base, fresh) => ({ a: d.a === base.a ? fresh.a : d.a, b: d.b === base.b ? fresh.b : d.b }),
  });
  store.setSaved({ a: 1, b: 1 });
  store.setDraft({ a: 2, b: 1 });
  store.refreshSaved({ a: 1, b: 5 });
  assert.deepEqual(store.draft(), { a: 2, b: 5 });
  store.reset();
  store.refreshSaved({ a: 9, b: 9 });
  assert.equal(store.draft(), null);
});

test("the footer's status line: saving, then why Save waits, then a failure, then what's unsaved, then what was saved", () => {
  const f = (...labels: string[]) => labels.map((label) => ({ label }));
  const status = (s: Partial<Parameters<typeof footerStatus>[0]>) =>
    footerStatus({ saving: false, dirty: [], problem: null, failed: [], lastSaved: [], ...s });
  assert.equal(status({}), "", "clean, nothing saved: nothing to say");
  assert.equal(status({ dirty: f("Models", "Decisions") }), "Unsaved: Models, Decisions");
  assert.equal(status({ dirty: f("Delegate"), problem: "Delegate needs a fallback model." }), "Delegate needs a fallback model.");
  assert.equal(status({ saving: true, dirty: f("Delegate"), problem: "x" }), "Saving…");
  assert.equal(status({ dirty: f("Delegate"), failed: f("Delegate"), lastSaved: f("Models") }), "Saved Models; Delegate failed.");
  assert.equal(status({ dirty: f("Delegate"), failed: f("Delegate") }), "Delegate failed.");
  assert.equal(status({ lastSaved: f("Models", "Decisions") }), "Saved Models and Decisions.");
  assert.equal(status({ dirty: f("Mesh"), lastSaved: f("Models") }), "Unsaved: Mesh", "a new edit outranks the last save");
});

// ---- each form's problem: a sentence exactly when its old Save gate said no ----

const choice = (model = "m", effort = "high") => ({ backend: "pi" as const, model, effort });

test("Delegate's problem names the missing piece, and is null exactly when draftComplete and no conflict", () => {
  const profile = { primary: choice(), fallback: null };
  const ok = cloneSettings({ version: 1, profiles: { planning: profile, investigation: profile, routine: profile, complex: profile } } as DelegateSettings);
  const withRoutine = (p: object) => ({ ...ok, profiles: { ...ok.profiles, routine: { ...ok.profiles.routine, ...p } } });
  const cases = [
    [ok, null],
    [withRoutine({ primary: choice("") }), "Delegate needs a primary model."],
    [withRoutine({ primary: choice("m", "") }), "Delegate needs an effort for a primary model."],
    [withRoutine({ fallback: choice("") }), "Delegate needs a fallback model."],
    [withRoutine({ fallback: choice("x", "") }), "Delegate needs an effort for a fallback model."],
    [withRoutine({ fallback: choice() }), "Delegate has a fallback that's the same worker as its primary."],
  ] as const;
  for (const [d, want] of cases) {
    assert.equal(delegateDraftProblem(d), want);
    assert.equal(delegateDraftProblem(d) === null, draftComplete(d) && draftConflicts(d).length === 0, "the old gate, in words");
  }
});

test("Spec's problem: none for no writer, a sentence exactly when the old gate refused", () => {
  const cases = [
    [{ version: 1, writer: null }, null],
    [{ version: 1, writer: { primary: choice(), fallback: null } }, null],
    [{ version: 1, writer: { primary: choice(""), fallback: null } }, "Spec needs a model for its writer."],
    [{ version: 1, writer: { primary: choice(), fallback: choice("x", "") } }, "Spec needs an effort for its fallback model."],
    [{ version: 1, writer: { primary: choice(), fallback: choice() } }, "Spec has a fallback that's the same worker as its writer."],
  ] as const;
  for (const [d, want] of cases) {
    assert.equal(specDraftProblem(d), want);
    assert.equal(specDraftProblem(d) === null, specDraftComplete(d) && !specDraftConflict(d));
  }
});

test("Teams' problem: role names, rows, numbers, then conflicts — null exactly when the old gate passed", () => {
  const member = { enabled: true, role: "coord", instructions: "", primary: choice(), fallback: null };
  const ok = cloneTeam({
    version: 1,
    coordinator: member,
    monitor: { ...member, role: "monitor", contextPct: 70, everyMinutes: 10, usage: { enabled: true, pausePct: 90, resumeMarginMinutes: 5 } },
    handover: { retireTimeoutMinutes: 30 },
  } as TeamDefaults);
  const edit = (f: (d: typeof ok) => void) => {
    const d = cloneTeam(ok);
    f(d);
    return d;
  };
  const cases = [
    [ok, null],
    [edit((d) => (d.coordinator.role = " ")), "Teams needs a role name for the coordinator."],
    [edit((d) => (d.monitor.primary.model = "")), "Teams needs a model and an effort for the monitor."],
    [edit((d) => (d.monitor.contextPct = Number.NaN)), "Teams needs a number for the context threshold."],
    [edit((d) => (d.handover.retireTimeoutMinutes = 0)), "Teams needs a whole number from 1 to 1440 for the retire timeout."],
    [edit((d) => (d.monitor.role = "COORD")), "Teams: The coordinator and the monitor need different role names."],
  ] as const;
  for (const [d, want] of cases) {
    assert.equal(teamDraftProblem(d), want);
    assert.equal(teamDraftProblem(d) === null, teamDraftComplete(d) && teamDraftConflict(d) === null);
  }
});

test("Summaries' and Decisions' problems match their old gates", () => {
  const haiku = { backend: "claude-code" as const, model: "haiku" };
  const chains: [SummarizerSettings, string | null][] = [
    [{ primary: haiku, fallback: null }, null],
    [{ primary: { ...haiku, model: "" }, fallback: null }, "Summaries needs a primary model."],
    [{ primary: haiku, fallback: { backend: "pi", model: "" } }, "Summaries needs a fallback model."],
    [{ primary: haiku, fallback: haiku }, "Summaries has a fallback that's the same model as its primary."],
  ];
  for (const [d, want] of chains) {
    assert.equal(summarizerDraftProblem(d), want);
    assert.equal(summarizerDraftProblem(d) === null, summarizerComplete(d));
  }
  const base = draftOf({ jev: { enabled: false }, fallback: null, features: { attention: false, tags: false, reconcile: false }, neverSendTui: true, exclusions: [] } as never);
  assert.equal(decisionDraftProblem(base), null);
  assert.equal(decisionDraftProblem({ ...base, fallback: choice("") }), "Decisions needs a fallback model.");
  assert.equal(decisionDraftProblem({ ...base, fallback: choice("m", "") }), "Decisions needs an effort for its fallback model.");
  assert.equal(decisionDraftProblem({ ...base, exclusions: "work" }), 'Decisions: "work" isn\'t a full path. Start it with / or ~/.');
});
