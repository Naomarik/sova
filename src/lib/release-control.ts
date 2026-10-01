// Letting go of a text control as its view closes.
//
// The browser keeps a hold tied to the last text field that had focus, and that hold kept the
// field's whole closed view alive: one chat's transcript, thousands of nodes, after every session
// switch. Measured in Chromium (scripts/perf-load, the switch check): a blur, cutting the field out
// of its view, or focusing a link all leave the view alive; only a later focus in ANOTHER text
// field lets it go. So a closing view hands that role to a sink: one hidden text input outside
// every view, focused and blurred at once, and focus goes back to wherever it was.

/** The slice of an element this needs, so a test can hand in plain objects. */
export interface Focusable {
  focus(options?: { preventScroll?: boolean }): void;
  blur(): void;
  readonly isConnected: boolean;
}

/** The slice of a document this needs. */
export interface SinkDocument {
  readonly activeElement: unknown;
  readonly body: { append(node: never): void } | null;
  createElement(tag: "input"): Focusable & { setAttribute(name: string, value: string): void; className: string };
}

const sinks = new WeakMap<object, Focusable>();

/** The document's sink, made on first use: a text input no one sees, reads or tabs to, and one that
    never raises a phone's keyboard (`inputmode="none"`). */
function sinkOf(doc: SinkDocument): Focusable | null {
  const known = sinks.get(doc);
  if (known?.isConnected) return known;
  if (!doc.body) return null;
  const el = doc.createElement("input");
  el.setAttribute("type", "text");
  el.setAttribute("inputmode", "none");
  el.setAttribute("tabindex", "-1");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("autocomplete", "off");
  el.className = "visually-hidden";
  doc.body.append(el as never);
  sinks.set(doc, el);
  return el;
}

/**
 * Release the browser's hold on `field` as its view closes: focus and blur the sink, then put focus
 * back where it was, unless that was `field` itself (it is going away) or nothing. Call it only
 * for a field that has had focus: one that never did holds nothing.
 */
export function releaseControl(field: Focusable, doc: SinkDocument): void {
  const sink = sinkOf(doc);
  if (!sink) return;
  const was = doc.activeElement as Focusable | null;
  sink.focus({ preventScroll: true });
  sink.blur();
  if (was && was !== field && was !== sink && was !== (doc.body as unknown) && was.isConnected) was.focus({ preventScroll: true });
}
