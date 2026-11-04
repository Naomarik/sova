// Run: pnpm test -- src/lib/create-mode-page.browser.test.ts (Solid's reactive build).
// Create on the page, as its state moves: Save as default across a switch into and out of Create
// (§chat.create-mode/per-chat-only), the rows a chat's mode list gives the menu (§chat.mode-menu/menu),
// and a card in a Create chat kept current until it ends (§chat.create-mode/settings-cards).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createModeSave } = await import("./mode-save");
const { majorGear, menuModes } = await import("./mode-menu");
const { majorGlyph } = await import("./mode-glyphs");
const { applyToast, cancelHeldSave, cardCanAct, createCardLive, QUEUE_CARD_WAITS, readCard, typedInput } = await import("./settings-card-live");
type ShownMode = import("./mode-menu").ShownMode;
type SettingsCardView = import("../../shared/project-settings").SettingsCardView;
type CardReads = import("./settings-card-live").CardReads;

const within = <T>(run: (dispose: () => void) => T): T => solid.createRoot(run);

describe("Save as default across Create", () => {
  const profiles = { current: { id: "subs", name: "Subs", source: "library" }, default: "subs" } as never;
  const delegate: ShownMode = { mode: "delegate", minorModes: ["align"], strict: true };

  test("a saved Delegate stays saved when the chat moves to Create, and the button keeps naming Delegate", () => {
    within((dispose) => {
      const [shown, setShown] = solid.createSignal<ShownMode | null>(delegate);
      const [def, setDef] = solid.createSignal<ShownMode | null>(delegate);
      const save = createModeSave({ shown, defaultMode: def, profiles: () => profiles });
      assert.equal(save.already(), true);

      setShown({ ...delegate, mode: "create", saveMode: "delegate" });
      assert.equal(save.already(), true, "moving to Create changes nothing a save would write");
      assert.equal(save.savable()?.mode, "delegate");
      assert.match(save.note(), /no default holds it\. Save as default saves delegate · strict · align\.$/);
      assert.doesNotMatch(save.title(), /create/);

      setDef({ mode: "normal", minorModes: [], strict: false });
      assert.equal(save.already(), false, "the file moved on: the button can be pressed again");
      assert.match(save.title(), /New sessions will start from delegate/);

      setShown({ mode: "normal", minorModes: [], strict: false });
      assert.equal(save.already(), true, "out of Create the chat's own mode is what counts");
      assert.doesNotMatch(save.note(), /Create/);
      dispose();
    });
  });

  test("a chat that has been in no other mode saves normal, and unknown is never saved", () => {
    within((dispose) => {
      const [shown] = solid.createSignal<ShownMode | null>({ mode: "create", minorModes: ["align"], strict: false });
      const [def, setDef] = solid.createSignal<ShownMode | null>(null);
      const save = createModeSave({ shown, defaultMode: def, profiles: () => profiles });
      assert.equal(save.savable()?.mode, "normal");
      assert.equal(save.already(), false, "the file isn't read yet");
      setDef({ mode: "normal", minorModes: ["align"], strict: false });
      assert.equal(save.already(), true);
      dispose();
    });
  });

  test("a save that also writes the memory type isn't done until that matches too", () => {
    within((dispose) => {
      const [same, setSame] = solid.createSignal(false);
      const save = createModeSave({ shown: () => delegate, defaultMode: () => delegate, profiles: () => profiles, alsoSaved: same });
      assert.equal(save.already(), false);
      setSame(true);
      assert.equal(save.already(), true);
      dispose();
    });
  });
});

describe("Create's row", () => {
  test("the global list gives a peer's chat the row; an older host gives none, and Create comes after the rest", () => {
    const normal = { id: "normal", description: "" };
    const create = { id: "create", description: "" };
    assert.deepEqual(menuModes({ modes: [normal], chatModes: [create] }), [normal, create]);
    assert.deepEqual(menuModes({ modes: [normal] }), [normal]);
  });

  test("Create and Delegate each carry a gear and their own icon; normal has no gear", () => {
    assert.equal(majorGear("create"), "configure-create");
    assert.equal(majorGear("delegate"), "configure-delegate");
    assert.equal(majorGear("normal"), null);
    assert.deepEqual(majorGlyph("create"), { kind: "icon", id: "create", icon: "mode-create" });
  });
});

