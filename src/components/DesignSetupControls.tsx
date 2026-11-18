import { createMemo, createSignal, createUniqueId, For, onMount, Show, type JSX } from "solid-js";
import { designEffortOf, designHasEfforts, type DesignLinkUse, type DesignSetup } from "../../shared/design";
import type { DesignStore } from "../lib/design-store";
import { coordinatorChangeLine } from "../lib/design-brief";
import { designSectionOf } from "../../shared/design-models";
import { canShuffle, designModelName, designSections, effortLabel, leftOutLine, modelsSummary, moveCoordinator, pairsLine, searchModels, setCombine, setEffort, shufflePairs, tickedLine, toggleDirection, toggleGroup, toggleLayout, toggleModel, type DesignRunView } from "../lib/design-ui";
import { createRequestEditor, setupOpenState, type RequestEditor, type SetupDraft, type SetupOpenState } from "../lib/design-setup-view";
import { ActionMenu } from "./ActionMenu";
import { Icon } from "./ui";
import { SearchField, Select, TextArea, Toggle } from "./form";

export { createSetupDraft, type SetupDraft } from "../lib/design-setup-view";

/** The models and directions, on Setup and behind the brief's Change: the same controls in both places. `openKey` keeps
    which rows are open while the card is drawn again (a run and the place); `modelsOpen` is where Models starts. */
export function DesignSetupPickers(props: {
  setup: SetupDraft;
  run: DesignRunView;
  store: DesignStore;
  openKey: string;
  modelsOpen?: boolean;
  /** The chat's coordinator now, provider/modelId, on a later run. */
  currentCoordinator?: string;
}) {
  const open = setupOpenState(props.openKey, props.modelsOpen);
  return (
    <>
      <DesignModelPicker setup={props.setup} run={props.run} store={props.store} open={open} currentCoordinator={props.currentCoordinator} />
      <DesignDirectionPicker setup={props.setup} open={open} />
    </>
  );
}

/** What do you want to design: the request's first 2 lines and Edit; the whole request opens in an editor of its own
    (a window, a sheet on a phone), and the card changes only at Save. */
export function DesignRequestField(props: { setup: SetupDraft; openKey: string }) {
  const kept = setupOpenState(props.openKey);
  const editor = createRequestEditor(
    () => props.setup.draft().brief,
    (brief) => props.setup.change({ ...props.setup.draft(), brief }),
    kept.request,
  );
  const labelId = createUniqueId();
  return (
    <div class="design-request">
      <h4 class="design-setup-label" id={labelId}>
        What Do You Want to Design
      </h4>
      <div class="design-request-box">
        <p class="design-request-text" classList={{ "text-muted": !props.setup.draft().brief.trim() }} onClick={() => editor.open()}>
          {props.setup.draft().brief.trim() || "Say what to design."}
        </p>
        <button type="button" class="button button-sm design-request-edit" aria-describedby={labelId} onClick={() => editor.open()}>
          Edit
        </button>
      </div>
      <Show when={editor.text() !== null}>
        <RequestEditorDialog editor={editor} kept={kept.request} />
      </Show>
    </div>
  );
}

