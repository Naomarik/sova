import { render } from "solid-js/web";
import type { RenderedMarkdown } from "../lib/markdown";
import { Visual } from "./Visual";

interface Mounted {
  key: string;
  dispose: () => void;
}

type MoveBefore = (node: Node, child: Node | null) => void;

/**
 * Keeps a markdown body's DOM in step with its rendered HTML, one top-level block at a time: a
 * block whose HTML is unchanged is left alone, so while a reply streams (re-rendered every frame)
 * the paragraphs above the cursor — and the drawings mounted in them — stay put. Each
 * `.md-vis[data-vis]` placeholder gets a <Visual> mounted into it. When a changed block still holds
 * a drawing with the same key (a vis fence inside a list that is still growing), the drawing moves
 * across instead of being rebuilt — with `moveBefore` where the browser has it, so an interactive
 * frame keeps its state.
 */
export function createMarkdownPatcher(el: HTMLElement) {
  let sources: string[] = [];
  const mounted = new Map<HTMLElement, Mounted>();

  const nodeSource = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element).outerHTML : `${n.nodeType}:${n.textContent ?? ""}`);

  /** Move drawings from `from` into same-key placeholders of `to` (both connected). */
  const adopt = (from: Node, to: Node) => {
    if (!(from instanceof HTMLElement) || !(to instanceof HTMLElement)) return;
    const olds = [...mounted.entries()].filter(([ph]) => from.contains(ph));
    if (!olds.length) return;
    const fresh = [...to.querySelectorAll<HTMLElement>(".md-vis[data-vis-key]")];
    for (const [ph, m] of olds) {
      const target = fresh.find((f) => f.dataset.visKey === m.key && !mounted.has(f));
      if (!target) continue;
      const move = (target as unknown as { moveBefore?: MoveBefore }).moveBefore;
      for (const child of [...ph.childNodes]) move ? move.call(target, child, null) : target.appendChild(child);
      mounted.delete(ph);
      mounted.set(target, m);
    }
  };

  function patch(r: RenderedMarkdown) {
    const tpl = document.createElement("template");
    tpl.innerHTML = r.html;
    const next = [...tpl.content.childNodes];
    const nextSources = next.map(nodeSource);
    let current = [...el.childNodes];
    if (current.length !== sources.length) {
      // Someone else changed the DOM (or first run): start from scratch.
      el.textContent = "";
      current = [];
      sources = [];
    }
    for (let i = 0; i < next.length; i++) {
      if (i < current.length && sources[i] === nextSources[i]) continue;
      const old = current[i];
      if (old) {
        el.insertBefore(next[i]!, old);
        adopt(old, next[i]!);
        old.remove();
      } else el.appendChild(next[i]!);
    }
    for (let i = next.length; i < current.length; i++) current[i]!.remove();
    sources = nextSources;

    for (const [ph, m] of mounted) {
      if (el.contains(ph)) continue;
      m.dispose();
      mounted.delete(ph);
    }
    for (const ph of el.querySelectorAll<HTMLElement>(".md-vis[data-vis]")) {
      if (mounted.has(ph)) continue;
      const v = r.visuals[Number(ph.dataset.vis)];
      if (!v) continue;
      mounted.set(ph, { key: ph.dataset.visKey ?? "", dispose: render(() => <Visual kind={v.kind} spec={v.spec} fence={v.fence} body={v.body} />, ph) });
    }
  }

  function dispose() {
    for (const m of mounted.values()) m.dispose();
    mounted.clear();
  }

  return { patch, dispose };
}
