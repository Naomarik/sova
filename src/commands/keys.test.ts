import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { bindKey, firingRows, KEYS, keyFires, keyRow, type KeyId, type KeyLike } from "./keys";

const field = { tagName: "TEXTAREA" };
const input = { tagName: "INPUT", type: "text" };
const checkbox = { tagName: "INPUT", type: "checkbox" };
const editable = { tagName: "DIV", isContentEditable: true };
const button = { tagName: "BUTTON" };

const ev = (over: Partial<KeyLike>): KeyLike => ({ key: "", code: "", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: button, ...over });
const fires = (id: KeyId, e: KeyLike) => keyFires(keyRow(id), e);

/** Each key's chord, as the browser reports it on a US layout. */
const CHORD: Record<KeyId, KeyLike[]> = {
  "overseer.open": [ev({ key: "o", code: "KeyO", altKey: true }), ev({ key: "ø", code: "KeyO", altKey: true })], // macOS Option+O types ø
  "model.picker": [ev({ key: "p", code: "KeyP", ctrlKey: true }), ev({ key: "p", code: "KeyP", metaKey: true }), ev({ key: "P", code: "KeyP", ctrlKey: true })],
  "sidebar.toggle": [ev({ key: "b", code: "KeyB", ctrlKey: true }), ev({ key: "b", code: "KeyB", metaKey: true }), ev({ key: "B", code: "KeyB", metaKey: true })],
  "sidebar.search": [ev({ key: "/", code: "Slash" }), ev({ key: "/", code: "Digit7", shiftKey: true })], // shift+7 on a German layout
  "palette.open": [ev({ key: "k", code: "KeyK", ctrlKey: true }), ev({ key: "k", code: "KeyK", metaKey: true }), ev({ key: "K", code: "KeyK", ctrlKey: true })],
  "shortcuts.open": [ev({ key: "?", code: "Slash", shiftKey: true }), ev({ key: "?", code: "Minus", shiftKey: true })], // shift+ß on a German layout
};

/** What each key did before the table, written out here rather than read from it. */
const TODAY: Record<KeyId, { inField: boolean }> = {
  "overseer.open": { inField: true },
  "model.picker": { inField: true },
  "sidebar.toggle": { inField: true },
  "sidebar.search": { inField: false },
  "palette.open": { inField: true }, // fires in text entry (the composer opens the palette, as Ctrl/⌘+P opens the picker there); composing: fires (a composing keydown is "Process"); modal: fires
  "shortcuts.open": { inField: false }, // ignored in text entry ("?" types in a field); composing: fires (a composing keydown is "Process"); modal: fires
};

for (const row of KEYS) {
  test(`${row.id}: fires on its chord`, () => {
    for (const e of CHORD[row.id]) assert.equal(fires(row.id, e), true, JSON.stringify(e));
  });

  test(`${row.id}: text entry ${TODAY[row.id].inField ? "still fires it" : "ignores it"}, as before the table`, () => {
    for (const target of [field, input, editable])
      for (const e of CHORD[row.id]) assert.equal(fires(row.id, { ...e, target }), TODAY[row.id].inField);
    // A control that takes no text is no text entry.
    for (const e of CHORD[row.id]) assert.equal(fires(row.id, { ...e, target: checkbox }), true);
  });

  test(`${row.id}: IME composing changes nothing it did before (a composing keydown is "Process")`, () => {
    for (const e of CHORD[row.id]) assert.equal(fires(row.id, { ...e, isComposing: true }), true); // no key checked isComposing before
    assert.equal(fires(row.id, { ...CHORD[row.id][0]!, key: "Process", isComposing: true }), row.id === "overseer.open"); // Alt+O reads the code, as before
  });

  test(`${row.id}: an extra modifier stops it`, () => {
    for (const e of CHORD[row.id])
      for (const mod of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
        if (e[mod]) continue;
        if (row.id === "sidebar.search" && mod === "shiftKey") continue; // "/" allows Shift, as before
        if (row.id !== "overseer.open" && row.id !== "sidebar.search" && (mod === "ctrlKey" || mod === "metaKey")) continue; // Ctrl and ⌘ together, as before
        assert.equal(fires(row.id, { ...e, [mod]: true }), false, `${mod} ${JSON.stringify(e)}`);
      }
  });
}

test("keys stay where they were: Alt+O on the window, the rest on the document", () => {
  assert.deepEqual(
    KEYS.map((r) => [r.id, r.target]),
    [["overseer.open", "window"], ["model.picker", "document"], ["sidebar.toggle", "document"], ["sidebar.search", "document"], ["palette.open", "document"], ["shortcuts.open", "document"]],
  );
});

