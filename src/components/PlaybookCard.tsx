import { createContext, createEffect, createMemo, createSignal, createUniqueId, For, Index, Match, onCleanup, onMount, Show, Switch, type Accessor, type JSX } from "solid-js";
import type { PlaybookCardEdits, PlaybookChoiceView, PlaybookModelPick, PlaybookRoleView, PlaybookRunView, PlaybookStepView } from "../../shared/playbook-run";
import {
  cardEyebrow,
  chatCard,
  chainRest,
  cycleLine,
  cycleStepsLine,
  shortClock,
  fromPick,
  hasEdits,
  answerFoldLabel,
  isFreeText,
  helpersLine,
  isEmpty,
  listValue,
  stackEdits,
  ORIGIN_LABEL,
  pickLine,
  roleModelLine,
  roleTitle,
  roleWhy,
  RUN_ANSWERS,
  controlLabel,
  runStatus,
  type RunChatNow,
  type RunStatus,
  splitChoices,
  stepRunsLine,
  stepsSummary,
  stripLine,
  toPick,
  revealStep,
} from "../lib/playbook-card";
import type { PlaybookRunsStore } from "../lib/playbook-runs";
import { ApiError } from "../lib/api";
import { sessionHrefOn } from "../lib/mesh";
import { providerName } from "../lib/cost-history";
import { announce, toast } from "../lib/ui-state";
import { ModelPickButton } from "./ModelPickButton";
import { NumberField, Select, TextArea, TextField, Toggle } from "./form";
import { Chip, Icon } from "./ui";
import "./PlaybookCard.css";

/** How long typing waits before the card saves its draft. */
const TYPE_SAVE_MS = 400;

/** The card a way in last asked to show (a /name, a Playbooks pick, Open Card on the run's entry),
    with the pane it was asked from when it knows one. */
const [revealed, setRevealed] = createSignal<{ id: string; store?: PlaybookRunsStore | null } | null>(null, { equals: false });

/** Opens a run's card over the conversation: in the pane whose store is given (the one clicked), else
    in whichever chat shows that run. */
export function showPlaybookCard(id: string, store?: PlaybookRunsStore | null): void {
  setRevealed({ id, store });
}

/** The card to open in a chat once that chat shows it, by the chat's path. */
const arrivals = new Map<string, string>();
/** Opens a run's card in the chat at `path` when that chat next shows it. */
export function openCardOnArrival(path: string, id: string): void {
  arrivals.set(path, id);
}

/** The chat's playbook runs, for its conversation's rows (Open Card on a run's entry): so a click
    opens the card in that pane, never in another pane showing the same run. */
export const PlaybookRunsContext = createContext<PlaybookRunsStore | null>(null);

/** One chat's cards: which is open (one at a time) and which have been opened, so each keeps what
    was typed, an open prompt and its place while it is minimized. */
interface FloatState {
  open: Accessor<string | null>;
  mounted: Accessor<string[]>;
  show(id: string | null): void;
}
const floats = new WeakMap<PlaybookRunsStore, FloatState>();
function floatOf(store: PlaybookRunsStore): FloatState {
  let f = floats.get(store);
  if (f) return f;
  const [open, setOpen] = createSignal<string | null>(null);
  const [mounted, setMounted] = createSignal<string[]>([]);
  f = {
    open,
    mounted,
    show: (id) => {
      if (id && !mounted().includes(id)) setMounted([...mounted(), id]);
      setOpen(id);
    },
  };
  floats.set(store, f);
  return f;
}

const cardDomId = (run: string) => `pb-card-${run}`;
const sameIds = { equals: (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]) };

/** What the chat showing the cards knows of itself, for a run it conducts. */
export interface PlaybookChatNow {
  /** This chat's session path. */
  path: string;
  now: Accessor<RunChatNow>;
}

