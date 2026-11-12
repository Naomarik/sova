import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js";
import type { DesignLinkUse, DesignSetup } from "../../shared/design";
import type { DesignStore } from "../lib/design-store";
import { coordinatorChangeLine } from "../lib/design-brief";
import { designSectionOf } from "../../shared/design-models";
import { canShuffle, designSections, moveCoordinator, pairsLine, searchModels, setCombine, shufflePairs, tickedLine, toggleDirection, toggleGroup, toggleLayout, toggleModel, type DesignRunView } from "../lib/design-ui";
import { ActionMenu } from "./ActionMenu";
import { Icon } from "./ui";
import { SearchField, Toggle } from "./form";

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
export function DesignSetupPickers(props: { setup: SetupDraft; /** The chat's coordinator now, provider/modelId, on a later run. */ currentCoordinator?: string }) {
  return (
    <>
      <DesignModelPicker setup={props.setup} currentCoordinator={props.currentCoordinator} />
      <DesignDirectionPicker setup={props.setup} />
    </>
  );
}

/** One closed row of the direction picker, built like a provider's row: it opens what it holds below itself. */
function DirectionRow(props: { name: string; ticked: string; count: string; open: boolean; onToggle(): void; panelId: string; children: JSX.Element }) {
  return (
    <div class="design-section" role="group" aria-label={props.name}>
      <div class="design-section-head">
        <button type="button" class="design-section-open" aria-expanded={props.open ? "true" : "false"} aria-controls={props.panelId} onClick={() => props.onToggle()}>
          <span class="design-section-name">{props.name}</span>
          <span class="design-section-ticked" title={props.ticked}>
            {props.ticked}
          </span>
          <span class="design-section-count">{props.count}</span>
          <Icon name="chevron-down" small class="design-section-arrow" />
        </button>
      </div>
      <Show when={props.open}>
        <div class="design-direction-panel" id={props.panelId}>
          {props.children}
        </div>
      </Show>
    </div>
  );
}

/** A press-to-tick chip: a plus while off, a check while on, in the same room either way. */
function DirectionChip(props: { name: string; on: boolean; onChange(on: boolean): void }) {
  return (
    <button type="button" class="button button-sm design-chip" aria-pressed={props.on ? "true" : "false"} onClick={() => props.onChange(!props.on)}>
      {props.name}
    </button>
  );
}

/**
 * Style and Layout: 2 closed rows, then 1 fixed line for how they combine. A row opens below itself, so
 * nothing above it moves; the combine line keeps its one line and its Shuffle's room whatever is ticked.
 */
