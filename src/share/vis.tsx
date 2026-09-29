import { lazy, type Component } from "solid-js";
import { render } from "solid-js/web";
import type { VisBase } from "../vis/core/grammar";
import { Figure } from "../vis/Figure";
import { setVisIcons } from "../vis/icons";
import type { ViewProps } from "../vis/types";
import type { ShareVisual } from "./markdown";

// Drawings on the share and owner pages (§app.baton/outsider-view): the chat's figure without
// Source or Copy, for the business kinds only (markdown.ts decides which fences get here).

// The share listener serves only this build's assets, so the icons a drawing uses come with it, in
// the Views' chunk (vis-icons.ts), loaded before any drawing mounts.
const loadViews = () =>
  Promise.all([import("../vis/share-views"), import("./vis-icons")]).then(([views, icons]) => {
    setVisIcons((name) => icons.SHARE_ICONS[name] ?? "");
    return views;
  });

const views = new Map<string, Component<ViewProps<VisBase>>>();
function viewFor(kind: string): Component<ViewProps<VisBase>> {
  let view = views.get(kind);
  if (!view) {
    view = lazy(() => loadViews().then((m) => ({ default: m[kind as keyof typeof m] as Component<ViewProps<VisBase>> })));
    views.set(kind, view);
  }
  return view;
}

/** hydrate.tsx's `mount` for a share page. */
export const mountShareVisual = (placeholder: HTMLElement, v: ShareVisual): (() => void) =>
  render(() => <Figure kind={v.kind} spec={v.spec} view={viewFor(v.kind)} />, placeholder);
