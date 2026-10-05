/**
 * The share build's frame host (§chat.markdown/visuals, §app.baton/share-listener): the one static
 * document a share or owner page frames a `vis html` drawing in. The page's own CSP runs no inline
 * script, so the drawing can't be a `srcdoc` there; instead the frame loads this file from the
 * page's own host, and the page posts it the drawing's whole document (src/vis/kinds/frame/srcdoc.ts
 * `buildSrcdoc`, unchanged: its meta CSP, tokens, motion gate and reporter come with it).
 *
 * Its header CSP's `sandbox allow-scripts` gives it an opaque origin although it is served from the
 * page's host, so it reaches nothing of the page (no cookies, storage or DOM), and `default-src
 * 'none'` lets it fetch nothing. Emitted into dist-share/assets by vite.config.ts; served with
 * `frameHostHeaders` by the share listener (server/share/routes.ts) and by a gateway passing a
 * routed host's copy (server/share/router.ts). Imports nothing.
 */

export const FRAME_HOST_NAME = "vis-frame.html";
/** Where a share or owner page loads it from: the share build's assets, on the page's own host. */
export const FRAME_HOST_PATH = `/h/assets/${FRAME_HOST_NAME}`;

export const FRAME_HOST_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** Its headers, wherever it is served from: typed as HTML (the one asset that is), framable only
    by its own host, sandboxed by its CSP. */
export const frameHostHeaders = (): Record<string, string> => ({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": FRAME_HOST_CSP,
  "X-Frame-Options": "SAMEORIGIN",
});

/** The message the page posts once the frame has loaded: `{type, doc}`. The same type the drawing's
    own reporter uses (srcdoc.ts FRAME_MESSAGE; a test pins them equal). */
export const FRAME_HOST_MESSAGE = "sova-vis";

/**
 * The document. Its whole body is one script: take the FIRST `{type, doc}` message from the parent
 * (its own window and origin), drop WebRTC's constructors (the CSP doesn't cover a peer connection;
 * best effort: a determined script may find another way), then write the drawing's document in
 * place. `document.open` keeps this window, so the page's source and id checks hold for the
 * drawing's own messages, and this listener is gone with the old document.
 */
export const FRAME_HOST_HTML =
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>` +
  `(function(){var done=false;function take(e){` +
  `if(done||e.source!==parent||parent===window||e.origin!==location.origin)return;` +
  `var d=e.data;if(!d||d.type!==${JSON.stringify(FRAME_HOST_MESSAGE)}||typeof d.doc!=="string")return;` +
  `done=true;removeEventListener("message",take);` +
  `try{delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;delete window.mozRTCPeerConnection}catch(x){}` +
  `document.open();document.write(d.doc);document.close()}` +
  `addEventListener("message",take)})();` +
  `</script></body></html>\n`;
