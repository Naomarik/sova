/** `vis tree` view: HTML nested lists (the browser wraps; a screen reader hears the levels). */
import { For, Show, createMemo, type Accessor } from "solid-js";
import { emphasisMap } from "../../core/emphasis";
import type { Emphasis } from "../../core/grammar";
import { looksLikePath } from "../../core/text";
import { EmBadge, emClass } from "../../emphasis";
import type { ViewProps } from "../../types";
import type { TreeNode, TreeSpec } from "./parse";
import "./tree.css";

export default function TreeView(props: ViewProps<TreeSpec>) {
  const em = createMemo(() => emphasisMap(props.spec));
  return (
    <div class="vis-tree-wrap">
      <ul class="vis-tree" aria-label={props.label}>
        <For each={props.spec.roots}>{(n) => <TreeItem node={n} em={em} />}</For>
      </ul>
    </div>
  );
}

function TreeItem(props: { node: TreeNode; em: Accessor<Map<string, Emphasis>> }) {
  const n = props.node;
  const e = () => props.em().get(n.key);
  return (
    <li class={`vis-tone-${n.tone ?? "none"}`} classList={{ "vis-tree-parent": n.children.length > 0 }}>
      <span class={`vis-tree-row ${emClass(e())}`}>
        <EmBadge e={e()} />
        <span class="vis-tree-name" classList={{ "vis-mono": looksLikePath(n.name) || n.name.endsWith("/") }}>
          {n.name}
        </span>
        <Show when={n.note}>
          <span class="vis-tree-note">{n.note}</span>
        </Show>
      </span>
      <Show when={n.children.length}>
        <ul>
          <For each={n.children}>{(c) => <TreeItem node={c} em={props.em} />}</For>
        </ul>
      </Show>
    </li>
  );
}
