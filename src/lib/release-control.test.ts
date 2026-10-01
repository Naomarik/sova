import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseControl, type SinkDocument } from "./release-control";

/** A document that logs every focus and blur, in order, by element name. */
function world() {
  const log: string[] = [];
  const doc = {
    activeElement: null as unknown,
    body: { name: "body", isConnected: true, focus() {}, blur() {}, appended: [] as unknown[], append(n: unknown) { this.appended.push(n); } },
    createElement() {
      return el("sink");
    },
  };
  function el(name: string) {
    const e = {
      name,
      isConnected: true,
      className: "",
      attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) {
        e.attrs[k] = v;
      },
      focus() {
        log.push(`focus ${name}`);
        doc.activeElement = e;
      },
      blur() {
        log.push(`blur ${name}`);
        if (doc.activeElement === e) doc.activeElement = doc.body;
      },
    };
    return e;
  }
  return { log, doc, el, sinkDoc: doc as unknown as SinkDocument };
}

test("a closing field that has focus: the sink takes it and lets go, and focus is not handed back to the field", () => {
  const w = world();
  const field = w.el("composer");
  field.focus();
  w.log.length = 0;
  releaseControl(field, w.sinkDoc);
  assert.deepEqual(w.log, ["focus sink", "blur sink"]);
  assert.equal(w.doc.activeElement, w.doc.body);
});

test("focus that was elsewhere (another pane's composer, a row) goes back there", () => {
  const w = world();
  const field = w.el("composer");
  const other = w.el("other");
  other.focus();
  w.log.length = 0;
  releaseControl(field, w.sinkDoc);
  assert.deepEqual(w.log, ["focus sink", "blur sink", "focus other"]);
  assert.equal(w.doc.activeElement, other);
});

test("focus on something already gone is not handed back", () => {
  const w = world();
  const gone = w.el("gone");
  gone.focus();
  gone.isConnected = false;
  w.log.length = 0;
  releaseControl(w.el("composer"), w.sinkDoc);
  assert.deepEqual(w.log, ["focus sink", "blur sink"]);
});

test("one sink per document, never seen, read, tabbed to, and no phone keyboard", () => {
  const w = world();
  releaseControl(w.el("a"), w.sinkDoc);
  releaseControl(w.el("b"), w.sinkDoc);
  assert.equal(w.doc.body.appended.length, 1);
  const sink = w.doc.body.appended[0] as { attrs: Record<string, string>; className: string };
  assert.deepEqual(sink.attrs, { type: "text", inputmode: "none", tabindex: "-1", "aria-hidden": "true", autocomplete: "off" });
  assert.equal(sink.className, "visually-hidden");
});
