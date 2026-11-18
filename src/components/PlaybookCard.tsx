import { createContext, createEffect, createMemo, createSignal, createUniqueId, For, Index, Match, onCleanup, onMount, Show, Switch, untrack, type Accessor, type JSX } from "solid-js";
import type { PlaybookCardEdits, PlaybookChoiceView, PlaybookMemberView, PlaybookModelPick, PlaybookRunView, PlaybookStepView, PlaybookTeamView } from "../../shared/playbook-run";
import {
  cantRunCount,
  cardEyebrow,
  cardRowId,
  chatStrip,
  flowNote,
  flowSummary,
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
  LEGACY_WHO_NOTE,
  CHAT_WAITING,
  choiceOriginLine,
  isChatChoice,
  pickLine,
  memberModelLine,
  memberTitle,
  memberWhy,
  RUN_ANSWERS,
  controlLabel,
  runStatus,
  type RunChatNow,
  type RunStatus,
  splitChoices,
  stepRunsLine,
  stepsSummary,
  stripLine,
  teamAddsLine,
  teamEyebrow,
  whoSummary,
  toPick,
  recordNote,
  recordFoldLabel,
  revealStep,
} from "../lib/playbook-card";
import type { PlaybookRunsStore } from "../lib/playbook-runs";
import { ApiError } from "../lib/api";
import { visualFence } from "../lib/align";
import { sessionHrefOn } from "../lib/mesh";
import { providerName } from "../lib/cost-history";
import { announce, toast } from "../lib/ui-state";
import { jumpToEntry } from "../lib/jump";
import { watchPinnedBar } from "../lib/pinned-bar";
import { Markdown } from "./Markdown";
import { ModelPickButton } from "./ModelPickButton";
import { NumberField, Select, TextArea, TextField, Toggle } from "./form";
import { Chip, Icon } from "./ui";
import "./PlaybookCard.css";

/** How long typing waits before the card saves its draft. */
const TYPE_SAVE_MS = 400;

/** The card a way in last asked to show (a /name, a Playbooks pick, Open Card on the run's entry),
    with the pane it was asked from when it knows one. */
const [revealed, setRevealed] = createSignal<{ id: string; store?: PlaybookRunsStore | null } | null>(null, { equals: false });

/** Shows a run's card: a setup card where it stands in the conversation, a started run's over the
    conversation; in the pane whose store is given (the one clicked), else in whichever chat shows
    that run. */
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

/** What a card standing in a chat's conversation needs of that chat (PlaybookInlineCard). */
export interface PlaybookInlineHost {
  store: PlaybookRunsStore;
  host: string | null;
  chat: PlaybookChatNow;
  /** The run a row is the card of: among the chat's cards, or its put-away record. */
  run(id: string): PlaybookRunView | undefined;
}
export const PlaybookInlineContext = createContext<PlaybookInlineHost | null>(null);

