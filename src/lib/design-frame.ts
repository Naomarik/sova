/**
 * The frames a design prototype draws in: DOM-free builders, so the page and the tests use the same.
 *
 * A finished page runs its own scripts, so it gets the card box's two frames (src/lib/card-box.ts says
 * why): a small shell of Sova's holds the page's frame, and the shell's `frame-src 'none'` refuses every
 * navigation of it, which a content policy on the page itself cannot do. The page's document starts
 * with a policy that allows Google Fonts and nothing else over the network, then a boot script that
 * takes WebRTC off its global before any of the page's code runs.
 *
 * A page still being written is a still picture: an empty sandbox (no scripts at all), and two frames
 * swapped on load, so each redraw replaces a finished picture rather than blanking the card.
 */

/** Everything a page may load: Google Fonts and its own data. Scripts and styles inline only. */
const NETWORK_REST =
  "img-src data: blob:; media-src data: blob:; font-src data: https://fonts.gstatic.com; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
const STYLES = "style-src 'unsafe-inline' https://fonts.googleapis.com";

/** A finished page's policy: its own document's meta tag and its frame's `csp` attribute. */
export const DESIGN_PAGE_CSP = `default-src 'none'; script-src 'unsafe-inline'; ${STYLES}; ${NETWORK_REST}`;

/** The shell's policy. A nested frame's required policy must fit within its parent's, so it is the same. */
export const DESIGN_SHELL_CSP = DESIGN_PAGE_CSP;

/** A page being written: no scripts anywhere. */
export const DESIGN_STREAM_CSP = `default-src 'none'; ${STYLES}; ${NETWORK_REST}`;

export const DESIGN_SHELL_ATTRS = { sandbox: "allow-scripts", csp: DESIGN_SHELL_CSP, referrerpolicy: "no-referrer" } as const;
export const DESIGN_PAGE_ATTRS = { sandbox: "allow-scripts", csp: DESIGN_PAGE_CSP, referrerpolicy: "no-referrer" } as const;
export const DESIGN_STREAM_ATTRS = { sandbox: "", csp: DESIGN_STREAM_CSP, referrerpolicy: "no-referrer" } as const;

/** The width every prototype is drawn at, whatever box it is scaled into. */
export const DESIGN_PAGE_WIDTH = 1280;
/** The height of the top of a page a grid card shows (16:10). */
export const DESIGN_PAGE_HEIGHT = 800;

/** The tag on the one message a shell sends the page. */
export const DESIGN_FRAME_MESSAGE = "sova-design-frame";

export const DESIGN_FRAME_LEFT = "This page tried to leave its frame, so it was stopped.";

const head = (csp: string) => `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">`;

/**
 * Run before any page code. WebRTC is the one way out no content policy closes, so its interfaces go;
 * a frame the page makes would get a fresh global with them back, and could run its own inline
 * script (a page's own policy has to allow inline), so child frames are removed the moment they
 * appear, before they load. The observer is out of reach of the page.
 */
const SEAL_SCRIPT = `for(const n of Object.getOwnPropertyNames(globalThis))if(/^(webkit)?RTC/.test(n))delete globalThis[n];
new MutationObserver((rs)=>{for(const r of rs)for(const n of r.addedNodes){if(n.nodeType!==1)continue;if(/^(IFRAME|FRAME|OBJECT|EMBED)$/.test(n.tagName))n.remove();else if(n.querySelectorAll)for(const c of n.querySelectorAll("iframe,frame,object,embed"))c.remove();}}).observe(document,{childList:true,subtree:true});
document.currentScript.remove();`;

/** A grid card holds motion: animations jump to their end, and a script's animation loop stops after a moment. */
const HOLD_MOTION_SCRIPT = `{const r=requestAnimationFrame.bind(window);let n=0;window.requestAnimationFrame=(f)=>n++<90?r(f):0;}`;
const HOLD_MOTION_STYLE = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition:none!important;scroll-behavior:auto!important}`;

/** A finished page's own document: the policy, then the seal, then the page as its author wrote it. */
export function designPageDoc(html: string, opts: { motion: boolean }): string {
  const hold = opts.motion ? "" : HOLD_MOTION_SCRIPT;
  const style = opts.motion ? "" : `<style>${HOLD_MOTION_STYLE}</style>`;
  return `<!doctype html>${head(DESIGN_PAGE_CSP)}<script>${SEAL_SCRIPT}${hold}</script>${style}${html}`;
}

/** The shell that holds a finished page: it makes the page's frame and tells the page if it ever navigates. */
export function designShellDoc(pageDoc: string): string {
  const shell = `(() => {
  const f = document.createElement("iframe");
  for (const [k, v] of Object.entries(${JSON.stringify(DESIGN_PAGE_ATTRS)})) f.setAttribute(k, v);
  f.setAttribute("title", "Prototype");
  f.style.cssText = "border:0;display:block;width:100%;height:100%";
  let loads = 0;
  f.addEventListener("load", () => {
    if (++loads === 1) return parent.postMessage({ ${JSON.stringify(DESIGN_FRAME_MESSAGE)}: 1, op: "loaded" }, "*");
    f.remove();
    parent.postMessage({ ${JSON.stringify(DESIGN_FRAME_MESSAGE)}: 1, op: "left" }, "*");
  });
  f.srcdoc = ${JSON.stringify(pageDoc)};
  document.body.append(f);
})();`.replace(/<\//g, "<\\/");
  return `<!doctype html><html><head>${head(DESIGN_SHELL_CSP)}<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}</style></head><body><script>${shell}</script></body></html>`;
}

/** A page being written: the text so far, with no motion. A half-written last tag is the parser's to drop. */
export function designStreamDoc(partial: string): string {
  return `<!doctype html>${head(DESIGN_STREAM_CSP)}<style>${HOLD_MOTION_STYLE}</style>${partial}`;
}

/** Whether a page has anything to draw yet: nothing shows before its first style block closes. */
export const designHasStyles = (partial: string): boolean => /<\/style\s*>/i.test(partial);

/** What the shell said, or null for any other message. Only from this frame's own shell. */
export function fromDesignFrame(e: { source: unknown; data: unknown }, shell: unknown): "loaded" | "left" | null {
  if (!shell || e.source !== shell) return null;
  const m = e.data as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || m[DESIGN_FRAME_MESSAGE] !== 1) return null;
  return m.op === "loaded" || m.op === "left" ? m.op : null;
}

/** About how many tokens of a page have been written, from its characters. */
export const tokensOfText = (chars: number): number => Math.round(chars / 3.6);

/** "A" for a first version, "A2" for its second. */
export const versionLabel = (label: string, version: number): string => (version > 1 ? `${label}${version}` : label);