/** The reading of the conducting chat a run's status may use: this chat's own, for a run it conducts. */
const nowFor = (run: PlaybookRunView, chat: PlaybookChatNow): RunChatNow | null => (run.state === "started" && run.started?.chat.path === chat.path ? chat.now() : null);

/** Sends one of a stop's answers as the person's message to this chat, and why it can't now. */
export interface PlaybookAnswer {
  send(text: string): boolean;
  blocked: Accessor<string | null>;
}

/** Sends a stop's answer, unless what stops Send stops it; says so aloud when it went. */
function sendAnswer(answer: PlaybookAnswer | undefined, text: string): boolean {
  if (!answer || answer.blocked() || !answer.send(text)) return false;
  announce(`Sent "${text}" to this chat.`);
  return true;
}

/**
 * One run, closed: a strip with its name, its state (dot and word) and one line under them. The
 * whole strip opens the card; while the run waits for you it also carries the two answers, which
 * are buttons of their own beside the opener, never inside it.
 */
function RunStrip(props: { run: PlaybookRunView; chat: PlaybookChatNow; answer?: PlaybookAnswer; onOpen(): void }) {
  const lineId = `pb-strip-line-${createUniqueId()}`;
  const run = () => props.run;
  const status = createMemo(() => runStatus(run(), nowFor(run(), props.chat)));
  const line = () => stripLine(run(), status(), props.chat.path);
  return (
    <div class="pb-strip" data-run={run().id} data-state={run().state}>
      <button
        type="button"
        class="pb-strip-open"
        data-run={run().id}
        aria-haspopup="dialog"
        aria-controls={cardDomId(run().id)}
        aria-label={controlLabel(run().playbook.title, status())}
        aria-describedby={lineId}
        title={line()}
        onClick={() => props.onOpen()}
      >
        <Icon name="activity" small />
        <span class="pb-strip-text">
          <span class="pb-strip-head">
            <span class="pb-strip-title">{run().playbook.title}</span>
            <Chip tone={status().tone} live={status().live}>
              {status().label}
            </Chip>
          </span>
          <span class="pb-strip-line" id={lineId}>
            {line()}
          </span>
        </span>
      </button>
      <Show when={status().answer && props.answer}>
        {(a) => (
          <span class="pb-strip-answers">
            <For each={RUN_ANSWERS}>
              {(ans) => (
                <button
                  type="button"
                  // Never filled here: the view's one filled button is Send's (or the open card's).
                  class="button button-sm"
                  aria-disabled={a().blocked() ? "true" : undefined}
                  title={a().blocked() ?? `Sends "${ans.text}" as your message to this chat.`}
                  onClick={() => sendAnswer(a(), ans.text)}
                >
                  {ans.label}
                </button>
              )}
            </For>
          </span>
        )}
      </Show>
      <Icon name="chevron-right" small class="pb-strip-chevron" />
    </div>
  );
}

/** Room kept between the strips and what sits above them (the conversation's end, Jump to Latest). */
const STRIP_GAP = 8;

/**
 * The chat's playbook run, floating over the end of the conversation just above the message box
 * (Lookbook design A): the run as one strip, and its card opening upward from the strip's place, at the
 * message box's width. Mounted between the thread and the message box as an anchor of no height, so
 * nothing here moves or resizes the conversation, and it is in reach wherever the conversation is
 * scrolled. The conversation's end leaves room for the strips, so its last row is never under them.
 * One card shows at a time, in the strips' place; a card that was opened stays mounted while
 * minimized, so an edit in flight, an open prompt and focus survive.
 */
