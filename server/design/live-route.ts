// The page being written, as one document: a frame loads this once and the page fills in as it arrives, with
// no reload. On connecting it gets the text so far, then each slice, until that page ends.
import type { Context, Hono } from "hono";
import { DESIGN_ASSET_PLACEHOLDER_STYLE, DESIGN_STREAM_CSP, HOLD_MOTION_STYLE } from "../../src/lib/design-frame";
import { followLivePage, livePage } from "./live";
import { LIVE_LINK_ROUTE, liveLink, liveLinkUrl, mintLiveLink, type LiveLink } from "./live-link";
import { designOf, readPage } from "./store";

// no-transform: compression would hold the slices back.
const NO_STORE = { "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" };
const POLICY = `sandbox; ${DESIGN_STREAM_CSP}`;
/** A page mid-write holds still. The policy comes with the headers; a half-written last tag is the parser's to drop. */
const documentOf = (text: string) => `<!doctype html><style>${HOLD_MOTION_STYLE}${DESIGN_ASSET_PLACEHOLDER_STYLE}</style>${text}`;
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;

function stream(link: LiveLink): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let off: (() => void) | null = null;
  let held = "";
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const write = (text: string) => {
        // A slice can end halfway through a character: its other half comes with the next.
        let t = held + text;
        held = "";
        if (t.length && isHighSurrogate(t.charCodeAt(t.length - 1))) {
          held = t.slice(-1);
          t = t.slice(0, -1);
        }
        if (t) controller.enqueue(encoder.encode(t));
      };
      const close = () => {
        if (!open) return;
        open = false;
        off?.();
        off = null;
        controller.close();
      };
      const live = livePage(link.sessionId, link.label);
      if (live && live.version === link.version) {
        write(documentOf(live.text));
        off = followLivePage(link.sessionId, link.label, live.chars, { text: write, end: close });
      } else {
        // That page has ended since: its finished text, if it got that far.
        write(documentOf(readPage(link.sessionId, link.label, link.version) ?? ""));
        close();
      }
    },
    cancel() {
      off?.();
      off = null;
    },
  });
}

export function mountDesignLiveRoutes(app: Hono, parentOf: (c: Context) => { sessionId: string } | null): void {
  app.get(LIVE_LINK_ROUTE, (c) => {
    const link = liveLink(c.req.param("token"));
    if (!link) return c.text("This link has run out.", 403, NO_STORE);
    if (!designOf(link.sessionId, link.label)) return c.text("This design is gone.", 404, NO_STORE);
    return new Response(stream(link), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": POLICY, "Referrer-Policy": "no-referrer", ...NO_STORE } });
  });

  app.get("/api/design/:label/live-url", (c) => {
    const p = parentOf(c);
    if (!p) return c.json({ error: "Invalid or missing ?path=" }, 400);
    const label = c.req.param("label");
    const live = designOf(p.sessionId, label) ? livePage(p.sessionId, label) : null;
    if (!live) return c.json({ error: "Nothing is being written." }, 404);
    const { token, expires } = mintLiveLink(p.sessionId, label, live.version);
    return c.json({ url: liveLinkUrl(token), version: live.version, expires }, 200, { "Cache-Control": "no-store" });
  });
}