/** The setup card's (or record's) element in the conversation, found by its run. */
const INLINE_ATTR = "data-pb-inline";
/** Room kept above a setup card brought to the top of the view. */
const INLINE_GAP = 8;

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
function RunStrip(props: { run: PlaybookRunView; chat: PlaybookChatNow; answer?: PlaybookAnswer; /** Start pressed, not answered yet. */ pressed: boolean; onOpen(): void }) {
  const lineId = `pb-strip-line-${createUniqueId()}`;
  const run = () => props.run;
  const status = createMemo(() => runStatus(run(), nowFor(run(), props.chat), props.pressed));
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
 * The chat's started playbook run, floating over the end of the conversation just above the message
 * box (Lookbook design A): the run as one strip, and its card opening upward from the strip's place, at the
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
  // A chat runs one playbook at most, so one strip: the run it started or conducts. A card still
  // being set up has none: it stands in the conversation (PlaybookInlineCard).
  // Keyed by run id, never by the view object: a new view of a run updates its strip in place.
  const ids = createMemo(() => [chatStrip(props.store.runs())?.id].filter((id): id is string => !!id), undefined, sameIds);
  const runOf = (id: string) => props.store.runs().find((r) => r.id === id);
  const isDraft = (id: string) => runOf(id)?.state === "draft";
  const mounted = createMemo(() => float.mounted().filter((id) => !!runOf(id) && !isDraft(id)), undefined, sameIds);
  /** Brings a setup card into view where it stands in the conversation, and puts focus on it. A
      card just opened is drawn a moment after its run arrives, so this waits for its row. */
  const showInline = (id: string, tries = 20) => {
    // The jump lands on the card's row (building the rows down to it when it stands above the ones
    // built so far) and stops the view following the conversation's end, as a scroll up would.
    const jumped = jumpToEntry(cardRowId(id), props.chat.path);
    const el = anchor.parentElement?.querySelector<HTMLElement>(`[${INLINE_ATTR}="${CSS.escape(id)}"]`);
    if (!el) {
      if (tries > 0) requestAnimationFrame(() => isDraft(id) && showInline(id, tries - 1));
      return;
    }
    // A card taller than the view reads from its top (its buttons stay pinned at the view's end);
    // a shorter one is whole in view where the jump put it.
    const view = el.closest<HTMLElement>(".transcript");
    const box = el.getBoundingClientRect();
    const port = view?.getBoundingClientRect();
    if (view && port && box.height > port.height - 2 * INLINE_GAP) view.scrollTop += box.top - port.top - INLINE_GAP;
    else if (!jumped) el.scrollIntoView({ block: "nearest", behavior: "instant" });
    el.focus({ preventScroll: true });
  };
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
    if (isDraft(want)) showInline(want);
    else open(want);
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
      // A setup card is in the conversation: nothing opens over it.
      if (isDraft(r.id)) {
        float.show(null);
        showInline(r.id);
      } else open(r.id);
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
  // A card that went away leaves nothing open.
  createEffect(() => {
    const id = float.open();
    if (id && (!runOf(id) || isDraft(id))) float.show(null);
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
          <For each={ids()}>{(id) => <Show when={runOf(id)}>{(run) => <RunStrip run={run()} chat={props.chat} answer={props.answer} pressed={props.store.starting(id)} onOpen={() => open(id)} />}</Show>}</For>
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
                  status={runStatus(run(), nowFor(run(), props.chat), props.store.starting(id))}
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
 * is the run's record, read-only. It is drawn two ways: `inline`, standing in the conversation (the
 * setup card, then the record of what was agreed, with no buttons once started), and floating over
 * the conversation from the run's strip, with how its chat stands now and the stop's answers; there
 * its head and its buttons stay put and the middle scrolls.
 */
export function PlaybookCard(props: {
  run: PlaybookRunView;
  store: PlaybookRunsStore;
  host: string | null;
  /** The chat showing it. */
  here?: string;
  /** Standing in the conversation, where it was opened; else floating over it from the strip. */
  inline?: boolean;
  /** Open over the conversation; false while minimized (it stays mounted). An inline card is always shown. */
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
  // A member's edits go under `roles`, keyed by its id (the wire's name for them).
  const memberEdit = (m: PlaybookMemberView) => shown().roles?.[m.id];
  const memberOn = (m: PlaybookMemberView) => memberEdit(m)?.on ?? m.on;
  const memberNote = (m: PlaybookMemberView) => memberEdit(m)?.note ?? m.note;
  const teamNote = (t: PlaybookTeamView) => shown().teams?.[t.id]?.note ?? t.note;
  const stopOn = (s: PlaybookStepView) => shown().stops?.[s.id] ?? s.stopOn;
  const cycleMax = () => shown().cycle?.max ?? run().cycle?.max ?? 1;
  const cycleAsk = () => shown().cycle?.askEvery ?? run().cycle?.askEvery ?? 1;
  const cycleUntil = () => shown().cycle?.until ?? run().cycle?.until ?? "rule";

  /** The flow's drawing is made the first time its section is opened, and kept. */
  const [flowSeen, setFlowSeen] = createSignal(false);

  const changing = () => hasEdits(shown()) || !!sending;
  const startWhy = () =>
    run().state === "starting" ? "Starting…" : !editable() ? null : busy() ? "Wait for the card to finish." : run().startBlocked;

  const start = async () => {
    if (!editable() || busy()) return;
    setBusy("start");
    // The state says Starting from the press, as the button does, on the card and its strip alike.
    const id = run().id;
    props.store.setStarting(id, true);
    try {
      await flush();
      if (run().startBlocked) return;
      // The revision you see is the revision that runs.
      await props.store.start(run().id, run().revision);
      announce(`${run().playbook.title} started.`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      props.store.setStarting(id, false);
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
  /** The record in the conversation folds to its head and when it started. One drawn already started
      (the chat opened again) starts folded; one that froze under your eyes at Start stays as it was. */
  const foldable = () => !!props.inline && run().state === "started";
  const [folded, setFolded] = createSignal(untrack(foldable));
  const choices = createMemo(() => splitChoices(run().choices));

  return (
    <section
      class="card pb-card"
      classList={{ "pb-inline": !!props.inline }}
      // One run may show twice in a chat, its record in the conversation and its card over it: the
      // floating one is the strip's popup, and owns the id the strip controls.
      id={props.inline ? undefined : cardDomId(run().id)}
      role={props.inline ? undefined : "dialog"}
      aria-modal={props.inline ? undefined : "false"}
      aria-labelledby={id("title")}
      tabindex={-1}
      hidden={!props.inline && !props.shown}
      data-run={run().id}
      data-state={run().state}
      data-pb-inline={props.inline ? run().id : undefined}
      data-folded={foldable() && folded() ? "" : undefined}
      onKeyDown={(e) => {
        // Esc minimizes, unless something inside the card (a picker, a menu) already took it.
        if (props.inline || e.key !== "Escape" || e.defaultPrevented) return;
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
        <Show when={!props.inline}>
          <button type="button" class="button button-sm button-ghost pb-min" title="Minimize the card (Esc)" onClick={() => props.onMinimize()}>
            <Icon name="chevron-down" small />
            Minimize
          </button>
        </Show>
        <Show when={foldable()}>
          <button type="button" class="button button-sm button-ghost pb-min pb-fold" aria-expanded={!folded()} aria-controls={id("body")} onClick={() => setFolded(!folded())}>
            <Icon name="chevron-right" small class="icon-twist" />
            {recordFoldLabel(folded())}
          </button>
        </Show>
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
                    {recordNote(!!props.inline, !!run().closed)}
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

          {/* Who runs: folded, unless a member that keeps Start off is in it. */}
          <details class="pb-section pb-who" open={untrack(() => cantRunCount(run().teams) > 0)}>
            <summary class="pb-more-summary pb-section-label">
              <Icon name="chevron-right" small class="icon-twist" />
              {whoSummary(run().who, cantRunCount(run().teams), !!run().legacy)}
            </summary>
            <Show when={run().teams.length > 0} fallback={<p class="pb-note">No helpers: this chat does every step itself.</p>}>
              <Show when={run().legacy}>
                <p class="pb-note pb-who-legacy">{LEGACY_WHO_NOTE}</p>
              </Show>
              <div class="pb-teams">
                <Index each={run().teams}>
                  {(t) => (
                    <TeamBlock
                      team={t()}
                      eyebrow={teamEyebrow(t(), run().steps, !!run().legacy)}
                      adds={teamAddsLine(t(), !!run().legacy)}
                      note={teamNote(t())}
                      editable={editable()}
                      onNote={(note) => queue({ teams: { [t().id]: { note } } }, TYPE_SAVE_MS)}
                    >
                      <Index each={t().members}>
                        {(m) => (
                          <MemberRow
                            part={m()}
                            on={memberOn(m())}
                            note={memberNote(m())}
                            pick={memberEdit(m())?.pick}
                            editable={editable()}
                            onPick={(pick) => queue({ roles: { [m().id]: { pick } } })}
                            onOn={(on) => queue({ roles: { [m().id]: { on } } })}
                            onNote={(note) => queue({ roles: { [m().id]: { note } } }, TYPE_SAVE_MS)}
                          />
                        )}
                      </Index>
                    </TeamBlock>
                  )}
                </Index>
              </div>
              <p class="pb-note">{helpersLine(run().helpers)}</p>
            </Show>
          </details>

          {/* Steps: open while the card is set up; a record read again later starts folded. */}
          <details class="pb-section pb-steps" open={untrack(() => !props.inline || run().state === "draft")}>
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
                      <Show when={s().goal}>{(g) => <span class="pb-step-goal">{g()}</span>}</Show>
                      <span class="pb-step-runs">{stepRunsLine(s(), run().teams)}</span>
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

          {/* Flow: the playbook's steps drawn by Sova's own renderer, from the source the server derives. */}
          <Show when={run().flow}>
            {(flow) => (
              <details class="pb-section pb-flow" onToggle={(e) => e.currentTarget.open && setFlowSeen(true)}>
                <summary class="pb-more-summary pb-section-label">
                  <Icon name="chevron-right" small class="icon-twist" />
                  {flowSummary(run())}
                </summary>
                <Show when={flowSeen()}>
                  <div class="pb-flow-drawing">
                    <Markdown text={visualFence({ kind: flow().kind, source: flow().body })} />
                  </div>
                </Show>
                <p class="pb-note">{flowNote(run().state)}</p>
              </details>
            )}
          </Show>

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
        <footer
          class="pb-foot"
          ref={(foot) => {
            // In the conversation the buttons stay pinned to the view's end while the card is in view
            // (a setup card is often taller than the screen), and the chat's floating controls lift above them.
            if (!props.inline) return;
            onMount(() => {
              const card = foot.closest<HTMLElement>(".pb-card");
              if (card) onCleanup(watchPinnedBar(foot, card));
            });
          }}
        >
          <button
            type="button"
            class="button button-sm button-primary pb-start"
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
          from another chat, the way to the chat that runs it; and Close Card, which puts it away.
          The record in the conversation has none of them: the run is answered from its strip. */}
      <Show when={run().state === "started" && !props.inline}>
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
export function ChoiceRow(props: { choice: PlaybookChoiceView; value: unknown; editable: boolean; onChange(value: unknown, delay?: number): void }) {
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
      <Match when={c().type === "text" && c().multiline}>
        <TextArea class="pb-text" hideLabel label={c().label} rows={2} value={typeof props.value === "string" ? props.value : ""} onInput={(v) => props.onChange(v, TYPE_SAVE_MS)} />
      </Match>
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
  /** Worked out with the main chat: never a control here, the chat fills it. */
  const chat = () => isChatChoice(c());
  const withControl = () => props.editable && !chat();
  return (
    <div class="pb-row" data-empty={empty() ? "" : undefined} data-chat={chat() ? (isEmpty(props.value) ? "waiting" : "filled") : undefined}>
      {/* Shown, not read: each control carries its own name. A row with no control is read as is. */}
      <span class="pb-row-label" aria-hidden={withControl() ? "true" : undefined}>
        {c().label}
      </span>
      <span class="pb-row-value">
        <Show
          when={withControl()}
          fallback={
            <Show
              when={!isEmpty(props.value)}
              fallback={<span class={chat() ? "pb-chat-waiting" : undefined}>{chat() ? CHAT_WAITING : valueText(c(), props.value)}</span>}
            >
              <Show when={isFreeText(c())} fallback={<span>{valueText(c(), props.value)}</span>}>
                <LongAnswer text={chat() && c().type === "list" ? listValue(props.value).join("\n") : valueText(c(), props.value)} label={c().label} />
              </Show>
            </Show>
          }
        >
          {control()}
        </Show>
        <Show when={c().help}>{(h) => <span class="pb-row-help">{h()}</span>}</Show>
      </span>
      <span class="pb-row-origin">{choiceOriginLine(c())}</span>
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

/** A one-line note for this run, on a member or a team: Add Note opens its field (a card with many
    members would otherwise be a column of empty boxes); a note already there shows its field. */
function runNote(note: () => string) {
  const id = `pbn-${createUniqueId()}`;
  const [open, setOpen] = createSignal(untrack(() => !!note()));
  // A note that arrives (another tab wrote it) shows; one you emptied keeps its field while you type.
  createEffect(() => {
    if (note()) setOpen(true);
  });
  const reveal = () => {
    setOpen(true);
    queueMicrotask(() => document.getElementById(id)?.focus());
  };
  return { id, open, reveal };
}
const NoteAdd = (props: { label: string; spoken: string; onClick(): void }) => (
  <button type="button" class="button button-sm button-ghost pb-run-note-add" aria-label={props.spoken} onClick={() => props.onClick()}>
    <Icon name="plus" small />
    {props.label}
  </button>
);
const NoteField = (props: { id: string; label: string; record: string; note: string; onNote(note: string): void }) => (
  <TextField class="pb-run-note" id={props.id} hideLabel label={props.label} value={props.note} placeholder={`${props.record}, for this run only`} onInput={(v) => props.onNote(v)} />
);
/** After Start the note is a line of the record. */
const NoteSaid = (props: { record: string; note: string }) => (
  <Show when={props.note}>
    {(n) => (
      <span class="pb-run-note-said">
        {props.record}: {n()}
      </span>
    )}
  </Show>
);

/** One team in Who runs: its name and steps over its goal, its required members, the line saying it
    isn't limited to them, and your note for the team. */
function TeamBlock(props: { team: PlaybookTeamView; eyebrow: string; adds: string | null; note: string; editable: boolean; onNote(note: string): void; children: JSX.Element }) {
  const tid = `pbt-${createUniqueId()}`;
  const t = () => props.team;
  const note = runNote(() => props.note);
  return (
    <div class="pb-team" role="group" aria-labelledby={tid}>
      <div class="pb-team-head" id={tid}>
        <Show when={props.eyebrow}>
          <span class="pb-team-eyebrow">{props.eyebrow}</span>
        </Show>
        <span class="pb-team-goal">{t().goal}</span>
      </div>
      {props.children}
      {/* A record with neither line (an older run's team with no note) has no foot. */}
      <Show when={props.adds || props.editable || props.note}>
        <div class="pb-team-foot">
          <Show when={props.adds}>
            <span class="pb-team-adds">{props.adds}</span>
          </Show>
          <Show when={props.editable} fallback={<NoteSaid record="Your note for the team" note={props.note} />}>
            <Show when={note.open()} fallback={<NoteAdd label="Add Team Note" spoken={`Add a note for the ${t().label} team`} onClick={note.reveal} />}>
              <NoteField id={note.id} label={`Note for the ${t().label} team`} record="Your note for the team" note={props.note} onNote={props.onNote} />
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** One required member of a team: how many, its model and why, its one-line brief, your note for it,
    and on or off when the playbook lets you turn it off. */
function MemberRow(props: {
  /** The member (not named `role`: that is an ARIA attribute's name). */
  part: PlaybookMemberView;
  on: boolean;
  note: string;
  pick: PlaybookModelPick | null | undefined;
  editable: boolean;
  onPick(pick: PlaybookModelPick | null): void;
  onOn(on: boolean): void;
  onNote(note: string): void;
}) {
  const rid = `pbr-${createUniqueId()}`;
  const r = () => props.part;
  /** What the row shows as its model: your pick while it saves, else the resolved one. */
  const modelText = () => (props.pick ? pickLine(props.pick) : memberModelLine(r()));
  const off = () => r().optional && !props.on;
  const note = runNote(() => props.note);
  return (
    <div class="pb-row pb-member" data-off={off() ? "" : undefined} data-blocked={!off() && !r().runnable ? "" : undefined}>
      <span class="pb-row-label">
        {memberTitle(r())}
        <Show when={r().per}>{(per) => <span class="pb-row-help">One for each of {per()}</span>}</Show>
      </span>
      <span class="pb-row-value">
        {/* An only-these member you can edit says its model in its list, once; one with no model that can run keeps the words. */}
        <Show when={off() || !props.editable || !r().only || !r().resolved}>
          <span class="pb-model" title={chainRest(r()) ?? undefined}>
            {off() ? "Off for this run" : modelText()}
          </span>
        </Show>
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
        <Show when={!off() && memberWhy(r())}>{(why) => <span class="pb-row-why">{why()}</span>}</Show>
        <Show when={r().brief}>
          <span class="pb-member-brief">{r().brief}</span>
        </Show>
        <Show when={!off()}>
          <Show when={props.editable} fallback={<NoteSaid record="Your note" note={props.note} />}>
            <Show when={note.open()}>
              <NoteField id={note.id} label={`Note for ${r().label}`} record="Your note" note={props.note} onNote={props.onNote} />
            </Show>
          </Show>
        </Show>
      </span>
      <span class="pb-member-actions">
        <Show when={props.editable && !off() && !note.open()}>
          <NoteAdd label="Add Note" spoken={`Add a note for ${r().label}`} onClick={note.reveal} />
        </Show>
        <Show when={r().optional && props.editable}>
          <Toggle class="pb-toggle" label="Runs" ariaLabel={`${r().label} runs`} checked={props.on} onChange={(on) => props.onOn(on)} />
        </Show>
      </span>
    </div>
  );
}