function DesignDirectionPicker(props: { setup: SetupDraft }) {
  const draft = props.setup.draft;
  const change = props.setup.change;
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const toggleOpen = (id: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const styleId = createUniqueId();
  const layoutId = createUniqueId();
  // Families in the order they first appear; a run from before families lists its styles as one group.
  const families = createMemo(() => {
    const out: { name: string; styles: string[] }[] = [];
    for (const d of draft().directions) {
      const name = d.family ?? "";
      const held = out.find((f) => f.name === name);
      if (held) held.styles.push(d.name);
      else out.push({ name, styles: [d.name] });
    }
    return out;
  }, undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const layouts = () => draft().layouts ?? [];
  const layoutNames = createMemo(() => layouts().map((d) => d.name), undefined, { equals: (a, b) => a.join("\n") === b.join("\n") });
  const styleOn = (name: string) => !!draft().directions.find((d) => d.name === name)?.on;
  const layoutOn = (name: string) => !!layouts().find((d) => d.name === name)?.on;
  const combine = () => (draft().combine === "every" ? "every" : "pair");
  const anyLayout = () => layouts().some((d) => d.on);
  const line = createMemo(() => pairsLine(draft()));
  const countOf = (list: readonly { on: boolean }[]) => `${list.filter((d) => d.on).length} of ${list.length}`;
  return (
    <div class="stack-2">
      <h4 class="design-setup-label">Directions</h4>
      <div class="design-sections">
        <DirectionRow name="Style" ticked={tickedLine(draft().directions, "None ticked")} count={countOf(draft().directions)} open={opened().has("style")} onToggle={() => toggleOpen("style")} panelId={styleId}>
          <For each={families()}>
            {(f) => (
              <div class="design-family" role="group" aria-label={f.name || "Styles"}>
                <Show when={f.name}>
                  <span class="design-family-name">{f.name}</span>
                </Show>
                <div class="design-chips">
                  <For each={f.styles}>{(name) => <DirectionChip name={name} on={styleOn(name)} onChange={(on) => change(toggleDirection(draft(), name, on))} />}</For>
                </div>
              </div>
            )}
          </For>
        </DirectionRow>
        <Show when={layoutNames().length}>
          <DirectionRow name="Layout" ticked={tickedLine(layouts(), "Designer's Choice")} count={countOf(layouts())} open={opened().has("layout")} onToggle={() => toggleOpen("layout")} panelId={layoutId}>
            <div class="design-chips">
              <For each={layoutNames()}>{(name) => <DirectionChip name={name} on={layoutOn(name)} onChange={(on) => change(toggleLayout(draft(), name, on))} />}</For>
            </div>
          </DirectionRow>
        </Show>
      </div>
      <Show when={layoutNames().length}>
        <div class="design-combine">
          <div class="design-combine-how" role="group" aria-label="How styles and layouts combine">
            <button type="button" class="button button-sm" aria-pressed={combine() === "pair" ? "true" : "false"} disabled={!anyLayout()} onClick={() => change(setCombine(draft(), "pair"))}>
              Pair Up
            </button>
            <button type="button" class="button button-sm" aria-pressed={combine() === "every" ? "true" : "false"} disabled={!anyLayout()} onClick={() => change(setCombine(draft(), "every"))}>
              Every Mix
            </button>
          </div>
          <span class="design-combine-pairs text-caption" classList={{ "text-muted": !anyLayout() }} title={line().full} role="status">
            {line().text}
          </span>
          <button type="button" class="button button-ghost button-sm design-combine-shuffle" style={{ visibility: canShuffle(draft()) ? "visible" : "hidden" }} title="Deal the pairs again. The count stays." onClick={() => change(shufflePairs(draft()))}>
            Shuffle
          </button>
        </div>
      </Show>
    </div>
  );
}

/**
 * The models: a Creative Director dropdown and a search box on one row, then one closed section per provider.
 * Everything that opens grows the card below the click: the dropdown lays over the page in the top layer,
 * a section's models come in under its own row, and a search replaces only what is under the box.
 */
function DesignModelPicker(props: { setup: SetupDraft; currentCoordinator?: string }) {
  const draft = props.setup.draft;
  const change = props.setup.change;
  const byRef = createMemo(() => new Map(draft().models.map((m) => [m.ref, m])));
  const sections = createMemo(() => designSections(draft().models));
  // Keyed by id: a tick redraws a section's words, never its row, so focus and the open state stay put.
  const sectionIds = createMemo(() => sections().map((x) => x.id), undefined, { equals: (a, b) => a.join("\n") === b.join("\n") });
  const section = (id: string) => sections().find((x) => x.id === id);
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const [query, setQuery] = createSignal("");
  const found = createMemo(() => searchModels(draft().models, query()));
  const foundSections = createMemo(() => {
    const out: { id: string; name: string; refs: string[] }[] = [];
    for (const m of found()) {
      const sec = designSectionOf(m.ref);
      const held = out.find((x) => x.id === sec.id);
      if (held) held.refs.push(m.ref);
      else out.push({ ...sec, refs: [m.ref] });
    }
    return out;
  });
  const coordinator = () => draft().models.find((m) => m.coordinator);
  const toggleOpen = (id: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const Row = (p: { model: string }) => {
    const m = () => byRef().get(p.model);
    return (
      <Show when={m()}>
        {(model) => (
          <li class="design-model-cell">
            <Toggle
              switch
              class="design-model-toggle"
              label={
                <span class="design-model-name" title={model().ref}>
                  {model().name}
                  <Show when={!model().vision}>
                    <span class="text-muted design-model-note" title="This model can't read images. It works from a text outline of the page.">
                      {" "}
                      · text only
                    </span>
                  </Show>
                </span>
              }
              ariaLabel={`${model().name}: design`}
              checked={model().design}
              onChange={(on) => change(toggleModel(draft(), p.model, on))}
            />
          </li>
        )}
      </Show>
    );
  };

  return (
    <div class="stack-2 design-models">
      <h4 class="design-setup-label">Models</h4>
      <div class="design-pick-bar">
        <div class="design-pick-coord">
          <span class="design-pick-coord-label" id="design-coordinator-label">
            Creative Director
          </span>
          <ActionMenu
            label={`Creative Director: ${coordinator()?.name ?? "none"}`}
            title="1 model coordinates the team. It can coordinate without designing."
            text={coordinator()?.name ?? "Pick a Model"}
            icon={null}
            align="start"
            ghost={false}
            class="design-pick-coord-button"
            menuName="Creative Director"
            panelClass="design-coord-menu"
            returnFocus
          >
            {(api) => (
              <For each={sectionIds()}>
                {(id) => (
                  <div role="group" aria-label={section(id)?.name}>
                    <div class="popover-label" aria-hidden="true">
                      {section(id)?.name}
                    </div>
                    <For each={section(id)?.refs ?? []}>
                      {(ref) => {
                        const m = () => byRef().get(ref)!;
                        return (
                          <api.Item
                            label={m().name}
                            aria={`${m().name}${m().design ? ", designing" : ""}`}
                            checked={m().coordinator}
                            end={m().design ? "Designing" : undefined}
                            onRun={() => change(moveCoordinator(draft(), ref))}
                          />
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            )}
          </ActionMenu>
        </div>
        <SearchField class="design-model-search" label="Find a model" placeholder="Find a model" spellcheck={false} value={query()} onInput={setQuery} />
      </div>
      {/* A later run's place for the Creative Director change, kept whether or not it says anything. */}
      <Show when={props.currentCoordinator}>
        <p class="text-caption text-muted design-setup-coord-note" role="status">
          {coordinatorChangeLine(draft(), props.currentCoordinator!)}
        </p>
      </Show>
      <Show
        when={!query().trim()}
        fallback={
          <div class="design-model-found" aria-label="Models found">
            <Show when={foundSections().length} fallback={<p class="text-caption text-muted design-model-none">No model matches “{query().trim()}”.</p>}>
              <For each={foundSections()}>
                {(sec) => (
                  <div role="group" aria-label={sec.name}>
                    <p class="design-section-label">{sec.name}</p>
                    <ul class="design-model-grid">
                      <For each={sec.refs}>{(ref) => <Row model={ref} />}</For>
                    </ul>
                  </div>
                )}
              </For>
            </Show>
          </div>
        }
      >
        <div class="design-sections">
          <For each={sectionIds()}>
            {(id) => {
              const sec = () => section(id);
              const isOpen = () => opened().has(id);
              const gridId = createUniqueId();
              return (
                <Show when={sec()}>
                  {(s) => (
                    <div class="design-section" role="group" aria-label={s().name}>
                      <div class="design-section-head">
                        <button type="button" class="design-section-open" aria-expanded={isOpen() ? "true" : "false"} aria-controls={gridId} onClick={() => toggleOpen(id)}>
                          <span class="design-section-name">{s().name}</span>
                          <span class="design-section-ticked" title={s().summary}>
                            {s().summary}
                          </span>
                          <span class="design-section-count">{`${s().on} of ${s().count}`}</span>
                          <Icon name="chevron-down" small class="design-section-arrow" />
                        </button>
                        <Toggle
                          class="design-toggle-inline design-section-all"
                          label="All"
                          ariaLabel={`${s().name}: all designing`}
                          checked={s().on === s().count}
                          mixed={s().on > 0 && s().on < s().count}
                          onChange={(on) => change(toggleGroup(draft(), id, on))}
                        />
                      </div>
                      <Show when={isOpen()}>
                        <ul class="design-model-grid" id={gridId} aria-label={`${s().name} models`}>
                          <For each={s().refs}>{(ref) => <Row model={ref} />}</For>
                        </ul>
                      </Show>
                    </div>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
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
        {choice("content", "Not a Reference")}
      </div>
    </div>
  );
}