describe("a card in a Create chat", () => {
  const card = (over: Partial<SettingsCardView> = {}): SettingsCardView =>
    ({ id: "sw_1", state: "waiting", title: "T", why: "", by: { kind: "create" }, createdAt: "", kept: [], files: [], grants: [], lands: null, diff: "", fingerprint: "f", ...over }) as SettingsCardView;
  /** Stand-in reads and a timer the test fires itself. */
  const rig = (answer: () => SettingsCardView | Error) => {
    const calls: string[] = [];
    let fire: (() => void) | null = null;
    const list = async (who: string) => {
      calls.push(who);
      const a = answer();
      if (a instanceof Error) throw a;
      return a.state === "waiting" ? { cards: [a], recent: [] } : { cards: [], recent: [a] };
    };
    const reads: CardReads = { project: (id) => list(`project:${id}`), sova: () => list("sova") };
    const timer = (run: () => void) => {
      fire = run;
      return () => void (fire = null);
    };
    return { calls, reads, timer, fire: () => fire?.(), ticking: () => fire !== null };
  };
  const settled = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setImmediate(r));
    assert.ok(done(), "the read arrived");
  };

  test("Apply's toast says only what happened: held isn't applied, and an unrecorded grant isn't approved", () => {
    const granted = { id: "sc_6", grants: [{ key: "k" }] } as unknown as Pick<SettingsCardView, "id" | "grants">;
    assert.equal(applyToast({ state: "applied" }, granted), "Applied and approved sc_6.");
    assert.equal(applyToast({ state: "applied" }, { id: "sc_6", grants: [] }), "Applied sc_6.");
    assert.equal(applyToast({ state: "waiting" }, granted), QUEUE_CARD_WAITS);
    assert.equal(applyToast({ state: "waiting", saveWords: "Saves once release v1.2.0 is published or abandoned." }, granted), "Saves once release v1.2.0 is published or abandoned.");
    const one = applyToast({ state: "applied", stillNeeds: ["a"] }, granted);
    assert.equal(one, "Applied sc_6. 1 approval still needs you: the card says where.");
    assert.match(applyToast({ state: "applied", stillNeeds: ["a", "b"] }, granted), /2 approvals still need you/);
    assert.equal(applyToast({ state: "applied" }, { ...granted, id: "local" }), "Landed the folder's settings edits.");
    assert.match(applyToast({ state: "applied", stillNeeds: ["a"] }, { ...granted, id: "local" }), /^Landed the folder's settings edits\. 1 approval/);
  });

  test("the field goes with Apply only on a card that asks for it", () => {
    const asks = { input: { field: "pin", label: "Fingerprint" } };
    assert.equal(typedInput(asks, "  abc  "), "abc");
    assert.equal(typedInput(asks, "   "), "", "empty holds Apply back");
    assert.equal(typedInput({}, "abc"), undefined, "a card with no field sends nothing");
  });

  test("a partly applied answer never toasts Applied or approved", () => {
    const t = applyToast({ state: "applied", partly: true, stillNeeds: ["Partly applied: …"] }, { id: "sw_4", grants: [{ key: "k" }] } as unknown as Pick<SettingsCardView, "id" | "grants">);
    assert.equal(t, "Partly applied sw_4: the card says what took effect.");
  });

  test("Cancel Save takes the card's own road: the folder's edits are never discarded by it", () => {
    const done: string[] = [];
    const cancels = {
      queue: async (p: string) => void done.push(`queue:${p}`),
      card: async (p: string, id: string) => void done.push(`card:${p}:${id}`),
      local: async (p: string) => void done.push(`local:${p}`),
    };
    void cancelHeldSave({ id: "sc_4", kind: "queue" }, "p1", cancels);
    void cancelHeldSave({ id: "sc_5" }, "p1", cancels);
    void cancelHeldSave({ id: "local" }, "p1", cancels);
    assert.deepEqual(done, ["queue:p1", "card:p1:sc_5", "local:p1"]);
  });

  test("only the chat that prepared it, or the overseer's own, may act; an archived pane may not", () => {
    assert.equal(cardCanAct({ overseer: false, create: true }, { create: true }), true);
    assert.equal(cardCanAct({ overseer: false, create: true }, {}), false, "an overseer's card in someone else's chat");
    assert.equal(cardCanAct({ overseer: true, create: false }, {}), true);
    assert.equal(cardCanAct({ overseer: false, create: false }, { create: true }), false, "archived");
  });

  test("a Sova-wide card reads its own list, a project's card its project's", async () => {
    const r = rig(() => card());
    assert.equal((await readCard({ projectId: null }, "sw_1", r.reads))?.id, "sw_1");
    await readCard({ projectId: "p1" }, "sw_1", r.reads);
    assert.deepEqual(r.calls, ["sova", "project:p1"]);
  });

  test("it follows a held Save to its end, then stops reading", async () => {
    let now = card({ id: "sc_4", kind: "queue" });
    const r = rig(() => now);
    await within(async (dispose) => {
      const { live } = createCardLive({ details: { projectId: "p1", card: card({ id: "sc_4" }) }, canAct: () => true, reads: r.reads, everyMs: 1, timer: r.timer });
      await settled(() => live() !== null);
      assert.equal(r.ticking(), true);

      now = card({ id: "sc_4", kind: "queue", saveWaits: true });
      r.fire();
      await settled(() => live()?.saveWaits === true);
      assert.equal(live()?.state, "waiting", "a held Save is still waiting");

      now = card({ id: "sc_4", kind: "queue", state: "applied", commit: "abc" });
      r.fire();
      await settled(() => live()?.state === "applied");
      assert.equal(r.ticking(), false, "an ended card reads no more");
      dispose();
    });
  });

  test("a failed read keeps what is shown, and the next one still lands", async () => {
    let now: SettingsCardView | Error = card();
    const r = rig(() => now);
    await within(async (dispose) => {
      const { live } = createCardLive({ details: { projectId: null, card: card() }, canAct: () => true, reads: r.reads, everyMs: 1, timer: r.timer });
      await settled(() => live() !== null);
      now = new Error("server away");
      r.fire();
      await settled(() => r.calls.length === 2);
      assert.equal(live()?.id, "sw_1");
      now = card({ state: "dismissed" });
      r.fire();
      await settled(() => live()?.state === "dismissed");
      dispose();
    });
  });

  test("a view that can't act reads nothing: the transcript's copy is what it draws", async () => {
    const r = rig(() => card());
    within((dispose) => {
      createCardLive({ details: { projectId: "p1", card: card() }, canAct: () => false, reads: r.reads, everyMs: 1, timer: r.timer });
      dispose();
    });
    assert.deepEqual(r.calls, []);
    assert.equal(r.ticking(), false);
  });

  test("closing the view stops the reading", async () => {
    const r = rig(() => card());
    await within(async (dispose) => {
      const { live } = createCardLive({ details: { projectId: null, card: card() }, canAct: () => true, reads: r.reads, everyMs: 1, timer: r.timer });
      await settled(() => live() !== null);
      dispose();
    });
    assert.equal(r.ticking(), false);
  });
});
