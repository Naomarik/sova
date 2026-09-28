/** `vis tree` view: HTML nested lists (the browser wraps; screen readers read a tree). */
import { For, Show } from "solid-js";
import { looksLikePath } from "../../core/text";
import type { ViewProps } from "../../types";
import type { TreeNode, TreeSpec } from "./parse";
import "./tree.css";

export default function TreeView(props: ViewProps<TreeSpec>) {
  return (
    <div class="vis-tree-wrap">
      <ul class="vis-tree" role="tree" aria-label={props.label}>
        <For each={props.spec.roots}>{(n) => <TreeItem node={n} />}</For>
      </ul>
    </div>
  );
}

function TreeItem(props: { node: TreeNode }) {
  const n = props.node;
  return (
    <li role="treeitem" aria-expanded={n.children.length ? true : undefined} class={`vis-tone-${n.tone ?? "none"}`}>
      <span class="vis-tree-row">
        <span class="vis-tree-name" classList={{ "vis-mono": looksLikePath(n.name) }}>
          {n.name}
        </span>
        <Show when={n.note}>
          <span class="vis-tree-note">{n.note}</span>
        </Show>
      </span>
      <Show when={n.children.length}>
        <ul role="group">
          <For each={n.children}>{(c) => <TreeItem node={c} />}</For>
        </ul>
      </Show>
    </li>
  );
}
