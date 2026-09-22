// Run: npx tsx --test src/lib/message-reveal.test.ts (or npm test)
//
// Tap-to-reveal for the message-action strips: which host a tap lights up, which presses are
// taps at all (a scroll is not), and that exactly one strip is ever revealed. The painting is
// base.css's and the browser check's; this is the decision underneath it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireMessageReveal, installMessageReveal, isRevealTap, revealHostFor, setRevealed, TAP_SLOP_PX } from "./message-reveal";

/** A fake element tree: enough `closest`/`querySelector*` for the module, nothing more. */
class El {
  readonly children: El[] = [];
  readonly attrs = new Map<string, string>();
  parent: El | null = null;
  constructor(readonly classes: string[] = []) {}
  add(child: El): El {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  closest(selector: string): El | null {
    const wanted = selector.split(",").map((s) => s.trim().replace(/^\./, ""));
    for (let el: El | null = this; el; el = el.parent) if (el.classes.some((c) => wanted.includes(c))) return el;
    return null;
  }
  private descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelector(selector: string): El | null {
    const cls = selector.replace(/^\./, "");
    return this.descendants().find((d) => d.classes.includes(cls)) ?? null;
  }
  querySelectorAll(selector: string): El[] {
    const attr = selector.replace(/^\[|\]$/g, "");
    return this.descendants().filter((d) => d.attrs.has(attr));
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
}

const REVEALED = "data-actions-revealed";

/** Root → two entries with strips, one entry without (a tool card), one queued host with one. */
function tree() {
  const root = new El(["thread"]);
  const withStrip = (host: El) => {
    const bubble = host.add(new El(["message"]));
    const strip = host.add(new El(["message-actions"]));
    return { host, bubble, strip, button: strip.add(new El(["message-action"])) };
  };
  const first = withStrip(root.add(new El(["entry"])));
  const second = withStrip(root.add(new El(["entry"])));
  const toolRow = root.add(new El(["entry"]));
  const toolCard = toolRow.add(new El(["tool-card"]));
  const queued = withStrip(root.add(new El(["message-actions-host"])));
  const outside = root.add(new El(["composer"]));
  return { root, first, second, toolRow, toolCard, queued, outside };
}

const asRoot = (el: El) => el as unknown as ParentNode;
const asEl = (el: El) => el as unknown as Element;

test("a tap reveals the host of the message it landed on, from anywhere inside the row", () => {
  const t = tree();
  assert.equal(revealHostFor(asEl(t.first.button)), asEl(t.first.host));
  assert.equal(revealHostFor(asEl(t.first.bubble)), asEl(t.first.host));
  // A queued message is not an `.entry`; it carries its own host so Remove is reachable too.
  assert.equal(revealHostFor(asEl(t.queued.strip)), asEl(t.queued.host));
});

test("a row with no strip reveals nothing, so a tap on a tool card puts the transcript back to quiet", () => {
  const t = tree();
  assert.equal(revealHostFor(asEl(t.toolCard)), null);
  assert.equal(revealHostFor(asEl(t.outside)), null);
  assert.equal(revealHostFor(null), null);
});

test("only one strip is revealed at a time, and the previous one is put back", () => {
  const t = tree();
  setRevealed(asRoot(t.root), asEl(t.first.host));
  assert.ok(t.first.host.attrs.has(REVEALED));
  setRevealed(asRoot(t.root), asEl(t.second.host));
  assert.equal(t.first.host.attrs.has(REVEALED), false);
  assert.ok(t.second.host.attrs.has(REVEALED));
  setRevealed(asRoot(t.root), null);
  assert.equal(t.second.host.attrs.has(REVEALED), false);
});

test("a mouse never reveals by tapping — hover is its door, and a moved finger was a scroll", () => {
  const touch = { pointerType: "touch", x: 100, y: 200 };
  assert.equal(isRevealTap(touch, { pointerType: "touch", x: 100, y: 200 }), true);
  assert.equal(isRevealTap(touch, { pointerType: "touch", x: 100 + TAP_SLOP_PX, y: 200 }), true);
  assert.equal(isRevealTap(touch, { pointerType: "touch", x: 100, y: 200 + TAP_SLOP_PX + 1 }), false, "a scroll");
  assert.equal(isRevealTap(touch, { pointerType: "touch", x: 100, y: 200 - 60 }), false);
  assert.equal(isRevealTap({ pointerType: "mouse", x: 5, y: 5 }, { pointerType: "mouse", x: 5, y: 5 }), false);
  assert.equal(isRevealTap({ pointerType: "pen", x: 5, y: 5 }, { pointerType: "pen", x: 5, y: 5 }), true);
});

/** A fake document: listeners in, synthetic pointer events out, over the fake tree above. */
function fakeDoc(root: El) {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const doc = {
    addEventListener: (type: string, fn: (e: unknown) => void, opts?: AddEventListenerOptions) => {
      assert.deepEqual(opts, { capture: true, passive: true }, "the reveal reads the gesture, never intercepts it");
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn),
    querySelectorAll: (s: string) => root.querySelectorAll(s),
  };
  const fire = (type: string, e: Record<string, unknown>) => listeners.get(type)?.forEach((fn) => fn(e));
  /** A real tap: the press, the release, and the click the browser synthesises after them. */
  const tap = (target: El, at = { x: 10, y: 10 }, pointerType = "touch") => {
    fire("pointerdown", { pointerType, clientX: at.x, clientY: at.y, target });
    fire("pointerup", { pointerType, clientX: at.x, clientY: at.y, target });
    fire("click", { target });
  };
  return { doc: doc as unknown as Document, fire, tap, count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0) };
}

test("tapping a message reveals its strip and keeps it until a tap lands somewhere else", () => {
  const t = tree();
  const f = fakeDoc(t.root);
  const stop = installMessageReveal(f.doc);

  f.tap(t.first.bubble);
  assert.ok(t.first.host.attrs.has(REVEALED), "the tapped message");

  // A second tap on the SAME message (the one that presses the now-visible button) keeps it.
  f.tap(t.first.button);
  assert.ok(t.first.host.attrs.has(REVEALED));

  f.tap(t.queued.strip);
  assert.equal(t.first.host.attrs.has(REVEALED), false, "another message takes the reveal");
  assert.ok(t.queued.host.attrs.has(REVEALED));

  f.tap(t.outside);
  assert.equal(t.queued.host.attrs.has(REVEALED), false, "a tap outside every message clears it");
  stop();
  assert.equal(f.count(), 0, "and the listeners leave with it");
});

test("the reveal waits for the click, so the tap that reveals a strip can never press it", () => {
  const t = tree();
  const f = fakeDoc(t.root);
  const stop = installMessageReveal(f.doc);
  // Touch's compatibility mouse events (and the click) are synthesised AFTER the press ends, so a
  // strip made interactive at pointerup is hit by the very tap that revealed it.
  f.fire("pointerdown", { pointerType: "touch", clientX: 10, clientY: 10, target: t.first.button });
  f.fire("pointerup", { pointerType: "touch", clientX: 10, clientY: 10, target: t.first.button });
  assert.equal(t.first.host.attrs.has(REVEALED), false, "still hidden while the click is being dispatched");
  f.fire("click", { target: t.first.button });
  assert.ok(t.first.host.attrs.has(REVEALED), "and revealed once that click is spent");
  stop();
});

test("scrolling the thread under a thumb reveals nothing", () => {
  const t = tree();
  const f = fakeDoc(t.root);
  const stop = installMessageReveal(f.doc);

  f.fire("pointerdown", { pointerType: "touch", clientX: 10, clientY: 400, target: t.first.bubble });
  f.fire("pointerup", { pointerType: "touch", clientX: 12, clientY: 120, target: t.first.bubble });
  assert.equal(t.first.host.attrs.has(REVEALED), false, "the finger travelled: that was a scroll");

  // A gesture the browser took over (scroll, long-press menu) leaves no half-press behind.
  f.fire("pointerdown", { pointerType: "touch", clientX: 10, clientY: 400, target: t.first.bubble });
  f.fire("pointercancel", {});
  f.fire("pointerup", { pointerType: "touch", clientX: 10, clientY: 400, target: t.first.bubble });
  assert.equal(t.first.host.attrs.has(REVEALED), false);

  // A mouse click is not a tap: hover already answers for it.
  f.tap(t.first.bubble, { x: 10, y: 10 }, "mouse");
  assert.equal(t.first.host.attrs.has(REVEALED), false);
  stop();
});

test("however many strips are on screen, they share one installation and the last one takes it away", () => {
  const t = tree();
  const f = fakeDoc(t.root);
  const a = acquireMessageReveal(f.doc);
  const perStrip = f.count();
  const b = acquireMessageReveal(f.doc);
  assert.equal(f.count(), perStrip, "a second strip adds no listeners");
  a();
  a(); // a double release must not take the other strip's listeners with it
  assert.equal(f.count(), perStrip);
  b();
  assert.equal(f.count(), 0);
});