function RequestEditorDialog(props: { editor: RequestEditor; kept: SetupOpenState["request"] }) {
  let dialog!: HTMLDialogElement;
  let area!: HTMLTextAreaElement;
  const titleId = createUniqueId();
  onMount(() => {
    dialog.showModal();
    area.focus();
    // Opened again where the card was drawn again: the cursor goes back where it was.
    const caret = props.kept.caret ?? [area.value.length, area.value.length];
    area.setSelectionRange(caret[0], caret[1]);
  });
  const keepCaret = () => (props.kept.caret = [area.selectionStart, area.selectionEnd]);
  const close = (save: boolean) => {
    props.kept.caret = null;
    if (save) props.editor.save();
    else props.editor.cancel();
  };
  return (
    <dialog
      ref={dialog}
      class="design-request-dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
      onClick={(e) => e.target === dialog && close(false)}
    >
      <div class="sheet-grip" aria-hidden="true" />
      <div class="modal-head">
        <h2 class="modal-title" id={titleId}>
          What Do You Want to Design
        </h2>
      </div>
      <div class="design-request-dialog-body">
        <TextArea
          ref={area}
          class="design-request-field"
          inputClass="design-request-area"
          label="What Do You Want to Design"
          hideLabel
          value={props.editor.text() ?? ""}
          onInput={(text) => {
            props.editor.setText(text);
            keepCaret();
          }}
          onSelect={keepCaret}
          onKeyUp={keepCaret}
        />
        <p class="text-caption text-muted design-request-hint">Paste a link to use a page's images or its feel.</p>
      </div>
      <div class="modal-foot">
        <span class="modal-spacer" />
        <button type="button" class="button button-ghost" onClick={() => close(false)}>
          Cancel
        </button>
        <button type="button" class="button button-primary" onClick={() => close(true)}>
          Save
        </button>
      </div>
    </dialog>
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
function DesignDirectionPicker(props: { setup: SetupDraft; open: SetupOpenState }) {
  const draft = props.setup.draft;
  const change = props.setup.change;
  const opened = props.open.opened;
  const toggleOpen = props.open.toggle;
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

/** The effort mark beside a model's effort menu: the composer ring's bolt, drawn inline. */
const EffortBolt = () => (
  <svg class="design-effort-bolt" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">
    <path d="M13 3 5 14h6l-1 7 8-11h-6z" />
  </svg>
);

/**
 * The models: one closed row naming the designers (with each one's effort) and the Creative Director. Opened, it holds
 * the Creative Director menu and Find a model, then one closed row per provider the card lists; each opens its models
 * below itself, one full-width row each (its switch, its name, its effort menu at the right edge). Under the providers,
 * one quiet line names those left off and why, and the ones you hid, with Show.
 */
function DesignModelPicker(props: { setup: SetupDraft; run: DesignRunView; store: DesignStore; open: SetupOpenState; currentCoordinator?: string }) {
  const draft = props.setup.draft;
  const change = props.setup.change;
  const hidden = createMemo(() => props.run.hiddenSections ?? [], undefined, { equals: (a, b) => a.join("\n") === b.join("\n") });
  const byRef = createMemo(() => new Map(draft().models.map((m) => [m.ref, m])));
  const shown = createMemo(() => draft().models.filter((m) => !hidden().includes(designSectionOf(m.ref).id)));
  const sections = createMemo(() => designSections(draft().models, hidden()));
  // Keyed by id: a tick redraws a section's words, never its row, so focus and the open state stay put.
  const sectionIds = createMemo(() => sections().map((x) => x.id), undefined, { equals: (a, b) => a.join("\n") === b.join("\n") });
  const section = (id: string) => sections().find((x) => x.id === id);
  const opened = props.open.opened;
  const [query, setQuery] = createSignal("");
  const searching = () => !!query().trim();
  // While searching: each provider with a match, open, holding only what matched.
  const found = createMemo(() => new Set(searchModels(shown(), query()).map((m) => m.ref)));
  const summary = createMemo(() => modelsSummary({ models: shown() }));
  const quiet = createMemo(() => leftOutLine(props.run));
  const coordinator = () => draft().models.find((m) => m.coordinator);
  const [hideError, setHideError] = createSignal("");
  const panelId = createUniqueId();
  const providers = async (change: { hide?: string[]; show?: string[] }) => {
    setHideError("");
    try {
      // Your clicks first, so the card the server changes is the one you see.
      await props.setup.flush();
      let answer: unknown;
      for (const section of change.hide ?? []) answer = await props.store.api.hidden(props.run.id, section, true);
      for (const section of change.show ?? []) answer = await props.store.api.hidden(props.run.id, section, false);
      // The card as the server now holds it (a hidden provider's rows unticked, the Creative Director moved).
      props.setup.adopt(answer);
      props.store.refresh();
    } catch (e) {
      setHideError(e instanceof Error ? e.message : "That couldn't be changed. Try again.");
    }
  };

  const Row = (p: { model: string }) => {
    const m = () => byRef().get(p.model);
    return (
      <Show when={m()}>
        {(model) => (
          <li class="design-model-row">
            <Toggle
              switch
              class="design-model-toggle"
              label={
                <span class="design-model-name" title={model().ref}>
                  {designModelName(model())}
                  <Show when={!model().vision}>
                    <span class="text-muted design-model-note" title="This model can't read images. It works from a text outline of the page.">
                      {" "}
                      · text only
                    </span>
                  </Show>
                </span>
              }
              ariaLabel={`${designModelName(model())}: design`}
              checked={model().design}
              onChange={(on) => change(toggleModel(draft(), p.model, on))}
            />
            <Show when={designHasEfforts(model())}>
              <span class="design-model-effort" hidden={!model().design} title="Effort: how long it thinks before each page. More costs more.">
                <EffortBolt />
                <Select
                  class="design-effort-field"
                  selectClass="design-effort-select"
                  label={`Effort for ${designModelName(model())}`}
                  hideLabel
                  value={designEffortOf(model()) ?? ""}
                  options={[
                    ...(designEffortOf(model()) === null ? [{ value: "", label: "Its Own" }] : []),
                    ...(model().efforts ?? []).map((level) => ({ value: level, label: effortLabel(level) })),
                  ]}
                  onChange={(level) => change(setEffort(draft(), p.model, level))}
                />
              </span>
            </Show>
          </li>
        )}
      </Show>
    );
  };

  return (
    <div class="stack-2 design-models">
      <h4 class="design-setup-label">Models</h4>
      <div class="design-sections">
        <div class="design-section-head design-models-head">
          <button type="button" class="design-section-open design-models-open" aria-expanded={props.open.models() ? "true" : "false"} aria-controls={panelId} onClick={() => props.open.setModels(!props.open.models())}>
            <span class="design-models-sum">
              <span class="design-section-name design-models-names" title={summary().designers}>
                {/* Each designer kept whole, its separator held to it, so a phone's second line starts with a name. */}
                <For each={summary().designerList} fallback={summary().designers}>
                  {(name, i) => (
                    <>
                      {i() > 0 ? "\u00a0· " : ""}
                      <span class="design-models-one">{name}</span>
                    </>
                  )}
                </For>
              </span>
              <span class="text-caption text-muted design-models-coord">{summary().coordinator}</span>
            </span>
            <span class="design-section-count design-models-count">{summary().count}</span>
            <Icon name="chevron-down" small class="design-section-arrow" />
          </button>
        </div>
        <Show when={props.open.models()}>
          <div class="design-models-panel" id={panelId}>
            <div class="design-pick-bar">
              <div class="design-pick-coord">
                <span class="design-pick-coord-label">Creative Director</span>
                <ActionMenu
                  label={`Creative Director: ${coordinator() ? designModelName(coordinator()!) : "none"}`}
                  title="1 model coordinates the team. It can coordinate without designing."
                  text={coordinator() ? designModelName(coordinator()!) : "Pick a Model"}
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
                                  label={designModelName(m())}
                                  aria={`${designModelName(m())}${m().design ? ", designing" : ""}`}
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
            <For each={sectionIds()}>
              {(id) => {
                const sec = () => section(id);
                const refs = () => (searching() ? (sec()?.refs ?? []).filter((r) => found().has(r)) : (sec()?.refs ?? []));
                const isOpen = () => (searching() ? refs().length > 0 : opened().has(id));
                const gridId = createUniqueId();
                return (
                  <Show when={sec() && (!searching() || refs().length > 0)}>
                    <div class="design-section" role="group" aria-label={sec()!.name}>
                      <div class="design-section-head">
                        <button type="button" class="design-section-open" aria-expanded={isOpen() ? "true" : "false"} aria-controls={gridId} disabled={searching()} onClick={() => props.open.toggle(id)}>
                          <span class="design-section-name">{sec()!.name}</span>
                          <span class="design-section-ticked" title={sec()!.summary}>
                            {sec()!.summary}
                          </span>
                          <span class="design-section-count">{`${sec()!.on} of ${sec()!.count}`}</span>
                          <Icon name="chevron-down" small class="design-section-arrow" />
                        </button>
                        <Toggle
                          class="design-toggle-inline design-section-all"
                          label="All"
                          ariaLabel={`${sec()!.name}: all designing`}
                          checked={sec()!.on === sec()!.count}
                          mixed={sec()!.on > 0 && sec()!.on < sec()!.count}
                          onChange={(on) => change(toggleGroup(draft(), id, on))}
                        />
                      </div>
                      <Show when={isOpen()}>
                        <div class="design-provider-panel" id={gridId}>
                          <ul class="design-model-list" aria-label={`${sec()!.name} models`}>
                            <For each={refs()}>{(ref) => <Row model={ref} />}</For>
                          </ul>
                          <Show when={!searching()}>
                            <div class="design-provider-foot">
                              <button
                                type="button"
                                class="button button-ghost button-sm"
                                data-holds-view=""
                                title={`Leave ${sec()!.name} off this card and later ones. Show brings it back.`}
                                onClick={() => void providers({ hide: [id] })}
                              >
                                Hide {sec()!.name}
                              </button>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </Show>
                );
              }}
            </For>
            <Show when={searching() && found().size === 0}>
              <p class="text-caption text-muted design-models-quiet">No model matches “{query().trim()}”.</p>
            </Show>
            <Show when={quiet().text || quiet().hidden || hideError()}>
              <p class="text-caption text-muted design-models-quiet">
                <Show when={hideError()}>
                  <span class="field-error" role="alert">
                    {hideError()}{" "}
                  </span>
                </Show>
                {quiet().text}
                <Show when={quiet().hidden}>
                  {quiet().text ? " " : ""}
                  {quiet().hidden} ·{" "}
                  <button type="button" class="design-models-show" data-holds-view="" onClick={() => void providers({ show: hidden() })}>
                    Show
                  </button>
                </Show>
              </p>
            </Show>
          </div>
        </Show>
      </div>
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
