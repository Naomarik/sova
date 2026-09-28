/**
 * The free-form kinds: `vis html` and `vis svg` are model-written documents. They never touch the
 * app's DOM. Each renders in an `<iframe sandbox="allow-scripts">` (no allow-same-origin: an opaque
 * origin, no cookies, no storage, no parent DOM) from a srcdoc built here: a CSP that forbids every
 * network fetch, the app's theme tokens as CSS variables, a small base stylesheet, and a script that
 * reports the document's height to the parent so the frame fits its content.
 */

/** Tokens a free-form visual may use, as `var(--name)`. The guide lists the same names. */
export const FRAME_TOKENS = [
  "--color-bg",
  "--color-surface",
  "--color-sunken",
  "--color-ink",
  "--color-ink-2",
  "--color-ink-muted",
  "--color-border",
  "--color-border-strong",
  "--color-accent",
  "--color-accent-tint",
  "--color-on-accent",
  "--status-success",
  "--status-warn",
  "--status-error",
  "--status-info",
  "--status-success-bg",
  "--status-warn-bg",
  "--status-error-bg",
  "--status-info-bg",
] as const;

export const FRAME_MESSAGE = "sova-vis";
export const MAX_FRAME_HEIGHT = 1400;

/** The CSP: inline script and style only; images from data: and blob:; nothing over the network. */
export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";

/** Current token values from the app's root, for the frame's :root. */
export function readTokens(root: Element): Record<string, string> {
  const cs = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const t of FRAME_TOKENS) out[t] = cs.getPropertyValue(t).trim();
  return out;
}

export function tokenCss(tokens: Record<string, string>, scheme: "light" | "dark"): string {
  const decl = Object.entries(tokens)
    .filter(([k, v]) => /^--[a-z0-9-]+$/.test(k) && /^[#a-zA-Z0-9(),.%\s-]*$/.test(v))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  return `:root{${decl};color-scheme:${scheme}}`;
}

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
body{font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--color-ink);overflow-x:auto}
svg{max-width:100%;height:auto;display:block}
button{font:inherit;font-size:13px;min-height:32px;padding:4px 12px;border-radius:8px;border:1.5px solid var(--color-border-strong);background:var(--color-surface);color:var(--color-ink);cursor:pointer}
button:hover{background:var(--color-sunken)}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
input,select,textarea{font:inherit;color:var(--color-ink);background:var(--color-surface);border:1.5px solid var(--color-border-strong);border-radius:8px;padding:4px 8px}
input[type=range],input[type=checkbox],input[type=radio]{accent-color:var(--color-accent);padding:0}
code,pre,kbd{font-family:"JetBrains Mono",ui-monospace,Menlo,monospace;font-size:12.5px}
`;

/**
 * Posts `{type, id, height}` whenever the document's size changes, and applies theme updates the
 * parent sends as `{type, tokens}`. The id ties a message to its frame; the parent also checks the
 * message's source window.
 */
const reporter = (id: string) => `(function(){
var id=${JSON.stringify(id)},last=-1;
function h(){var b=document.body,e=document.documentElement;if(!b)return;var v=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height,e.getBoundingClientRect().height));if(v!==last){last=v;parent.postMessage({type:${JSON.stringify(FRAME_MESSAGE)},id:id,height:v},"*")}}
addEventListener("load",h);
addEventListener("DOMContentLoaded",function(){h();if(window.ResizeObserver)new ResizeObserver(h).observe(document.body)});
addEventListener("message",function(ev){var d=ev.data;if(ev.source===parent&&d&&d.type===${JSON.stringify(FRAME_MESSAGE)}&&d.css){var s=document.getElementById("sova-tokens");if(s)s.textContent=d.css;}});
setTimeout(h,50);setTimeout(h,400);
})();`;

/** The whole srcdoc for one visual. `source` goes in verbatim: the sandbox is the boundary. */
export function buildSrcdoc(kind: "html" | "svg", source: string, id: string, tokens: string): string {
  const body = kind === "svg" ? `<div class="sova-svg">${source}</div>` : source;
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style id="sova-tokens">${tokens}</style><style>${BASE_CSS}${kind === "svg" ? ".sova-svg{display:flex;justify-content:center}.sova-svg>svg{width:100%;max-width:720px}" : ""}</style>` +
    `<script>${reporter(id)}</script></head><body>${body}</body></html>`
  );
}
