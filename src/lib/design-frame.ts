/**
 * The frames a design prototype draws in: DOM-free builders, so the page and the tests use the same.
 *
 * A finished page runs its own scripts, so it gets the card box's two frames (src/lib/card-box.ts says
 * why): a small shell of Sova's holds the page's frame, and the shell's `frame-src 'none'` refuses every
 * navigation of it, which a content policy on the page itself cannot do. The page's document starts
 * with a policy that allows Google Fonts and nothing else over the network, then a boot script that
 * takes WebRTC off its global before any of the page's code runs.
 *
 * A page still being written is one document in an empty sandbox (no scripts at all), served by the
 * server as it arrives under this same stream policy, so it fills in without ever reloading.
 */

/** Everything a page may load: Google Fonts and its own data. Scripts and styles inline only. */
const NETWORK_REST =
  "img-src data: blob:; media-src data: blob:; font-src data: https://fonts.gstatic.com; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
const STYLES = "style-src 'unsafe-inline' https://fonts.googleapis.com";

/**
 * A finished page's required policy (its frame's `csp` attribute). The document's own policy is
 * stricter, `designPageCsp`: scripts by a nonce only. The boot script that nonce admits hides it,
 * then runs the page's code by eval, so a frame the page makes has no nonce to run anything with.
 */
export const DESIGN_PAGE_CSP = `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; ${STYLES}; ${NETWORK_REST}`;

/** Where the shell puts the page's fresh nonce. */
export const DESIGN_NONCE_SLOT = "__SOVA_DESIGN_NONCE__";

/** The page document's own policy. */
export const designPageCsp = (nonce: string) => `default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; ${STYLES}; ${NETWORK_REST}`;

/** The shell's policy. A nested frame's required policy must fit within its parent's, so it is the same. */
export const DESIGN_SHELL_CSP = DESIGN_PAGE_CSP;

/** A page being written: no scripts anywhere. */
export const DESIGN_STREAM_CSP = `default-src 'none'; ${STYLES}; ${NETWORK_REST}`;

export const DESIGN_SHELL_ATTRS = { sandbox: "allow-scripts allow-forms", csp: DESIGN_SHELL_CSP, referrerpolicy: "no-referrer" } as const;
export const DESIGN_PAGE_ATTRS = { sandbox: "allow-scripts allow-forms", csp: DESIGN_PAGE_CSP, referrerpolicy: "no-referrer" } as const;
/** A page being written: no scripts, and inert, so a click can't follow a link out of it (the sandbox lets a person's click navigate the frame). */
export const DESIGN_STREAM_ATTRS = { sandbox: "", csp: DESIGN_STREAM_CSP, referrerpolicy: "no-referrer", inert: "" } as const;

/** The width every prototype is drawn at, whatever box it is scaled into. */
export const DESIGN_PAGE_WIDTH = 1280;
/** The height of the top of a page a grid card shows (16:10). */
export const DESIGN_PAGE_HEIGHT = 800;

/** The tag on the one message a shell sends the page. */
export const DESIGN_FRAME_MESSAGE = "sova-design-frame";

export const DESIGN_FRAME_LEFT = "This page tried to leave its frame, so it was stopped.";

const head = (csp: string) =>
  `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta http-equiv="x-dns-prefetch-control" content="off"><meta name="referrer" content="no-referrer">`;

/**
 * Run before any page code, and only this runs by the nonce. WebRTC is the one way out no content
 * policy closes, so its interfaces go. The nonce is then hidden, so no frame the page makes, in any
 * tree, can run a script of its own: its policy is inherited, and its inline script has no nonce.
 * The page's scripts are run here instead, as the document finishes parsing and before
 * DOMContentLoaded, so their listeners for it still fire. Inline handlers (which the policy can't
 * allow) are moved onto listeners. A form that nobody stopped is stopped here: its validation and
 * submit handlers run, and a post would only be refused by `form-action`. The page says it has drawn
 * once its fonts are in and its opening animations have run (a fade-in starts from nothing), so a
 * picture held above it never gives way to a page still appearing.
 */
const SEAL_SCRIPT = `for(const n of Object.getOwnPropertyNames(globalThis))if(/^(webkit)?RTC/.test(n))delete globalThis[n];
document.currentScript.remove();
for(const m of document.querySelectorAll("meta[http-equiv]"))m.remove();
addEventListener("submit",(e)=>e.preventDefault());
{let ran=false;document.addEventListener("readystatechange",()=>{
if(ran||document.readyState!=="interactive")return;ran=true;
for(const el of document.querySelectorAll("*"))for(const a of [...el.attributes]){
if(!/^on[a-z]+$/.test(a.name)||el.tagName==="BODY"&&a.name==="onload")continue;
let f;try{f=new Function("event",a.value);}catch{continue;}
el.removeAttribute(a.name);
el.addEventListener(a.name.slice(2),function(e){if(f.call(this,e)===false)e.preventDefault();});}
const parses=(c)=>{try{new Function(c);return true;}catch{return false;}};
const code=[...document.querySelectorAll("script:not([src])")].filter((s)=>!s.type||/javascript|ecmascript/i.test(s.type)).map((s)=>s.textContent).filter(parses).join("\\n;\\n");
if(code)(0,eval)(code);
});}
{const raf=requestAnimationFrame.bind(window),said=()=>parent.postMessage({"sova-design-frame":1,op:"drawn"},"*");
const frames=()=>new Promise((r)=>raf(()=>raf(r)));
const settled=()=>Promise.race([Promise.all(document.getAnimations().filter((a)=>{const t=a.effect&&a.effect.getComputedTiming();return t&&isFinite(t.endTime);}).map((a)=>a.finished.catch(()=>0))),new Promise((r)=>setTimeout(r,1500))]);
addEventListener("load",()=>{Promise.race([document.fonts.ready,new Promise((r)=>setTimeout(r,1500))]).then(frames).then(settled).then(frames).then(said);});}`;