test("conflict: no keydown fires two rows, in any target", () => {
  const keys = [..."abcdefghijklmnopqrstuvwxyz0123456789/?.,;'[]-=`\\", "Process", "Escape", "Enter", "ø"];
  const targets = [button, field, checkbox, editable, null];
  let seen = 0;
  for (const key of keys)
    for (let m = 0; m < 16; m++)
      for (const target of targets)
        for (const upper of [false, true]) {
          const k = upper ? key.toUpperCase() : key;
          const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === "ø" ? "KeyO" : key === "/" ? "Slash" : "Other";
          const e = ev({ key: k, code, altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8), target });
          const all = [...firingRows("window", e), ...firingRows("document", e)];
          assert.ok(all.length <= 1, `${JSON.stringify(e)} fires ${all.map((r) => r.id).join(" and ")}`);
          seen += all.length;
        }
  assert.ok(seen > 0); // the sweep reached the chords at all
});

// ---- dispatch, on stand-in window and document ----

const g = globalThis as unknown as { window?: EventTarget; document?: EventTarget };
const was = { window: g.window, document: g.document };
const unbinds: (() => void)[] = [];
afterEach(() => {
  while (unbinds.length) unbinds.pop()!();
  g.window = was.window;
  g.document = was.document;
});

class Counting extends EventTarget {
  n = 0;
  override addEventListener(...a: Parameters<EventTarget["addEventListener"]>) {
    this.n++;
    super.addEventListener(...a);
  }
  override removeEventListener(...a: Parameters<EventTarget["removeEventListener"]>) {
    this.n--;
    super.removeEventListener(...a);
  }
}
const stage = () => {
  const w = new Counting();
  const d = new Counting();
  g.window = w;
  g.document = d;
  return { w, d };
};
const keydown = (over: Partial<KeyLike>) => {
  const e = new Event("keydown", { cancelable: true }) as Event & KeyLike;
  const { target: _t, ...props } = ev(over); // dispatch sets the target
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
};

test("dispatch: an owner that acts prevents the default; one that declines leaves it", () => {
  const { d } = stage();
  let ran = 0;
  let ok = false;
  unbinds.push(bindKey("model.picker", () => (ran++, ok)));
  const declined = keydown(CHORD["model.picker"][0]!);
  d.dispatchEvent(declined);
  assert.equal(ran, 1);
  assert.equal(declined.defaultPrevented, false);
  ok = true;
  const acted = keydown(CHORD["model.picker"][0]!);
  d.dispatchEvent(acted);
  assert.equal(acted.defaultPrevented, true);
});

test("dispatch: a key on the wrong target, or not its chord, runs nothing", () => {
  const { w, d } = stage();
  let ran = 0;
  unbinds.push(bindKey("overseer.open", () => (ran++, true)));
  d.dispatchEvent(keydown(CHORD["overseer.open"][0]!)); // the stand-in document doesn't bubble to the window
  w.dispatchEvent(keydown({ key: "o", code: "KeyO" }));
  assert.equal(ran, 0);
  w.dispatchEvent(keydown(CHORD["overseer.open"][0]!));
  assert.equal(ran, 1);
});

test("dispatch: every owner of a key runs (two composers), and the listeners come and go with the binds", () => {
  const { w, d } = stage();
  const order: string[] = [];
  const a = bindKey("model.picker", () => (order.push("a"), true));
  unbinds.push(a);
  const b = bindKey("model.picker", () => (order.push("b"), false));
  unbinds.push(b);
  const s = bindKey("sidebar.search", () => true);
  unbinds.push(s);
  assert.equal(d.n, 1); // one document listener for all its keys
  assert.equal(w.n, 0);
  d.dispatchEvent(keydown(CHORD["model.picker"][0]!));
  assert.deepEqual(order, ["a", "b"]);
  a();
  a(); // idempotent
  d.dispatchEvent(keydown(CHORD["model.picker"][0]!));
  assert.deepEqual(order, ["a", "b", "b"]);
  b();
  assert.equal(d.n, 1);
  const same = () => (order.push("same"), true);
  const one = bindKey("model.picker", same);
  unbinds.push(one);
  bindKey("model.picker", same)();
  d.dispatchEvent(keydown(CHORD["model.picker"][0]!));
  assert.deepEqual(order.slice(-1), ["same"]); // one function bound twice unbinds singly
  one();
  s();
  assert.equal(d.n, 0);
});
