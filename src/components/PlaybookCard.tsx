import { createEffect, createMemo, createSignal, createUniqueId, For, Index, onCleanup, Show, type JSX } from "solid-js";
import type { PlaybookCardEdits, PlaybookChoiceView, PlaybookModelPick, PlaybookRoleView, PlaybookRunView, PlaybookStepView } from "../../shared/playbook-run";
import {
  cardChip,
  cardEyebrow,
  chainRest,
  cycleLine,
  foldedLine,
  fromPick,
  hasEdits,
  helpersLine,
  isEmpty,
  listValue,
  stackEdits,
  ORIGIN_LABEL,
  pickLine,
  roleModelLine,
  roleTitle,
  roleWhy,
  splitChoices,
  stepRunsLine,
  stepsSummary,
  toPick,
} from "../lib/playbook-card";
import type { PlaybookRunsStore } from "../lib/playbook-runs";
import { ApiError } from "../lib/api";
import { sessionHrefOn } from "../lib/mesh";
import { providerName } from "../lib/cost-history";
import { announce } from "../lib/ui-state";
import { ModelPickButton } from "./ModelPickButton";
import { Chip, Icon } from "./ui";
import "./PlaybookCard.css";

/** How long typing waits before the card saves its draft. */
const TYPE_SAVE_MS = 400;

/** Each card's fold, by run id, for the page's lifetime: a redraw never reopens a card you folded. */
const folds = new Map<string, boolean>();

/** The card a way in last asked to show: it opens, scrolls into the dock's view and takes focus. */
const [revealed, setRevealed] = createSignal<{ id: string } | null>(null, { equals: false });

/** Opens a run's card and brings it into view (a /name or a Playbooks dialog pick). */
export function showPlaybookCard(id: string): void {
  folds.set(id, false);
  setRevealed({ id });
}

/**
 * The chat's playbook cards, docked above the message box (al_2 a16): newest first, each folding to
 * one line. Drafts open; a started run's record folds until you open it.
 */
export function PlaybookDock(props: { store: PlaybookRunsStore; host: string | null }) {
  return (
    <Show when={props.store.runs().length > 0}>
      <section class="pb-dock" aria-label="Playbooks">
        <For each={props.store.runs()}>{(run) => <PlaybookCard run={run} store={props.store} host={props.host} />}</For>
      </section>
    </Show>
  );
}

/**
 * One playbook's card. Before Start it is the run's plan, editable: your choices, who runs on which
 * model, the steps and their stops, the cycle settings and a note per role. Every edit saves the
 * draft as a new revision; Start runs exactly the revision the card shows. After Start the same card
 * is the run's record, read-only.
 */