/** A grid card holds motion: animations jump to their end, and a script's animation loop stops after a moment. */
const HOLD_MOTION_SCRIPT = `{const r=requestAnimationFrame.bind(window);let n=0;window.requestAnimationFrame=(f)=>n++<90?r(f):0;}`;
export const HOLD_MOTION_STYLE = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition:none!important;scroll-behavior:auto!important}`;

/**
 * A page being written can name a captured image Sova hasn't put in yet (`sova-asset:a3`), which the frame can't load:
 * those spots show a plain block instead of the browser's broken-image mark. Real pictures come with the finished page.
 */
export const DESIGN_ASSET_PLACEHOLDER_STYLE = `img[src^="sova-asset:"],img[srcset*="sova-asset:"]{content:url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");background:#e6e6e3;color:transparent;min-width:48px;min-height:48px}`;

/** A finished page's document in two parts: Sova's own head (the policy and the seal), and the page as its author wrote it. */
export interface DesignPageDoc {
  head: string;
  page: string;
}

export function designPageDoc(html: string, opts: { motion: boolean }): DesignPageDoc {
  const hold = opts.motion ? "" : HOLD_MOTION_SCRIPT;
  const style = opts.motion ? "" : `<style>${HOLD_MOTION_STYLE}</style>`;
  return { head: `<!doctype html>${head(designPageCsp(DESIGN_NONCE_SLOT))}<script nonce="${DESIGN_NONCE_SLOT}">${SEAL_SCRIPT}${hold}</script>${style}`, page: html };
}

/** The shell that holds a finished page: it makes the page's frame and tells the page if it ever navigates. */
export function designShellDoc(doc: DesignPageDoc): string {
  const shell = `(() => {
  const f = document.createElement("iframe");
  for (const [k, v] of Object.entries(${JSON.stringify(DESIGN_PAGE_ATTRS)})) f.setAttribute(k, v);
  f.setAttribute("title", "Prototype");
  f.style.cssText = "border:0;display:block;width:100%;height:100%";
  const up = (op) => parent.postMessage({ ${JSON.stringify(DESIGN_FRAME_MESSAGE)}: 1, op }, "*");
  let loads = 0;
  f.addEventListener("load", () => {
    if (++loads === 1) return void setTimeout(() => up("drawn"), 2500);
    f.remove();
    up("left");
  });
  // The page says when it has drawn, fonts settled; it can only hurry or delay its own picture.
  addEventListener("message", (e) => { if (e.source === f.contentWindow && e.data && e.data[${JSON.stringify(DESIGN_FRAME_MESSAGE)}] === 1 && e.data.op === "drawn") up("drawn"); });
  // The nonce goes into Sova's own head only: the page's text never passes through this replace.
  f.srcdoc = ${JSON.stringify(doc.head)}.split(${JSON.stringify(DESIGN_NONCE_SLOT)}).join(Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("")) + ${JSON.stringify(doc.page)};
  document.body.append(f);
})();`.replace(/<\//g, "<\\/");
  return `<!doctype html><html><head>${head(DESIGN_SHELL_CSP)}<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}</style></head><body><script>${shell}</script></body></html>`;
}

/** The start of a page being written, as the server sends it: the text so far, with no motion. A half-written last tag is the parser's to drop. */
export function designStreamDoc(partial: string): string {
  return `<!doctype html>${head(DESIGN_STREAM_CSP)}<style>${HOLD_MOTION_STYLE}${DESIGN_ASSET_PLACEHOLDER_STYLE}</style>${partial}`;
}

/** Whether a page has anything to draw yet: nothing shows before its first style block closes. */
export const designHasStyles = (partial: string): boolean => /<\/style\s*>/i.test(partial);

/** What the shell said, or null for any other message. Only from this frame's own shell. */
export function fromDesignFrame(e: { source: unknown; data: unknown }, shell: unknown): "drawn" | "left" | null {
  if (!shell || e.source !== shell) return null;
  const m = e.data as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || m[DESIGN_FRAME_MESSAGE] !== 1) return null;
  return m.op === "drawn" || m.op === "left" ? m.op : null;
}

/**
 * Whether a page being written has something to see: its styles are closed and its body has text.
 * Until then the frame is a white sheet, so the progress note stays. A long stretch past the styles
 * counts too, for a page that opens with pictures or leaves out its body tag.
 */
export function designHasFirstPaint(partial: string): boolean {
  const closed = /<\/style\s*>/i.exec(partial);
  if (!closed) return false;
  const rest = partial.slice(closed.index + closed[0].length);
  return rest.length >= 4000 || /<body[^>]*>(?:\s*<[^>]*>)*\s*[^<\s]/i.test(rest);
}

/** About how many tokens of a page have been written, from its characters. */
export const tokensOfText = (chars: number): number => Math.round(chars / 3.6);

/** "A" for a first version, "A2" for its second. */
export const versionLabel = (label: string, version: number): string => (version > 1 ? `${label}${version}` : label);