export function PlaybookFloat(props: { store: PlaybookRunsStore; host: string | null; chat: PlaybookChatNow; answer?: PlaybookAnswer }) {
  const float = floatOf(props.store);
  let anchor!: HTMLDivElement;
  let strips!: HTMLDivElement;
  // A chat runs one playbook at most, so one strip: the run it started or conducts, else its draft.
  // Keyed by run id, never by the view object: a new view of a run updates its strip in place.
  const ids = createMemo(() => [chatCard(props.store.runs())?.id].filter((id): id is string => !!id), undefined, sameIds);
  const runOf = (id: string) => props.store.runs().find((r) => r.id === id);
  const mounted = createMemo(() => float.mounted().filter((id) => !!runOf(id)), undefined, sameIds);
  const focusCard = (id: string) => requestAnimationFrame(() => anchor.querySelector<HTMLElement>(`#${CSS.escape(cardDomId(id))}`)?.focus({ preventScroll: true }));
  const open = (id: string) => {
    float.show(id);
    // The strip leaves while its card is open: focus goes to the card, where Esc minimizes.
    focusCard(id);
  };
  const minimize = (id: string) => {
    float.show(null);
    // Back to its strip, as a popover returns focus to its trigger.
    anchor.querySelector<HTMLElement>(`.pb-strip-open[data-run="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  };
  // A card asked for from another chat (a playbook picked where a run already holds the chat): it
  // opens here once this chat's cards have it.
  createEffect(() => {
    const want = arrivals.get(props.chat.path);
    if (!want || !runOf(want)) return;
    arrivals.delete(props.chat.path);
    open(want);
  });
  /** A started run that was put away, opened from its row in the conversation: its record, with no
      strip of its own. */
  const [record, setRecord] = createSignal<PlaybookRunView | null>(null);
  createEffect(() => {
    const r = revealed();
    if (!r) return;
    const step = revealStep(r, props.store, !!runOf(r.id));
    // Asked from another pane: that pane's cards answer it.
    if (step === "skip") return;
    if (step === "open") {
      setRevealed(null);
      setRecord(null);
      open(r.id);
      return;
    }
    const readRecord = () => {
      if (revealed() !== r) return;
      setRevealed(null);
      props.store.record(r.id).then(
        (view) => {
          float.show(null);
          setRecord(view);
          focusCard(view.id);
        },
        () => {
          toast("That run's card isn't here any more.");
          announce("That run's card isn't here any more.");
        },
      );
    };
    // Asked from this pane: its record, here. Asked from nowhere in particular: once every chat on
    // the page has had its look.
    if (step === "record") readRecord();
    else queueMicrotask(readRecord);
  });
  // One card at a time: opening a card from its strip puts the record away.
  createEffect(() => {
    if (float.open()) setRecord(null);
  });
  // A card that went away (a closed draft) leaves nothing open.
  createEffect(() => {
    const id = float.open();
    if (id && !runOf(id)) float.show(null);
  });
  onMount(() => {
    const wrap = anchor.previousElementSibling as HTMLElement | null;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    // The card may cover the conversation and no more (never the chat's header): the anchor has no
    // height of its own, so the room is the conversation's own height, measured as it changes (the
    // message box growing a line shrinks it).
    const room = () => anchor.style.setProperty("--pb-room", `${Math.round(wrap.getBoundingClientRect().height)}px`);
    // The strips cover the conversation's last pixels: its end and its floating controls (Jump to
    // Latest, the wait note, Focus) move up by as much (PlaybookCard.css). A view that was at the
    // end stays at the end. Under an open card the strips keep their box, so nothing moves then.
    let lifted = 0;
    const lift = () => {
      const h = strips.offsetHeight;
      const by = h > 0 ? h + STRIP_GAP : 0;
      if (by === lifted) return;
      lifted = by;
      const scroller = wrap.querySelector<HTMLElement>(":scope > .transcript");
      const atEnd = !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
      if (by > 0) {
        wrap.style.setProperty("--pb-lift", `${by}px`);
        wrap.setAttribute("data-pb-strip", "");
      } else {
        wrap.style.removeProperty("--pb-lift");
        wrap.removeAttribute("data-pb-strip");
      }
      if (atEnd && scroller) scroller.scrollTop = scroller.scrollHeight;
    };
    const ro = new ResizeObserver(() => {
      room();
      lift();
    });
    ro.observe(wrap);
    ro.observe(strips);
    room();
    lift();
    onCleanup(() => {
      ro.disconnect();
      wrap.style.removeProperty("--pb-lift");
      wrap.removeAttribute("data-pb-strip");
    });
  });
  const covered = () => !!float.open() || !!record();
  return (
    <div class="pb-float" ref={anchor} data-open={covered() ? "" : undefined}>
      <div class="pb-layer">
        {/* Always mounted (empty: no box), so its height is measured from one element. */}
        <div class="pb-strips" ref={strips} role="group" aria-label="Playbook" data-covered={covered() ? "" : undefined}>
          <For each={ids()}>{(id) => <Show when={runOf(id)}>{(run) => <RunStrip run={run()} chat={props.chat} answer={props.answer} onOpen={() => open(id)} />}</Show>}</For>
        </div>
        <For each={mounted()}>
          {(id) => (
            <Show when={runOf(id)}>
              {(run) => (
                <PlaybookCard
                  run={run()}
                  store={props.store}
                  host={props.host}
                  here={props.chat.path}
                  shown={float.open() === id}
                  status={runStatus(run(), nowFor(run(), props.chat))}
                  answer={props.answer}
                  onMinimize={() => minimize(id)}
                />
              )}
            </Show>
          )}
        </For>
        <Show when={record()} keyed>
          {(view) => (
            <PlaybookCard run={view} store={props.store} host={props.host} here={props.chat.path} shown status={runStatus(view, nowFor(view, props.chat))} answer={props.answer} onMinimize={() => setRecord(null)} />
          )}
        </Show>
      </div>
    </div>
  );
}

/**
 * One playbook's card. Before Start it is the run's plan, editable: your choices, who runs on which
 * model, the steps and their stops, the cycle settings and a note per role. Every edit saves the
 * draft as a new revision; Start runs exactly the revision the card shows. After Start the same card
 * is the run's record, read-only, with how its chat stands now. Its head and its buttons stay put;
 * the middle scrolls.
 */
export function PlaybookCard(props: {
  run: PlaybookRunView;
  store: PlaybookRunsStore;
  host: string | null;
  /** The chat showing it. */
  here?: string;
  /** Open over the conversation; false while minimized (it stays mounted). */
  shown: boolean;
  status: RunStatus;
  answer?: PlaybookAnswer;
  onMinimize(): void;
}) {
  const uid = createUniqueId();
  const id = (s: string) => `pb-${uid}-${s}`;
  const run = () => props.run;
  const editable = () => run().state === "draft";

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

  /** A stop's answer goes as your message to this chat; what stops Send stops it, with the reason. */
  const answer = (text: string) => {
    if (sendAnswer(props.answer, text)) props.onMinimize();
  };
  /** The line beside a started run's buttons. */
  const startedHint = () => {
    if (run().closed) return "You put this card away. The run was not changed.";
    if (props.status.answer && props.answer) return props.answer.blocked() ?? "Sends that word as your message to this chat. Or answer in the message box.";
    const st = elsewhere();
    if (st) return `The run is in ${st.chat.title || "another chat"}; its state shows there.`;
    return "Close Card puts its control away. The run goes on.";
  };
  const elsewhere = () => (run().state === "started" && run().started && run().started!.chat.path !== props.here ? run().started! : null);
  const choices = createMemo(() => splitChoices(run().choices));

  return (
    <section
      class="card pb-card"
      id={cardDomId(run().id)}
      role="dialog"
      aria-modal="false"
      aria-labelledby={id("title")}
      tabindex={-1}
      hidden={!props.shown}
      data-run={run().id}
      data-state={run().state}
      onKeyDown={(e) => {
        // Esc minimizes, unless something inside the card (a picker, a menu) already took it.
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        props.onMinimize();
      }}
    >
      <header class="pb-head">
        <span class="pb-eyebrow">{cardEyebrow(run())}</span>
        <span class="pb-title" id={id("title")}>
          {run().playbook.title}
        </span>
        <Chip tone={props.status.tone} live={props.status.live}>
          {props.status.label}
        </Chip>
        <button type="button" class="button button-sm button-ghost pb-min" title="Minimize the card (Esc)" onClick={() => props.onMinimize()}>
          <Icon name="chevron-down" small />
          Minimize
        </button>
      </header>

        <div class="pb-body" id={id("body")}>
          <Show when={run().playbook.summary}>{(s) => <p class="pb-summary">{s()}</p>}</Show>

          {/* A started run: how its chat stands now, then when and where it started. */}
          <Show when={props.status.detail || (run().state !== "draft" && run().started)}>
            <div class="pb-now">
              <Show when={props.status.detail}>{(d) => <p class="pb-now-line">{d()}</p>}</Show>
              <Show when={run().state !== "draft" && run().started}>
                {(st) => (
                  <p class="pb-record">
                    Started <span class="text-num">{shortClock(st().at)}</span> as revision <span class="text-num">{st().revision}</span>
                    {st().chat.path !== props.here ? (
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
            </div>
          </Show>

          {/* Your choices */}
          <Show when={run().choices.length > 0}>
            <section class="pb-section" aria-labelledby={id("choices")}>
              <h4 class="pb-section-label" id={id("choices")}>
                Your choices
              </h4>
              <Index each={choices().shown}>{(c) => <ChoiceRow choice={c()} value={choiceValue(c())} editable={editable()} onChange={(v, delay) => queue({ choices: { [c().id]: v } }, delay)} />}</Index>
              <Show when={choices().more.length > 0}>
                <details class="pb-more">
                  <summary class="pb-more-summary">
                    <Icon name="chevron-right" small class="icon-twist" />
                    More options · <span class="text-num">{choices().more.length}</span>
                  </summary>
                  <Index each={choices().more}>{(c) => <ChoiceRow choice={c()} value={choiceValue(c())} editable={editable()} onChange={(v, delay) => queue({ choices: { [c().id]: v } }, delay)} />}</Index>
                </details>
              </Show>
            </section>
          </Show>

          {/* Who runs */}
          <section class="pb-section" aria-labelledby={id("cast")}>
            <h4 class="pb-section-label" id={id("cast")}>
              Who runs
            </h4>
            <Index each={run().roles}>
              {(r) => (
                <RoleRow
                  part={r()}
                  on={roleOn(r())}
                  note={roleNote(r())}
                  pick={roleEdit(r())?.pick}
                  editable={editable()}
                  onPick={(pick) => queue({ roles: { [r().id]: { pick } } })}
                  onOn={(on) => queue({ roles: { [r().id]: { on } } })}
                  onNote={(note) => queue({ roles: { [r().id]: { note } } }, TYPE_SAVE_MS)}
                />
              )}
            </Index>
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
                        <Toggle class="pb-toggle" label="Stop for me here" checked={stopOn(s())} disabled={!editable()} onChange={(on) => queue({ stops: { [s().id]: on } })} />
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
                    <div class="pb-cycle-line">
                      <span>{cycleStepsLine(c().steps.map((sid) => run().steps.findIndex((s) => s.id === sid) + 1).filter((n) => n > 0))} as a cycle: up to</span>
                      <NumberBox label="Most cycles" value={cycleMax()} min={1} max={c().maxCap} onChange={(n) => queue({ cycle: { max: n } }, TYPE_SAVE_MS)} />
                      <span>
                        cycles, at most <span class="text-num">{c().maxCap}</span>; asks you after every
                      </span>
                      <NumberBox label="Cycles before it asks you" value={cycleAsk()} min={1} max={cycleMax()} onChange={(n) => queue({ cycle: { askEvery: n } }, TYPE_SAVE_MS)} />
                      <span>{cycleAsk() === 1 ? "cycle." : "cycles."}</span>
                    </div>
                  </Show>
                  <Show when={c().rule}>
                    {(rule) => (
                      <Show when={editable()} fallback={<p class="pb-note">{cycleUntil() === "rule" ? `Stops early when ${rule()}` : "Runs every cycle, whatever the stop rule says."}</p>}>
                        <div class="pb-cycle-line">
                          <Select
                            class="pb-until"
                            label="Keep going until"
                            value={cycleUntil()}
                            options={[
                              { value: "rule", label: "the stop rule is met" },
                              { value: "max", label: "all cycles have run" },
                            ]}
                            onChange={(v) => queue({ cycle: { until: v as "rule" | "max" } })}
                          />
                        </div>
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

        </div>

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
          {/* Off with the reason when the playbook can't be read: there is nothing to save defaults for. */}
          <button type="button" class="button button-sm" disabled={!!busy() || !editable() || !!run().error} title={run().error ?? undefined} onClick={() => void saveDefaults()}>
            {busy() === "defaults" ? "Saving…" : "Save as My Defaults"}
          </button>
          <button type="button" class="button button-sm button-ghost" disabled title="Repeats come in a later release.">
            Repeat… <span class="pb-coming">Coming</span>
          </button>
          <span class="pb-foot-hint" id={id("why")}>
            {startWhy() ?? done() ?? (changing() ? "Saving your changes…" : `Revision ${run().revision}. Start runs exactly this card.`)}
          </span>
          <button type="button" class="button button-sm button-ghost pb-close" disabled={!!busy() || !editable()} onClick={() => void close()}>
            Close Card
          </button>
        </footer>
      </Show>

      {/* A started run: when it waits for you, the two answers its conductor was told to wait for;
          from another chat, the way to the chat that runs it; and Close Card, which puts it away. */}
      <Show when={run().state === "started"}>
        <footer class="pb-foot">
          <Show when={!run().closed && props.status.answer && props.answer}>
            {(a) => (
              <For each={RUN_ANSWERS}>
                {(ans, i) => (
                  <button
                    type="button"
                    class={`button button-sm${i() === 0 ? " button-primary" : ""}`}
                    aria-disabled={a().blocked() ? "true" : undefined}
                    aria-describedby={id("why")}
                    title={a().blocked() ?? undefined}
                    onClick={() => answer(ans.text)}
                  >
                    {ans.label}
                  </button>
                )}
              </For>
            )}
          </Show>
          <Show when={elsewhere()}>
            {(st) => (
              <a class="button button-sm" href={sessionHrefOn(props.host, st().chat.path)}>
                Open the Chat
              </a>
            )}
          </Show>
          <span class="pb-foot-hint" id={id("why")}>
            {startedHint()}
          </span>
          <Show when={!run().closed}>
            <button
              type="button"
              class="button button-sm button-ghost pb-close"
              disabled={!!busy()}
              title="Puts this run's control away. The run goes on, and Open Card on its row in the conversation still shows this record."
              onClick={() => void close()}
            >
              Close Card
            </button>
          </Show>
        </footer>
      </Show>
    </section>
  );
}

/** A small number box inside a sentence; it keeps what was typed and saves a whole number in range. */
function NumberBox(props: { label: string; value: number; min: number; max: number; onChange(n: number): void }) {
  const [raw, setRaw] = createSignal(String(props.value));
  return (
    <NumberField
      class="pb-num"
      hideLabel
      label={props.label}
      value={raw()}
      onInput={(text) => {
        setRaw(text);
        const n = Number(text);
        if (text.trim() && Number.isInteger(n) && n >= props.min && n <= props.max) props.onChange(n);
      }}
    />
  );
}

/** One of your choices: its label, its control (or its value, after Start) and where the value came from. */
function ChoiceRow(props: { choice: PlaybookChoiceView; value: unknown; editable: boolean; onChange(value: unknown, delay?: number): void }) {
  const cid = `pbc-${createUniqueId()}`;
  const c = () => props.choice;
  const empty = () => c().required && isEmpty(props.value);
  /** A list box keeps what was typed, blank lines included; what's saved is its non-empty lines. */
  const [listText, setListText] = createSignal(listValue<string>(props.value).join("\n"));
  /** A number box keeps what was typed ("", "1e"); what's saved is a number, or none. */
  const [numText, setNumText] = createSignal(typeof props.value === "number" ? String(props.value) : "");
  const choiceOptions = () => [...(isEmpty(props.value) ? [{ value: "", label: "Pick one" }] : []), ...(c().options ?? [])];
  // One control per type, built once: only its value follows the card, so typing keeps focus. Each
  // is the form kit's, its label read aloud (the row's own label shows it).
  const control = (): JSX.Element => (
    <Switch fallback={<TextField class="pb-text" hideLabel label={c().label} value={typeof props.value === "string" ? props.value : ""} onInput={(v) => props.onChange(v, TYPE_SAVE_MS)} />}>
      <Match when={c().type === "toggle"}>
        <Toggle class="pb-toggle" label={props.value ? "On" : "Off"} ariaLabel={c().label} checked={!!props.value} onChange={(on) => props.onChange(on)} />
      </Match>
      <Match when={c().type === "number"}>
        <NumberField
          class="pb-num"
          hideLabel
          label={c().label}
          value={numText()}
          onInput={(text) => {
            setNumText(text);
            const n = Number(text);
            if (!text.trim()) props.onChange(null, TYPE_SAVE_MS);
            else if (Number.isFinite(n)) props.onChange(n, TYPE_SAVE_MS);
          }}
        />
      </Match>
      <Match when={c().type === "choice"}>
        <Select hideLabel label={c().label} value={typeof props.value === "string" ? props.value : ""} options={choiceOptions()} onChange={(v) => props.onChange(v || null)} />
      </Match>
      <Match when={c().type === "multi"}>
        <span class="pb-multi" role="group" aria-label={c().label}>
          <For each={c().options ?? []}>
            {(o) => (
              <Toggle
                class="pb-toggle"
                label={o.label}
                checked={listValue(props.value).includes(o.value)}
                onChange={(on) => {
                  const now = listValue(props.value).filter((v) => v !== o.value);
                  props.onChange(on ? [...now, o.value] : now);
                }}
              />
            )}
          </For>
        </span>
      </Match>
      <Match when={c().type === "list"}>
        <TextArea
          class="pb-list"
          hideLabel
          label={c().label}
          rows={Math.min(6, Math.max(2, listValue(props.value).length + 1))}
          placeholder="One per line"
          value={listText()}
          onInput={(text) => {
            setListText(text);
            props.onChange(
              text
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
              TYPE_SAVE_MS,
            );
          }}
        />
      </Match>
      <Match when={c().type === "models"}>
        <ModelsControl id={cid} label={c().label} value={listValue<PlaybookModelPick>(props.value)} onChange={(v) => props.onChange(v)} />
      </Match>
    </Switch>
  );
  return (
    <div class="pb-row" data-empty={empty() ? "" : undefined}>
      {/* Shown, not read: each control carries its own name. */}
      <span class="pb-row-label" aria-hidden={props.editable ? "true" : undefined}>
        {c().label}
      </span>
      <span class="pb-row-value">
        <Show
          when={props.editable}
          fallback={
            <Show when={isFreeText(c()) && !isEmpty(props.value)} fallback={<span>{valueText(c(), props.value)}</span>}>
              <LongAnswer text={valueText(c(), props.value)} label={c().label} />
            </Show>
          }
        >
          {control()}
        </Show>
        <Show when={c().help}>{(h) => <span class="pb-row-help">{h()}</span>}</Show>
      </span>
      <span class="pb-row-origin">{empty() ? "Needed" : ORIGIN_LABEL[c().origin]}</span>
    </div>
  );
}

/**
 * A free-text answer as the record shows it: its first 2 lines, and Show All when there is more
 * (a pasted paragraph would otherwise push every other choice off the card). Whether there is more
 * is measured, not guessed from its length: the same answer fits at one width and not at another.
 */
function LongAnswer(props: { text: string; label: string }) {
  const aid = `pba-${createUniqueId()}`;
  let text!: HTMLSpanElement;
  const [all, setAll] = createSignal(false);
  const [more, setMore] = createSignal(false);
  // Measured while folded only: shown whole nothing overflows, and Show Less must stay to fold it.
  const measure = () => {
    if (text && !all()) setMore(text.scrollHeight > text.clientHeight + 1);
  };
  onMount(() => {
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(text);
    onCleanup(() => ro.disconnect());
  });
  // An answer that changed under the same two lines changes no box: measure it again once drawn.
  createEffect(() => {
    void props.text;
    queueMicrotask(measure);
  });
  return (
    <span class="pb-answer">
      <span class="pb-answer-text" id={aid} ref={text} data-all={all() ? "" : undefined}>
        {props.text}
      </span>
      <Show when={more() || all()}>
        <button
          type="button"
          class="button button-sm button-ghost pb-answer-more"
          aria-expanded={all()}
          aria-controls={aid}
          aria-label={`${answerFoldLabel(all())}: ${props.label}`}
          onClick={() => {
            setAll(!all());
            queueMicrotask(measure);
          }}
        >
          {answerFoldLabel(all())}
        </button>
      </Show>
    </span>
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
  /** The role (not named `role`: that is an ARIA attribute's name). */
  part: PlaybookRoleView;
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
  const r = () => props.part;
  /** What the row shows as its model: your pick while it saves, else the resolved one. */
  const modelText = () => (props.pick ? pickLine(props.pick) : roleModelLine(r()));
  const off = () => r().optional && !props.on;
  return (
    <div class="pb-row pb-role" data-off={off() ? "" : undefined} data-blocked={!r().runnable ? "" : undefined}>
      <span class="pb-row-label">
        {roleTitle(r())}
        <Show when={r().per}>{(per) => <span class="pb-row-help">One for each of {per()}</span>}</Show>
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
            <Select
              class="pb-only-select"
              hideLabel
              label={`Model for ${r().label}, only these`}
              value={String(Math.max(0, r().models.findIndex((m) => m.model === (props.pick?.model ?? r().resolved?.model))))}
              onChange={(v) => {
                const m = r().models[Number(v)];
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
            </Select>
          </Show>
        </Show>
        <Show when={!off() && roleWhy(r())}>{(why) => <span class="pb-row-why">{why()}</span>}</Show>
      </span>
      <span class="pb-role-actions">
        <Show when={r().optional && props.editable}>
          <Toggle class="pb-toggle" label="Runs" ariaLabel={`${r().label} runs`} checked={props.on} onChange={(on) => props.onOn(on)} />
        </Show>
        <button type="button" class="button button-sm button-ghost" aria-expanded={promptOpen()} aria-controls={`${rid}-prompt`} onClick={() => setPromptOpen(!promptOpen())}>
          {promptOpen() ? "Hide Prompt" : "View Prompt"}
        </button>
      </span>
      <Show when={promptOpen()}>
        <div class="pb-prompt" id={`${rid}-prompt`}>
          <pre class="pb-prompt-text">{r().prompt || "No prompt of its own: it gets Sova's standard conductor instructions."}</pre>
          <Show when={props.editable} fallback={<Show when={props.note}>{(n) => <p class="pb-note">Note for this run: {n()}</p>}</Show>}>
            <TextArea class="pb-role-note" label="Note for this run" rows={2} value={props.note} placeholder="Added after its prompt, for this run only" onInput={(v) => props.onNote(v)} />
          </Show>
        </div>
      </Show>
    </div>
  );
}
