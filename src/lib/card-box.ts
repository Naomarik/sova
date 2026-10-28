/**
 * The sealed box a card view runs in (§chat.transcript-cards/sealed-box): DOM-free builders for its
 * two documents and the page's check of what comes out of it, so the page and the tests use the same.
 *
 * Why two frames. A frame with scripts can navigate itself (`location.href = 'http://…/?data'`,
 * `location.replace`, a meta refresh, a clicked link): the request leaves with whatever it carries
 * in its URL before any event the page could act on, and its own CSP goes with the document it
 * replaces (src/lib/reply-slot.ts, the reason the reply slot's frame has no scripts at all). No CSP
 * directive of a document limits that document's own navigation. What does is its PARENT's
 * `frame-src`: a navigation of a nested frame is checked against the policy of the document that
 * embeds it, before the request is made. So:
 *
 * - The **shell** is the frame in the card's place: Sova's own small document, no view code in it.
 *   Its policy (`frame-src 'none'`, as a meta tag first in the document and as the iframe's `csp`
 *   attribute) refuses every navigation of the frame it holds, to any URL; a srcdoc document is no
 *   request, so the view's own document still loads.
 * - The **view** frame inside it runs the view's code. Its policy refuses every request (fetch,
 *   sockets, beacons, images, fonts, scripts, styles, frames, workers from anywhere); its sandbox
 *   (`allow-scripts` only) refuses forms, popups, downloads, top navigation and navigating the shell.
 *
 * Both frames are sandboxed without `allow-same-origin`: each has an opaque origin of its own that
 * is never Sova's, so no Sova cookies, storage, token or key, and no reach into the page or each
 * other. Messages are the only way out: the view posts to the shell, the shell relays only what
 * its own view frame sent, and the page takes only what its card's shell sent
 * (`fromCardBox`), naming the card itself, so a view can never speak for another card.
 *
 * WebRTC is the one way out no content policy closes (Chromium knows no `webrtc` directive): an
 * `RTCPeerConnection` with an ICE server sends STUN over UDP wherever it is told. So the view's
 * document takes every `RTC…` interface off its global before any view code runs, and nothing
 * else gets a global of its own to run in: the view document's own policy (`cardViewDocCsp`) runs
 * scripts by a nonce only, which the boot script hides before it runs the view's code by `eval`.
 * A frame the view makes inherits that policy, so no script of its own, inline handler or
 * `javascript:` URL ever runs in it, and it is cross-origin to the view (sandboxed, each its own
 * opaque origin), so the view can't reach its fresh `RTCPeerConnection` either.
 *
 * The `csp` attribute (CSP Embedded Enforcement) is Chromium's; a browser without it never runs a
 * view (`cardBoxSupported`), as the claim says.
 */

