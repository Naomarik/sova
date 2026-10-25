// Run: pnpm test -- src/lib/reply-slot.test.ts
// What an extension adds under a reply (§app.commands/reply-slot), DOM-free: the validator's
// fixtures (each bad part dropped), the frame's wall (the vis frame's own attributes and CSP),
// the reply never waiting (nothing drawn at start; a late answer dropped), a throwing or malformed
// answer drawing nothing while the others draw, the auto-mute and the user's off switch.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHIPS_PER_REPLY,
  CONTENT_HEIGHT_MAX,
  CONTENT_MAX_BYTES,
  createSlotPolicy,
  frameLoadGuard,
  MUTE_AFTER,
  startReplySlot,
  validateAnswer,
  validChip,
  validContent,
  walledSrcdoc,
  WALLED_CSP,
  WALLED_FRAME_ATTRS,
  type SlotSource,
  type SlotState,
} from "./reply-slot";

const ext = { id: "notes", title: "Notes", actions: ["pin"] };
const ok = { label: "Pinned", tone: "ok", action: "pin" };

test("a good chip is kept, named after its extension", () => {
  assert.deepEqual(validChip(ok, ext), { extension: "notes", extensionTitle: "Notes", label: "Pinned", tone: "ok", action: "pin" });
  assert.deepEqual(validChip({ label: "Open PR #12", tone: "info", icon: "external", href: "https://example.com/pr/12" }, ext)?.href, "https://example.com/pr/12");
});

test("fixtures: oversize, bad tone, script-like label, unknown action, bad href scheme, Sova's own names: each dropped", () => {
  const bad: Record<string, unknown> = {
    oversize: { ...ok, label: "x".repeat(25) },
    badTone: { ...ok, tone: "accent" },
    scriptLabel: { ...ok, label: "<script>alert(1)" },
    quoteLabel: { ...ok, label: 'say "hi"' },
    ampLabel: { ...ok, label: "a &amp; b" },
    controlLabel: { ...ok, label: "a\u0000b" },
    unknownAction: { ...ok, action: "delete-everything" },
    javascriptHref: { label: "Go", tone: "ok", href: "javascript:alert(1)" },
    dataHref: { label: "Go", tone: "ok", href: "data:text/html,hi" },
    fileHref: { label: "Go", tone: "ok", href: "file:///etc/passwd" },
    bothHrefAndAction: { ...ok, href: "https://example.com" },
    neither: { label: "Go", tone: "ok" },
    unknownIcon: { ...ok, icon: "rocket" },
    sovaIcon: { ...ok, icon: "undo" },
    imitatesCopy: { ...ok, label: "Copy" },
    imitatesRegenerate: { ...ok, label: "regenerate" },
    imitatesFork: { ...ok, label: "Fork from here" },
    badConfirm: { ...ok, confirm: "<b>sure?</b>" },
    notObject: "Pinned",
  };
  for (const [name, raw] of Object.entries(bad)) assert.equal(validChip(raw, ext), null, name);
});

test("content: bounded height and size, malformed dropped", () => {
  assert.deepEqual(validContent({ html: "<p>hi</p>", height: 9999 }, ext), { extension: "notes", extensionTitle: "Notes", html: "<p>hi</p>", height: CONTENT_HEIGHT_MAX });
  assert.equal(validContent({ html: "<p>hi</p>", height: 1 }, ext)?.height, 32);
  assert.equal(validContent({ html: "x".repeat(CONTENT_MAX_BYTES + 1), height: 100 }, ext), null);
  assert.equal(validContent({ html: "", height: 100 }, ext), null);
  assert.equal(validContent({ html: "<p>", height: "100" }, ext), null);
});

test("an answer: good parts kept, at most 3 chips from one extension, any dropped part makes it bad", () => {
  const v = validateAnswer({ chips: [ok, ok, ok, ok], content: { html: "<p>x</p>", height: 50 } }, ext);
  assert.equal(v.chips.length, 3);
  assert.equal(v.bad, true);
  assert.equal(validateAnswer({ chips: [ok] }, ext).bad, false);
  assert.deepEqual(validateAnswer(null, ext), { chips: [], content: null, bad: true });
  assert.deepEqual(validateAnswer({ chips: "x" }, ext).bad, true);
});

test("the wall: no scripts, no same-origin, no pointer or focus, the CSP twice", () => {
  // sandbox="" : every restriction on, scripts included (a scripted frame can navigate itself away).
  assert.equal(WALLED_FRAME_ATTRS.sandbox, "");
  assert.equal(WALLED_FRAME_ATTRS.referrerpolicy, "no-referrer");
  assert.equal(WALLED_FRAME_ATTRS.tabindex, -1);
  assert.equal(WALLED_FRAME_ATTRS.style["pointer-events"], "none");
  assert.equal(WALLED_FRAME_ATTRS.csp, WALLED_CSP);
  // No network and no script, whichever way the CSP is read.
  assert.ok(WALLED_CSP.startsWith("default-src 'none';"));
  assert.doesNotMatch(WALLED_CSP, /script-src|connect-src|frame-src|https?:|\*/);
  const doc = walledSrcdoc("<script>location.href='https://x.example/?seen=1'</script><a href='https://x.example'>x</a>");
  // The CSP comes before the extension's markup, so it stands before any of it is parsed.
  const csp = doc.indexOf(`content="${WALLED_CSP}"`);
  assert.ok(csp > 0 && csp < doc.indexOf("<script>"));
  assert.ok(doc.indexOf('content="off"') < doc.indexOf("<script>"), "dns prefetch off before the markup");
});