export function PlaybookCard(props: { run: PlaybookRunView; store: PlaybookRunsStore; host: string | null }) {
  const uid = createUniqueId();
  const id = (s: string) => `pb-${uid}-${s}`;
  const run = () => props.run;
  const editable = () => run().state === "draft";
  const [folded, setFolded] = createSignal(folds.get(props.run.id) ?? props.run.state !== "draft");
  const fold = (v: boolean) => {
    folds.set(run().id, v);
    setFolded(v);
  };
  let foldButton: HTMLButtonElement | undefined;
  createEffect(() => {
    const r = revealed();
    if (!r || r.id !== props.run.id) return;
    setRevealed(null);
    fold(false);
    requestAnimationFrame(() => {
      foldButton?.scrollIntoView({ block: "nearest" });
      foldButton?.focus({ preventScroll: true });
    });
  });

  // ---- Edits: what you changed shows at once; it saves after a pause, as one revision. ----
  /** Changed here, not sent yet. */
  const [pending, setPending] = createSignal<PlaybookCardEdits>({});
  /** Sent, its answer not back yet. */
  const [inflight, setInflight] = createSignal<PlaybookCardEdits>({});
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<"start" | "defaults" | "close" | null>(null);
  const [done, setDone] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<void> | null = null;
  onCleanup(() => clearTimeout(timer));

  const shown = () => stackEdits(inflight(), pending());
  const flush = async (): Promise<void> => {
    clearTimeout(timer);
    if (sending) await sending;
    const batch = pending();
    if (!hasEdits(batch)) return;
    setPending({});
    setInflight(batch);
    sending = (async () => {
      try {
        await props.store.edit(run().id, run().revision, batch);
        setSaveError(null);
      } catch (e) {
        // Only a stale revision is retried: its refusal brought the newer view, and what you changed
        // goes again on top of it, once, and the card says so.
        if (!(e instanceof ApiError && e.status === 409)) {
          setPending((p) => stackEdits(batch, p));
          setSaveError(`Your change wasn't saved: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        try {
          await props.store.edit(run().id, run().revision, batch);
          setSaveError(null);
          setDone("The card changed in another tab; your change was added on top.");
        } catch {
          setPending((p) => stackEdits(batch, p));
          setSaveError(`Your change wasn't saved: ${e instanceof Error ? e.message : String(e)}`);
        }
      } finally {
        setInflight({});
        sending = null;
      }
    })();
    await sending;
  };
  const queue = (edits: PlaybookCardEdits, delay = 0) => {
    setPending((p) => stackEdits(p, edits));
    setDone(null);
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), delay);
  };

  const choiceValue = (c: PlaybookChoiceView): unknown => {
    const e = shown().choices;
    return e && c.id in e ? e[c.id] : c.value;
  };
  const roleEdit = (r: PlaybookRoleView) => shown().roles?.[r.id];
  const roleOn = (r: PlaybookRoleView) => roleEdit(r)?.on ?? r.on;
  const roleNote = (r: PlaybookRoleView) => roleEdit(r)?.note ?? r.note;
  const stopOn = (s: PlaybookStepView) => shown().stops?.[s.id] ?? s.stopOn;
  const cycleMax = () => shown().cycle?.max ?? run().cycle?.max ?? 1;
  const cycleAsk = () => shown().cycle?.askEvery ?? run().cycle?.askEvery ?? 1;
  const cycleUntil = () => shown().cycle?.until ?? run().cycle?.until ?? "rule";

  const changing = () => hasEdits(shown()) || !!sending;
  const startWhy = () =>
    run().state === "starting" ? "Starting…" : !editable() ? null : busy() ? "Wait for the card to finish." : run().startBlocked;

  const start = async () => {
    if (!editable() || busy()) return;
    setBusy("start");
    try {
      await flush();
      if (run().startBlocked) return;
      // The revision you see is the revision that runs.
      await props.store.start(run().id, run().revision);
      announce(`${run().playbook.title} started.`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const saveDefaults = async () => {
    if (busy()) return;
    setBusy("defaults");
    try {
      await flush();
      await props.store.saveDefaults(run().id, run().revision);
      setDone("Saved as your defaults for this playbook.");
      announce("Saved as your defaults.");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const close = async () => {
    if (busy()) return;
    setBusy("close");
    clearTimeout(timer);
    try {
      await props.store.close(run().id);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const chip = () => (run().state === "starting" ? { label: "Starting", tone: "accent" as const } : cardChip(run()));
  const choices = createMemo(() => splitChoices(run().choices));

  return (
    <article class="card pb-card" data-run={run().id} aria-labelledby={id("title")} data-state={run().state} data-folded={folded() ? "" : undefined}>
      <header class="pb-head">
        <button
          ref={foldButton}
          type="button"
          class="pb-fold"
          aria-expanded={!folded()}
          aria-controls={id("body")}
          onClick={() => fold(!folded())}
          title={folded() ? "Open the card" : "Fold the card to one line"}
        >
          <Icon name="chevron-right" small class="icon-twist" />
          <span class="pb-head-text">
            <span class="pb-eyebrow">{cardEyebrow(run())}</span>
            <span class="pb-title-line">
              <span class="pb-title" id={id("title")}>
                {run().playbook.title}
              </span>
              <Show when={folded()}>
                <span class="pb-folded-line">{foldedLine(run())}</span>
              </Show>
            </span>
          </span>
        </button>
        <Chip tone={chip().tone}>{chip().label}</Chip>
      </header>

      <Show when={!folded()}>
        <div class="pb-body" id={id("body")}>
          <Show when={run().playbook.summary}>{(s) => <p class="pb-summary">{s()}</p>}</Show>

          <Show when={run().state !== "draft" && run().started}>
            {(st) => (
              <p class="pb-record">
                Started {new Date(st().at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} as revision{" "}
                <span class="text-num">{st().revision}</span>
                {st().newChat ? (
                  <>
                    {" "}
                    in <a href={sessionHrefOn(props.host, st().chat.path)}>{st().chat.title || "a new chat"}</a>.
                  </>
                ) : (
                  " in this chat."
                )}{" "}
                Progress comes in the chat's messages.
              </p>
            )}
          </Show>

          {/* Your choices */}
          <Show when={run().choices.length > 0}>
            <section class="pb-section" aria-labelledby={id("choices")}>
              <h4 class="pb-section-label" id={id("choices")}>
                Your choices
              </h4>
              <For each={choices().shown}>{(c) => <ChoiceRow choice={c} value={choiceValue(c)} editable={editable()} onChange={(v, delay) => queue({ choices: { [c.id]: v } }, delay)} />}</For>
              <Show when={choices().more.length > 0}>
                <details class="pb-more">
                  <summary class="pb-more-summary">
                    <Icon name="chevron-right" small class="icon-twist" />
                    More options · <span class="text-num">{choices().more.length}</span>
                  </summary>
                  <For each={choices().more}>{(c) => <ChoiceRow choice={c} value={choiceValue(c)} editable={editable()} onChange={(v, delay) => queue({ choices: { [c.id]: v } }, delay)} />}</For>
                </details>
              </Show>
            </section>
          </Show>

          {/* Who runs */}
          <section class="pb-section" aria-labelledby={id("cast")}>
            <h4 class="pb-section-label" id={id("cast")}>
              Who runs
            </h4>
            <For each={run().roles}>
              {(r) => (
                <RoleRow
                  role={r}
                  on={roleOn(r)}
                  note={roleNote(r)}
                  pick={roleEdit(r)?.pick}
                  editable={editable()}
                  onPick={(pick) => queue({ roles: { [r.id]: { pick } } })}
                  onOn={(on) => queue({ roles: { [r.id]: { on } } })}
                  onNote={(note) => queue({ roles: { [r.id]: { note } } }, TYPE_SAVE_MS)}
                />
              )}
            </For>
            <For each={run().teams}>
              {(t) => (
                <div class="pb-team">
                  <p class="pb-team-head">
                    Team <strong>{t.label}</strong>: {t.roles.map((rid) => run().roles.find((r) => r.id === rid)).filter(Boolean).map((r) => roleTitle(r!)).join(", ")}
                  </p>
                  <div class="pb-row pb-row-standing">
                    <span class="pb-row-label">Coordinator</span>
                    <span class="pb-row-value">{[t.coordinator.modelLabel, t.coordinator.effort].filter(Boolean).join(" · ")}</span>
                    <span class="pb-row-origin">Team defaults</span>
                  </div>
                  <div class="pb-row pb-row-standing">
                    <span class="pb-row-label">Monitor</span>
                    <span class="pb-row-value">{[t.monitor.modelLabel, t.monitor.effort].filter(Boolean).join(" · ")}</span>
                    <span class="pb-row-origin">Team defaults</span>
                  </div>
                </div>
              )}
            </For>
            <p class="pb-note">{helpersLine(run().helpers)}</p>
          </section>

          {/* Steps */}
          <details class="pb-section pb-steps" open>
            <summary class="pb-more-summary pb-section-label">
              <Icon name="chevron-right" small class="icon-twist" />
              {stepsSummary(run().steps.map((s) => ({ ...s, stopOn: stopOn(s) })))}
            </summary>
            <ol class="pb-step-list">
              <Index each={run().steps}>
                {(s, i) => (
                  <li class="pb-step" data-cycle={s().cycle ? "" : undefined}>
                    <span class="pb-step-n text-num">{i + 1}</span>
                    <span class="pb-step-text">
                      <span class="pb-step-title">{s().title}</span>
                      <span class="pb-step-runs">{stepRunsLine(s(), run().roles, run().teams)}</span>
                    </span>
                    <span class="pb-step-stop">
                      <Show when={s().stop === "always"}>
                        <Chip>Stops for you</Chip>
                      </Show>
                      <Show when={s().stop === "optional"}>
                        <label class="toggle pb-toggle">
                          <input type="checkbox" checked={stopOn(s())} disabled={!editable()} onChange={(e) => queue({ stops: { [s().id]: e.currentTarget.checked } })} />
                          <span class="toggle-box" aria-hidden="true" />
                          <span>Stop for me here</span>
                        </label>
                      </Show>
                    </span>
                  </li>
                )}
              </Index>
            </ol>
            <Show when={run().cycle}>
              {(c) => (
                <div class="pb-cycle">
                  <Show when={editable()} fallback={<p class="pb-note">{cycleLine({ ...c(), max: cycleMax(), askEvery: cycleAsk() })}</p>}>
                    <p class="pb-cycle-line">
                      <span>Steps {c().steps.map((sid) => run().steps.findIndex((s) => s.id === sid) + 1).filter((n) => n > 0).join(", ")} repeat as a cycle: up to</span>
                      <NumberBox id={id("cycle-max")} label="Most cycles" value={cycleMax()} min={1} max={c().maxCap} onChange={(n) => queue({ cycle: { max: n } }, TYPE_SAVE_MS)} />
                      <span>
                        cycles, at most <span class="text-num">{c().maxCap}</span>; asks you after every
                      </span>
                      <NumberBox id={id("cycle-ask")} label="Cycles before it asks you" value={cycleAsk()} min={1} max={cycleMax()} onChange={(n) => queue({ cycle: { askEvery: n } }, TYPE_SAVE_MS)} />
                      <span>{cycleAsk() === 1 ? "cycle." : "cycles."}</span>
                    </p>
                  </Show>
                  <Show when={c().rule}>
                    {(rule) => (
                      <Show when={editable()} fallback={<p class="pb-note">{cycleUntil() === "rule" ? `Stops early when ${rule()}` : "Runs every cycle, whatever the stop rule says."}</p>}>
                        <p class="pb-cycle-line">
                          <label for={id("cycle-until")}>Keep going until</label>
                          <span class="select-wrap pb-until">
                            <select id={id("cycle-until")} class="select" onChange={(e) => queue({ cycle: { until: e.currentTarget.value as "rule" | "max" } })}>
                              <option value="rule" selected={cycleUntil() === "rule"}>
                                the stop rule is met
                              </option>
                              <option value="max" selected={cycleUntil() === "max"}>
                                all cycles have run
                              </option>
                            </select>
                            <span class="select-caret" aria-hidden="true">
                              ▾
                            </span>
                          </span>
                        </p>
                        <p class="pb-note">The stop rule: {rule()}</p>
                      </Show>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </details>

          {/* How it runs */}
          <section class="pb-section" aria-labelledby={id("how")}>
            <h4 class="pb-section-label" id={id("how")}>
              How it runs
            </h4>
            <p class="pb-how">{run().howItRuns}</p>
            <Show when={run().commands.length > 0}>
              <p class="pb-note">May also run these Sova commands: {run().commands.join(", ")}.</p>
            </Show>
          </section>

          <Show when={saveError() ?? run().startError ?? run().error}>
            {(err) => (
              <p class="pb-error" role="alert">
                {err()}
              </p>
            )}
          </Show>

          <Show when={run().state !== "started"}>
            <footer class="pb-foot">
              <button
                type="button"
                class="button button-sm button-primary"
                aria-disabled={startWhy() ? "true" : undefined}
                aria-describedby={id("why")}
                title={startWhy() ?? undefined}
                onClick={() => void start()}
              >
                {busy() === "start" || run().state === "starting" ? "Starting…" : "Start"}
              </button>
              <button type="button" class="button button-sm" disabled={!!busy() || !editable()} onClick={() => void saveDefaults()}>
                {busy() === "defaults" ? "Saving…" : "Save as My Defaults"}
              </button>
              <button type="button" class="button button-sm button-ghost" aria-disabled="true" title="Repeats come in a later release.">
                Repeat…
              </button>
              <span class="pb-foot-hint" id={id("why")}>
                {startWhy() ?? done() ?? (changing() ? "Saving your changes…" : `Revision ${run().revision}. Start runs exactly this card.`)}
              </span>
              <button type="button" class="button button-sm button-ghost pb-close" disabled={!!busy() || !editable()} onClick={() => void close()}>
                Close Card
              </button>
            </footer>
          </Show>
        </div>
      </Show>
    </article>
  );
}

/** A small number box inside a sentence; it keeps what was typed and saves a whole number in range. */
function NumberBox(props: { id: string; label: string; value: number; min: number; max: number; onChange(n: number): void }) {
  return (
    <>
      <label class="visually-hidden" for={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        class="input text-num pb-num"
        type="number"
        inputmode="numeric"
        min={props.min}
        max={props.max}
        value={props.value}
        onInput={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isInteger(n) && n >= props.min && n <= props.max) props.onChange(n);
        }}
      />
    </>
  );
}

/** One of your choices: its label, its control (or its value, after Start) and where the value came from. */
function ChoiceRow(props: { choice: PlaybookChoiceView; value: unknown; editable: boolean; onChange(value: unknown, delay?: number): void }) {
  const cid = `pbc-${createUniqueId()}`;
  const c = () => props.choice;
  const empty = () => c().required && isEmpty(props.value);
  const control = (): JSX.Element => {
    const ch = c();
    switch (ch.type) {
      case "toggle":
        return (
          <label class="toggle pb-toggle">
            <input id={cid} type="checkbox" checked={!!props.value} onChange={(e) => props.onChange(e.currentTarget.checked)} />
            <span class="toggle-box" aria-hidden="true" />
            <span>{props.value ? "On" : "Off"}</span>
          </label>
        );
      case "number":
        return (
          <input
            id={cid}
            class="input text-num pb-num"
            type="number"
            inputmode="numeric"
            min={ch.min}
            max={ch.max}
            value={typeof props.value === "number" ? props.value : ""}
            onInput={(e) => {
              const raw = e.currentTarget.value;
              props.onChange(raw === "" ? null : Number(raw), TYPE_SAVE_MS);
            }}
          />
        );
      case "choice":
        return (
          <div class="select-wrap">
            <select id={cid} class="select" onChange={(e) => props.onChange(e.currentTarget.value || null)}>
              <Show when={isEmpty(props.value)}>
                <option value="">Pick one</option>
              </Show>
              <For each={ch.options ?? []}>
                {(o) => (
                  <option value={o.value} selected={o.value === props.value}>
                    {o.label}
                  </option>
                )}
              </For>
            </select>
            <span class="select-caret" aria-hidden="true">
              ▾
            </span>
          </div>
        );
      case "multi":
        return (
          <span class="pb-multi" role="group" aria-labelledby={`${cid}-label`}>
            <For each={ch.options ?? []}>
              {(o) => (
                <label class="toggle pb-toggle">
                  <input
                    type="checkbox"
                    checked={listValue(props.value).includes(o.value)}
                    onChange={(e) => {
                      const now = listValue(props.value).filter((v) => v !== o.value);
                      props.onChange(e.currentTarget.checked ? [...now, o.value] : now);
                    }}
                  />
                  <span class="toggle-box" aria-hidden="true" />
                  <span>{o.label}</span>
                </label>
              )}
            </For>
          </span>
        );
      case "list":
        return (
          <textarea
            id={cid}
            class="input textarea pb-list"
            rows={Math.min(6, Math.max(2, listValue(props.value).length + 1))}
            placeholder="One per line"
            value={listValue<string>(props.value).join("\n")}
            onInput={(e) =>
              props.onChange(
                e.currentTarget.value
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean),
                TYPE_SAVE_MS,
              )
            }
          />
        );
      case "models":
        return <ModelsControl id={cid} label={ch.label} value={listValue<PlaybookModelPick>(props.value)} onChange={(v) => props.onChange(v)} />;
      default:
        return (
          <input id={cid} class="input pb-text" type="text" value={typeof props.value === "string" ? props.value : ""} onInput={(e) => props.onChange(e.currentTarget.value, TYPE_SAVE_MS)} />
        );
    }
  };
  return (
    <div class="pb-row" data-empty={empty() ? "" : undefined}>
      <Show when={props.editable && c().type !== "multi" && c().type !== "models"} fallback={<span class="pb-row-label" id={`${cid}-label`}>{c().label}</span>}>
        <label class="pb-row-label" for={cid} id={`${cid}-label`}>
          {c().label}
        </label>
      </Show>
      <span class="pb-row-value">
        <Show when={props.editable} fallback={<span>{valueText(c(), props.value)}</span>}>
          {control()}
        </Show>
        <Show when={c().help}>{(h) => <span class="pb-row-help">{h()}</span>}</Show>
      </span>
      <span class="pb-row-origin">{empty() ? "Needed" : ORIGIN_LABEL[c().origin]}</span>
    </div>
  );
}

/** A choice's value as the run's record says it. */
function valueText(c: PlaybookChoiceView, v: unknown): string {
  if (isEmpty(v)) return "None";
  if (c.type === "toggle") return v ? "On" : "Off";
  if (c.type === "choice") return c.options?.find((o) => o.value === v)?.label ?? String(v);
  if (c.type === "multi") return listValue(v).map((x) => c.options?.find((o) => o.value === x)?.label ?? String(x)).join(", ");
  if (c.type === "models") return listValue<PlaybookModelPick>(v).map((p) => pickLine(p)).join(", ");
  if (c.type === "list") return listValue(v).join(", ");
  return String(v);
}

/** A set of models: each a removable chip, and Add Model. */
function ModelsControl(props: { id: string; label: string; value: PlaybookModelPick[]; onChange(v: PlaybookModelPick[]): void }) {
  return (
    <span class="pb-models">
      <Index each={props.value}>
        {(p, i) => (
          <span class="pb-model-chip">
            <span>{pickLine(p())}</span>
            <button
              type="button"
              class="pb-model-remove"
              aria-label={`Remove ${pickLine(p())} from ${props.label}`}
              onClick={() => props.onChange(props.value.filter((_, j) => j !== i))}
            >
              <Icon name="close" small />
            </button>
          </span>
        )}
      </Index>
      <ModelPickButton id={props.id} label="Add Model" ariaLabel={`Add a model to ${props.label}`} value={null} onPick={(pick) => props.onChange([...props.value, fromPick(pick)])} />
    </span>
  );
}

/** One role in Who runs: its model and why, on or off when it's optional, View Prompt and its note. */
function RoleRow(props: {
  role: PlaybookRoleView;
  on: boolean;
  note: string;
  pick: PlaybookModelPick | null | undefined;
  editable: boolean;
  onPick(pick: PlaybookModelPick | null): void;
  onOn(on: boolean): void;
  onNote(note: string): void;
}) {
  const rid = `pbr-${createUniqueId()}`;
  const [promptOpen, setPromptOpen] = createSignal(false);
  const r = () => props.role;
  /** What the row shows as its model: your pick while it saves, else the resolved one. */
  const modelText = () => (props.pick ? pickLine(props.pick) : roleModelLine(r()));
  const off = () => r().optional && !props.on;
  return (
    <div class="pb-row pb-role" data-off={off() ? "" : undefined} data-blocked={!r().runnable ? "" : undefined}>
      <span class="pb-row-label">
        {roleTitle(r())}
        <Show when={r().per}>{(per) => <span class="pb-row-help">{per()}</span>}</Show>
      </span>
      <span class="pb-row-value">
        <span class="pb-model" title={chainRest(r()) ?? undefined}>
          {off() ? "Off for this run" : modelText()}
        </span>
        <Show when={props.editable && !off()}>
          <Show
            when={r().only}
            fallback={
              <ModelPickButton
                id={`${rid}-model`}
                label="Change"
                ariaLabel={`Change the model for ${r().label}`}
                value={toPick(props.pick ?? (r().resolved ? { model: r().resolved!.model, effort: r().resolved!.effort } : null))}
                onPick={(pick) => props.onPick(fromPick(pick))}
              />
            }
          >
            <span class="select-wrap pb-only-select">
              <label class="visually-hidden" for={`${rid}-only`}>
                Model for {r().label}, only these
              </label>
              <select
                id={`${rid}-only`}
                class="select"
                onChange={(e) => {
                  const m = r().models[Number(e.currentTarget.value)];
                  if (m) props.onPick({ model: m.model, ...(m.effort ? { effort: m.effort } : {}) });
                }}
              >
                <For each={r().models}>
                  {(m, i) => (
                    <option value={i()} disabled={!m.usable} selected={m.model === (props.pick?.model ?? r().resolved?.model)}>
                      {[m.label, providerName(m.provider), m.effort].filter(Boolean).join(" · ")}
                      {m.usable ? "" : ` (${m.why ?? "can't run"})`}
                    </option>
                  )}
                </For>
              </select>
              <span class="select-caret" aria-hidden="true">
                ▾
              </span>
            </span>
          </Show>
        </Show>
      </span>
      <span class="pb-row-origin">{off() ? "" : roleWhy(r())}</span>
      <span class="pb-role-actions">
        <Show when={r().optional && props.editable}>
          <label class="toggle pb-toggle">
            <input type="checkbox" checked={props.on} onChange={(e) => props.onOn(e.currentTarget.checked)} aria-label={`${r().label} runs`} />
            <span class="toggle-box" aria-hidden="true" />
            <span>Runs</span>
          </label>
        </Show>
        <button type="button" class="button button-sm button-ghost" aria-expanded={promptOpen()} aria-controls={`${rid}-prompt`} onClick={() => setPromptOpen(!promptOpen())}>
          {promptOpen() ? "Hide Prompt" : "View Prompt"}
        </button>
      </span>
      <Show when={promptOpen()}>
        <div class="pb-prompt" id={`${rid}-prompt`}>
          <pre class="pb-prompt-text">{r().prompt || "No prompt of its own: it gets Sova's standard conductor instructions."}</pre>
          <Show when={props.editable} fallback={<Show when={props.note}>{(n) => <p class="pb-note">Note for this run: {n()}</p>}</Show>}>
            <label class="field-label" for={`${rid}-note`}>
              Note for this run
            </label>
            <textarea id={`${rid}-note`} class="input textarea pb-role-note" rows={2} value={props.note} placeholder="Added after its prompt, for this run only" onInput={(e) => props.onNote(e.currentTarget.value)} />
          </Show>
        </div>
      </Show>
    </div>
  );
}