const CSP_REST =
  "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The frames' required policy (their `csp` attribute): nothing over the network; inline script
 * and style, and eval (the view's code runs by it); media from data: and blob: only.
 */
export const CARD_VIEW_CSP = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; ${CSP_REST}`;

/**
 * The shell's policy: the same (a nested frame's required policy must fit within its parent's),
 * so every navigation of the view frame it holds is refused (`frame-src 'none'`).
 */
export const CARD_SHELL_CSP = CARD_VIEW_CSP;

/** The view document's own policy, stricter: scripts by its nonce only (the boot), then eval. */
export const cardViewDocCsp = (nonce: string) => `default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; ${CSP_REST}`;

/** Where the shell puts each view document's fresh nonce. */
export const CARD_NONCE_SLOT = "__SOVA_CARD_NONCE__";

/** The message tag every box message carries. */
export const CARD_BOX_MESSAGE = "sova-card-box";

/** The shell frame's attributes, in the card's place. */
export const CARD_SHELL_ATTRS = {
  sandbox: "allow-scripts",
  csp: CARD_SHELL_CSP,
  referrerpolicy: "no-referrer",
} as const;

/** The view frame's attributes, inside the shell (set by the shell's own script). */
export const CARD_VIEW_ATTRS = {
  sandbox: "allow-scripts",
  csp: CARD_VIEW_CSP,
  referrerpolicy: "no-referrer",
} as const;

/** Whether this browser can hold the wall: it must enforce the frame's `csp` attribute (Chromium). */
export const cardBoxSupported = (iframeProto: object | undefined): boolean => !!iframeProto && "csp" in iframeProto;

export const CARD_BOX_UNSUPPORTED = "This browser can't wall off card views, so this one isn't run.";

/** A view that tried to navigate away (refused) is stopped, with this as its error. */
export const CARD_BOX_LEFT = "This view tried to leave its box, so it was stopped.";

const head = (csp: string) =>
  `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">`;

/**
 * The view frame's document, before its code: the policy first, then the theme's style element,
 * the base styles and a boot script. The boot script takes the view's code from the shell (one
 * `run` message, from its parent only) and runs it as an inline script element, reports the
 * document's height and any uncaught error, applies theme updates, and hands every other message
 * from the shell to the toolkit (`globalThis.__sovaCardBox`).
 */
export function cardViewDoc(baseCss: string): string {
  const boot = `(() => {
  // Before anything else: no WebRTC (see the top of card-box.ts), and no trace of the nonce.
  for (const n of Object.getOwnPropertyNames(globalThis)) if (/^(webkit)?RTC/.test(n)) delete globalThis[n];
  document.currentScript.remove();
  for (const m of document.querySelectorAll("meta[http-equiv]")) m.remove();
  const T = ${JSON.stringify(CARD_BOX_MESSAGE)};
  const up = (m) => parent.postMessage(Object.assign({ [T]: 1 }, m), "*");
  const listeners = new Set();
  let ran = false;
  globalThis.__sovaCardBox = { post: (m) => up({ op: "api", msg: m }), on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); } };
  const fail = (message) => up({ op: "error", message: String(message).slice(0, 2000) });
  addEventListener("error", (e) => fail(e.error && e.error.stack ? e.error.message + "\\n" + e.error.stack : e.message));
  addEventListener("unhandledrejection", (e) => fail(e.reason && e.reason.message ? e.reason.message : e.reason));
  let last = -1;
  const measure = () => { const h = Math.ceil(document.documentElement.getBoundingClientRect().height); if (h !== last) { last = h; up({ op: "height", height: h }); } };
  new ResizeObserver(measure).observe(document.documentElement);
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m[T] !== 1) return;
    if (m.op === "theme") { document.getElementById("sova-theme").textContent = String(m.css || ""); return; }
    if (m.op === "run") {
      if (ran) return;
      ran = true;
      document.getElementById("sova-theme").textContent = String(m.css || "");
      globalThis.__sovaCardBox.init = m.init;
      try { (0, eval)(String(m.code || "") + "\\n//# sourceURL=card-view.js"); } catch (err) { fail(err && err.stack ? err.message + "\\n" + err.stack : err); }
      measure();
      return;
    }
    if (m.op === "api") for (const fn of listeners) { try { fn(m.msg); } catch (err) { fail(err && err.message ? err.message : err); } }
  });
  up({ op: "ready" });
})();`;
  return `<!doctype html><html><head>${head(cardViewDocCsp(CARD_NONCE_SLOT))}<style id="sova-theme"></style><style>${baseCss.replace(/<\//g, "<\\/")}</style></head><body><div id="root"></div><script nonce="${CARD_NONCE_SLOT}">${boot}</script></body></html>`;
}

/**
 * The shell's document: the policy first and one script. It makes the view frame when the page
 * asks (`load`, again on every redraw: a fresh document, the old one dropped), passes the view's
 * code to it once that frame says it is ready, relays the page's later messages to it, and relays
 * to the page only what that frame itself posts. It never runs the view's code.
 */
export function cardShellDoc(viewDoc: string): string {
  const shell = `(() => {
  const T = ${JSON.stringify(CARD_BOX_MESSAGE)};
  const DOC = ${JSON.stringify(viewDoc)};
  const ATTRS = ${JSON.stringify(CARD_VIEW_ATTRS)};
  let view = null;
  let pending = null;
  const up = (m) => parent.postMessage(m, "*");
  const make = () => {
    if (view) view.remove();
    const f = (view = document.createElement("iframe"));
    for (const [k, v] of Object.entries(ATTRS)) f.setAttribute(k, v);
    f.setAttribute("title", "Card view");
    f.style.cssText = "border:0;display:block;width:100%;height:100%";
    // Its first load is its own document; any later one is the view navigating (refused, so an
    // error page): stop it and say so.
    let loads = 0;
    f.addEventListener("load", () => {
      if (++loads < 2 || view !== f) return;
      f.remove();
      view = null;
      up({ [T]: 1, op: "error", message: ${JSON.stringify(CARD_BOX_LEFT)} });
    });
    f.srcdoc = DOC.split(${JSON.stringify(CARD_NONCE_SLOT)}).join(Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join(""));
    document.body.append(f);
  };
  addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object" || m[T] !== 1) return;
    if (e.source === parent) {
      // Focus moved into the box: whether the user's own press inside it brought it there (a press
      // in the view activates every frame above it, this one included; the page's keys don't).
      if (m.op === "focus?") { up({ [T]: 1, op: "focus", user: !!(navigator.userActivation && navigator.userActivation.isActive) }); return; }
      if (m.op === "load") { pending = Object.assign({}, m, { op: "run" }); make(); return; }
      if (view && view.contentWindow) view.contentWindow.postMessage(m, "*");
      return;
    }
    if (!view || e.source !== view.contentWindow) return;
    if (m.op === "ready") { if (pending) view.contentWindow.postMessage(pending, "*"); pending = null; return; }
    up(m);
  });
  up({ [T]: 1, op: "shell-ready" });
})();`.replace(/<\//g, "<\\/");
  return `<!doctype html><html><head>${head(CARD_SHELL_CSP)}<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:transparent}</style></head><body><script>${shell}</script></body></html>`;
}

/** What a card's box may send the page. */
export type CardBoxMessage =
  | { op: "shell-ready" }
  | { op: "height"; height: number }
  | { op: "error"; message: string }
  | { op: "focus"; user: boolean }
  | { op: "api"; msg: unknown };

/**
 * A message event as the page takes it: only from this card's own shell, and only one of the
 * box's messages; anything else (another frame, another card's box, the view posting to the page
 * directly) is null.
 */
export function fromCardBox(e: { source: unknown; data: unknown }, shell: unknown): CardBoxMessage | null {
  if (!shell || e.source !== shell) return null;
  const m = e.data as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || m[CARD_BOX_MESSAGE] !== 1) return null;
  if (m.op === "shell-ready") return { op: "shell-ready" };
  if (m.op === "height" && typeof m.height === "number" && Number.isFinite(m.height)) return { op: "height", height: m.height };
  if (m.op === "error") return { op: "error", message: String(m.message ?? "").slice(0, 2000) };
  if (m.op === "focus") return { op: "focus", user: m.user === true };
  if (m.op === "api") return { op: "api", msg: m.msg };
  return null;
}

/**
 * The page's half of "it never takes the keyboard focus on its own": when focus lands in the box
 * and neither the page's own Tab, just now, nor the user's press inside it (`ask` asks the shell,
 * whose answer comes back to `onBoxFocus`) brought it there, focus goes back where it was. Self-contained (no imports, no outer names), so a
 * test page can carry it as source; it reads the DOM only when called.
 */
export function boxFocusGuard(doc: Document, shell: HTMLIFrameElement, ask: () => void): { onBoxFocus(user: boolean): void; dispose(): void } {
  let last: HTMLElement | null = doc.activeElement instanceof HTMLElement && doc.activeElement !== shell ? doc.activeElement : null;
  let tabAt = -Infinity;
  const onIn = (e: FocusEvent) => {
    if (e.target instanceof HTMLElement && e.target !== shell && e.target.tagName !== "IFRAME") last = e.target;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") tabAt = performance.now();
  };
  // Focus leaving the page for a frame blurs its window; if the frame is this box, ask the shell.
  const onBlur = () =>
    setTimeout(() => {
      if (doc.activeElement === shell && performance.now() - tabAt >= 1000) ask();
    }, 0);
  const win = doc.defaultView;
  doc.addEventListener("focusin", onIn, true);
  doc.addEventListener("keydown", onKey, true);
  win?.addEventListener("blur", onBlur);
  return {
    onBoxFocus(user) {
      if (user || performance.now() - tabAt < 1000) return;
      if (doc.activeElement !== shell) return;
      shell.blur();
      if (last?.isConnected) last.focus({ preventScroll: true });
    },
    dispose() {
      doc.removeEventListener("focusin", onIn, true);
      doc.removeEventListener("keydown", onKey, true);
      win?.removeEventListener("blur", onBlur);
    },
  };
}
