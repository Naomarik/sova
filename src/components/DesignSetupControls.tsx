import { createEffect, createSignal, For, on, onCleanup, Show, untrack, type Accessor } from "solid-js";
import type { DesignLinkUse, DesignSetup } from "../../shared/design";
import type { DesignStore } from "../lib/design-store";
import { designGroups, moveCoordinator, toggleDirection, toggleGroup, toggleModel, type DesignRunView } from "../lib/design-ui";
import { Toggle } from "./form";

export interface SetupDraft {
  draft: Accessor<DesignSetup>;
  saving: Accessor<"" | "saving" | "error">;
  change(next: DesignSetup): void;
  /** Saves what's waiting now, for a press that needs the server to have it. */
  flush(): Promise<void>;
}

/** The Setup card's choices as you make them: saved shortly after each click, and never replaced by an update while unsaved. */
export function createSetupDraft(run: Accessor<DesignRunView>, store: DesignStore): SetupDraft {
  const [draft, setDraft] = createSignal<DesignSetup>(untrack(() => run().setup));
  const [saving, setSaving] = createSignal<"" | "saving" | "error">("");
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      () => run().setup,
      (s) => {
        if (!dirty) setDraft(s);
      },
    ),
  );
  const save = () => {
    timer = undefined;
    const sent = draft();
    setSaving("saving");
    store.api
      .setup(run().id, sent)
      .then(() => {
        if (sent === draft()) dirty = false;
        setSaving("");
      })
      .catch(() => setSaving("error"));
  };
  onCleanup(() => {
    if (timer) {
      clearTimeout(timer);
      save();
    }
  });
  return {
    draft,
    saving,
    change: (next) => {
      setDraft(next);
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(save, 300);
    },
    flush: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        await store.api.setup(run().id, draft());
      }
      dirty = false;
    },
  };
}

/** The models and directions, on Setup and behind the brief's Change: the same controls in both places. */
export function DesignSetupPickers(props: { setup: SetupDraft }) {
  const draft = props.setup.draft;
  const change = props.setup.change;
  const groups = () => designGroups(draft().models);
  // Rows are keyed by name, so a click keeps its row (and the keyboard focus on it).
  const groupIds = () => groups().map((g) => g.id);
  // What the main chat picked comes first; the order is set once, so a row never jumps as it's ticked.
  const modelOrder = untrack(() => [...draft().models].sort((a, b) => Number(b.design || b.coordinator) - Number(a.design || a.coordinator)).map((m) => m.ref));
  const modelRefs = () => {
    const known = new Set(draft().models.map((m) => m.ref));
    return [...modelOrder.filter((r) => known.has(r)), ...draft().models.map((m) => m.ref).filter((r) => !modelOrder.includes(r))];
  };
  return (
    <>
      <div class="stack-2">
        <h4 class="design-setup-label">Models</h4>
        <div class="design-setup-groups" role="group" aria-label="Model groups">
          <For each={groupIds()}>
            {(id) => {
              const g = () => groups().find((x) => x.id === id)!;
              return <Toggle class="design-toggle-inline" label={g().name} checked={g().on === g().count} mixed={g().on > 0 && g().on < g().count} onChange={(on) => change(toggleGroup(draft(), id, on))} />;
            }}
          </For>
        </div>
        <ul class="list design-model-list" aria-label="Models">
          <For each={modelRefs()}>
            {(ref) => {
              const m = () => draft().models.find((x) => x.ref === ref)!;
              return (
                <li class="design-model-row">
                  <span class="design-model-name">
                    {m().name}
                    <Show when={!m().vision}>
                      <span class="text-muted design-model-note" title="This model can't read images. It works from a text outline of the page.">
                        {" "}
                        · text only
                      </span>
                    </Show>
                  </span>
                  <Toggle switch class="design-model-toggle" label="Design" ariaLabel={`${m().name}: design`} checked={m().design} onChange={(on) => change(toggleModel(draft(), ref, on))} />
                  <Toggle
                    class="design-model-toggle"
                    label="Coordinator"
                    ariaLabel={`${m().name}: coordinator`}
                    title="1 model coordinates the team. It can coordinate without designing."
                    checked={m().coordinator}
                    onChange={(_on, el) => {
                      el.checked = true;
                      change(moveCoordinator(draft(), ref));
                    }}
                  />
                </li>
              );
            }}
          </For>
        </ul>
      </div>
      <div class="stack-2">
        <h4 class="design-setup-label">Directions</h4>
        <div class="design-directions">
          <For each={draft().directions.map((d) => d.name)}>
            {(name) => {
              const d = () => draft().directions.find((x) => x.name === name)!;
              return <Toggle class="design-toggle-inline" label={name} checked={d().on} onChange={(on) => change(toggleDirection(draft(), name, on))} />;
            }}
          </For>
        </div>
      </div>
    </>
  );
}

/** One link and how it's used, on Setup and on the brief. */
export function DesignLinkRow(props: { url: string; use: DesignLinkUse | null; disabled?: boolean; onUse(use: DesignLinkUse): void }) {
  const choice = (use: DesignLinkUse, label: string) => (
    <button type="button" class="button" aria-pressed={props.use === use} disabled={props.disabled} onClick={() => props.onUse(use)}>
      {label}
    </button>
  );
  return (
    <div class="design-link-row">
      <code class="design-link-url" title={props.url}>
        {props.url}
      </code>
      <div class="design-link-use" role="group" aria-label={`How to use ${props.url}`}>
        {choice("images", "Use Its Images")}
        {choice("feel", "Just Its Feel")}
      </div>
    </div>
  );
}