test("a frame that loads a second time is a breach: blanked once, its extension muted at once", () => {
  const policy = createSlotPolicy(memory());
  let blanked = 0;
  const onLoad = frameLoadGuard("notes", policy, () => blanked++);
  onLoad(); // its own document
  assert.equal(blanked, 0);
  assert.equal(policy.isMuted("notes"), false);
  onLoad(); // it navigated
  assert.equal(blanked, 1);
  assert.equal(policy.isMuted("notes"), true);
  onLoad(); // anything after changes nothing more
  assert.equal(blanked, 1);
  // A good answer arriving later never lifts a breach's mute.
  policy.note("notes", true);
  assert.equal(policy.isMuted("notes"), true);
  // Another extension is untouched.
  assert.equal(policy.isMuted("other"), false);
});

// ---- asking, with mocked time ---------------------------------------------------------------------

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const flush = () => new Promise((r) => setImmediate(r));
const src = (id: string, ask: SlotSource["ask"]): SlotSource => ({ ext: { id, title: id.toUpperCase(), actions: ["pin"] }, ask });

test("the reply never waits: nothing is drawn at start, a late answer is dropped, the others draw", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const policy = createSlotPolicy(memory());
  const states: SlotState[] = [];
  let lateResolve!: (v: unknown) => void;
  const stop = startReplySlot(
    [src("late", () => new Promise((r) => (lateResolve = r))), src("fast", async () => ({ chips: [ok] }))],
    policy,
    (s) => states.push(s),
    2000,
  );
  assert.equal(states.length, 0, "nothing drawn synchronously");
  await flush();
  assert.deepEqual(states.at(-1)!.chips.map((c) => c.extension), ["fast"]);
  t.mock.timers.tick(2000);
  await flush();
  lateResolve({ chips: [ok] });
  await flush();
  assert.deepEqual(states.at(-1)!.chips.map((c) => c.extension), ["fast"], "the late answer never draws");
  stop();
});

test("a throwing or malformed contribution draws nothing; the rest still draw", async () => {
  const policy = createSlotPolicy(memory());
  const states: SlotState[] = [];
  startReplySlot(
    [
      src("throws", () => {
        throw new Error("boom");
      }),
      src("rejects", async () => {
        throw new Error("boom");
      }),
      src("junk", async () => "not an answer"),
      src("good", async () => ({ chips: [ok], content: { html: "<p>x</p>", height: 40 } })),
    ],
    policy,
    (s) => states.push(s),
  );
  await flush();
  const last = states.at(-1)!;
  assert.deepEqual(last.chips.map((c) => c.extension), ["good"]);
  assert.deepEqual(last.contents.map((c) => c.extension), ["good"]);
});

test("at most 6 chips under one reply, in extension order", async () => {
  const states: SlotState[] = [];
  startReplySlot(["a", "b", "c"].map((id) => src(id, async () => ({ chips: [ok, ok, ok] }))), createSlotPolicy(memory()), (s) => states.push(s));
  await flush();
  assert.equal(states.at(-1)!.chips.length, CHIPS_PER_REPLY);
  assert.deepEqual([...new Set(states.at(-1)!.chips.map((c) => c.extension))], ["a", "b"]);
});

test("auto-mute: 3 bad answers in a row and it is not asked again; a good one resets the count", async () => {
  const policy = createSlotPolicy(memory());
  let asked = 0;
  const bad = src("bad", async () => {
    asked++;
    return null;
  });
  policy.note("bad", false);
  policy.note("bad", true); // a good answer between resets it
  for (let i = 0; i < MUTE_AFTER + 2; i++) {
    startReplySlot([bad], policy, () => {});
    await flush();
  }
  assert.equal(asked, MUTE_AFTER);
  assert.equal(policy.isMuted("bad"), true);
});

test("the off switch hides an extension's additions, and is kept in storage", async () => {
  const storage = memory();
  createSlotPolicy(storage).setOff("notes", true);
  const policy = createSlotPolicy(storage); // a new page reads it back
  assert.equal(policy.isOff("notes"), true);
  let asked = false;
  const states: SlotState[] = [];
  startReplySlot([src("notes", async () => ((asked = true), { chips: [ok] }))], policy, (s) => states.push(s));
  await flush();
  assert.equal(asked, false);
  assert.equal(states.length, 0);
  policy.setOff("notes", false);
  assert.equal(policy.isOff("notes"), false);
  // A damaged stored value is no switch, not a crash.
  storage.setItem("sova.reply-slot.off", "{not json");
  assert.equal(createSlotPolicy(storage).isOff("notes"), false);
});
