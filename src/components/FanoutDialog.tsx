import { createEffect, createMemo, createSignal, For, onMount, Show, untrack } from "solid-js";
import { GROUP_NAME_MAX, type BatchRefusal, type ContextInfo, type SessionSummary } from "../../shared/protocol";
import { createFanout } from "../lib/api";
import {
  addModel,
  COUNT_MAX,
  createLabel,
  defaultGroupName,
  fanoutBody,
  fewerLabel,
  type MemberRow,
  modelOf,
  moreLabel,
  removeLabel,
  removeModel,
  rowFill,
  seedRef,
  sharedTurnLine,
  sourceRefusal,
  type StartFill,
  stepCount,
  totalMembers,
} from "../lib/fanout";
import { groupHref } from "../lib/group-route";
import { ensureModels, modelList } from "../lib/models";
import { newSessionCwd } from "../lib/new-session";
import { announce, home, toast } from "../lib/ui-state";
import { FolderPicker } from "./FolderPicker";
import { ModelPicker } from "./ModelMenu";
import { Banner, Icon, trapFocus } from "./ui";

/** What the dialog was opened on: a session to fork, or nothing (a fresh prompt). */
export interface FanoutSource {
  session: SessionSummary;
  /** The entry the transcript is SHOWING as its last — never the file's tail (spec/14b). */
  leafId: string;
  /** How many MESSAGES the branch has (user and assistant entries, src/lib/message-count.ts),
   *  for "up to message {n}" — never the rendered-row count, which counts one row per content
   *  block plus every info row and names a number that was never a count of messages. Absent
   *  when the source isn't on screen (the Add-Members entry passes the group's seed, not a live
   *  transcript), and the fork note hides rather than name a number nobody counted. */
  messages?: number;
  /** The branch's context fill at that leaf: what every forked member starts holding. "compacted"
   *  is §4f's unknown-until-next-reply state, kept distinct from null — which here means the fill
   *  was never reported (again the Add-Members entry). Both render as words, never as 0. */
  context: ContextInfo | "compacted" | null;
  /** Why Create is off, read LIVE: a getter over the source's summary, so a turn finishing or a
   *  terminal closing re-enables Create in place (§14b "It enables itself, in place, with no
   *  re-open"). A string could only snapshot the state at open time and repeat it forever. */
  blocked(): string | null;
}

/**
 * Fan out (spec/14b-fanout.md): N sessions from one starting point, as one group. Fork mode
 * branches the source at the leaf the transcript showed; fresh mode makes N new sessions in one
 * folder from one prompt. Either way the result is an ordinary group of ordinary sessions.
 *
 * The dialog stays open on failure — a total failure keeps the fields so the plan isn't retyped —
 * and navigates to the new workspace on success, carrying a partial-creation report if any member
 * couldn't start.
 */
export function FanoutDialog(props: {
  /** Present when opened from a session; absent opens in fresh mode with no source. */
  source?: FanoutSource;
  /**
   * A folder chosen before this dialog opened — the New Session dialog's Fan out… handoff
   * (§05 "Type", §14b "Entry points"). The fresh-mode folder starts here rather than the list's
   * guess, so the folder the user picked is the one the members get. Nothing else carries: that
   * dialog asks no first message, so there is no text to hand over.
   */
  presetCwd?: string;
  /**
   * Land the new members in THIS group instead of creating one (§14b "Entry points": the
   * workspace's Add Members pre-chooses its own group, so they arrive beside the ones already
   * there). The group keeps its name, which is why the name field goes away with it.
   */
  into?: { id: string; name: string };
  /** Sessions, for the fresh mode folder default. */
  sessions: SessionSummary[];
  onClose(): void;
  /** A group was created: re-read the list before the workspace renders from it. */
  onCreated(): void;
}) {
  const [mode, setMode] = createSignal<"fork" | "fresh">(props.source ? "fork" : "fresh");
  /**
   * Pre-seeded, not empty (§14b "The dialog"): the source's own model when forking, else the top
   * favorite. The fast path is open → Create, and "No members yet" was only ever the state
   * before the first click. The seed is written ONCE per open: a user who removes it has made a
   * plan (an empty one), and the model list refreshing underneath must not un-remove it.
   */
  const [rows, setRows] = createSignal<MemberRow[]>(
    props.source?.session.model ? [{ ref: props.source.session.model, count: 1 }] : [],
  );
  let seeded = !!props.source?.session.model;
  createEffect(() => {
    const models = modelList();
    // A fork dialog with a model-less source still takes the favorite; a fork WITH its model
    // never does. `untrack`: the user's plan must not re-arm the seed by changing.
    if (!models || seeded || (props.source?.session.model ?? null)) return;
    seeded = true;
    if (untrack(() => rows()).length > 0) return; // the user beat the list here; their plan stands
    const ref = seedRef(models, false, null);
    if (ref) setRows([{ ref, count: 1 }]);
  });
  const [name, setName] = createSignal(defaultGroupName(props.source?.session.title ?? ""));
  /**
   * Whether the user has typed in the name field. Two things turn on it:
   *
   * The name is GENERATED from the fresh prompt as it is typed, so without this, writing the first
   * message after naming the group would overwrite the name — the app throwing away the user's
   * words to keep its own guess current.
   *
   * It is also the one fact only this client holds: the server receives a string and cannot tell
   * "accepted our default" from "typed their own", because the default is generated HERE (§14b).
   * That distinction decides whether the group is Sova's to delete when it empties.
   *
   * ONE SIGNAL, TWO RULES, NEITHER REDUNDANT: it gates regeneration (the input handler below) and
   * it reports provenance (`named`, via fanoutBody). Deleting it does not merely break a
   * comparison somewhere else — there is no comparison and no second signal — it breaks
   * provenance directly, and every fanout group becomes user-named in a way nothing reports.
   */
  const [nameTouched, setNameTouched] = createSignal(false);
  const [text, setText] = createSignal("");
  const [cwd, setCwd] = createSignal(props.presetCwd ?? newSessionCwd(props.source?.session.cwd, props.sessions) ?? home() ?? "");
  const [picking, setPicking] = createSignal(false);
  const [folders, setFolders] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  /** A refusal (the source isn't forkable) or a total failure: shown in the dialog, which stays. */
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => void ensureModels().catch(() => {}));

  const fork = () => mode() === "fork" && !!props.source;
  /** What each forked member starts holding: the branch's fill at the leaf in fork mode (a number,
   *  or "compacted"/"unknown" when it can't be named), null in fresh mode — never 0, which is a
   *  claim §4f refuses for exactly these states (see StartFill). */
  const startFill = (): StartFill => {
    if (!fork()) return null;
    const c = props.source?.context;
    return c && c !== "compacted" ? c.tokens : (c ?? null);
  };
  const members = createMemo(() => totalMembers(rows()));

  /** A row that can't fit its fork is a session that fails on its first turn, so Create is off. */
  const fills = createMemo(() =>
    rows().map((r) => ({ row: r, fill: rowFill(startFill(), modelOf(modelList() ?? undefined, r.ref)?.contextWindow) })),
  );
  const overflowing = createMemo(() => fills().filter((f) => f.fill.overflows));

  /** Why Create can't run, in the order the user can act on: plan, then fit, then the source. */
  const blocked = (): { why: string; tone: "hint" | "error" } | null => {
    if (members() === 0) return { why: "Add at least 1 member.", tone: "hint" };
    if (overflowing().length > 0) {
      // The FULL ref: this names which row to act on, and two rows differing only by provider
      // would both answer to the short form (§9 "Doesn't fit"). Lowering the count is NOT a way
      // out — the fill is per model, not per repeat — so the reason doesn't offer it.
      const which = overflowing().map((f) => f.row.ref).join(", ");
      return { why: `Remove ${which} to create this fanout.`, tone: "error" };
    }
    if (fork()) {
      const why = props.source?.blocked();
      if (why) return { why, tone: "hint" };
    }
    if (!cwd()) return { why: "Pick a folder for the new sessions.", tone: "hint" };
    if (!text().trim()) return { why: "Write the first message every member gets.", tone: "hint" };
    return null;
  };

  const create = async () => {
    if (blocked() || creating()) return;
    setCreating(true);
    setError(null);
    const body = fanoutBody({
      rows: rows(),
      into: props.into,
      name: name(),
      nameTouched: nameTouched(),
      source: fork() ? { path: props.source!.session.path, leafId: props.source!.leafId } : undefined,
      fresh: fork() ? undefined : { cwd: cwd(), text: text() },
    });
    const out = await createFanout(body);
    setCreating(false);
    if (out.ok) {
      props.onCreated();
      const made = out.result.created.length;
      // The failures ride to the workspace, where the banner sits above the panes that DID start.
      if (out.result.failed.length > 0) reportPartial(out.result.group.id, out.result.failed, members(), made);
      announce(`Created ${made} ${made === 1 ? "member" : "members"}.`);
      props.onClose();
      location.hash = groupHref(out.result.group.id);
      return;
    }
    if (out.refused) {
      // Exactly one entry, and it names the SOURCE — which is a member of nothing, so its id is
      // empty by design and the sentence is composed from the code plus the source's own title,
      // recovery advice included (the group composer's clause drops it; here it is the answer).
      const only = out.refused[0]!;
      setError(sourceRefusal(only, props.source?.session.title ?? "This session"));
      return;
    }
    // One group carries one seed, because the marker and Align to Fork read it: a target forked
    // from somewhere else is refused rather than have the divergence point fabricated.
    if (out.conflict) {
      setError(
        `“${props.into?.name ?? "That group"}” was forked from a different point, and a group can only mark one. Nothing was created. Fan out into a new group, or add these members to the one they came from.`,
      );
      return;
    }
    if (out.status === 404) {
      setError(`“${props.source?.session.title ?? "That session"}” isn't on disk anymore. Nothing was created.`);
      return;
    }
    setError(`Couldn't create this fanout. No sessions were made. ${out.error}`);
  };

  const addRow = (ref: string) => {
    const before = rows().find((r) => r.ref === ref)?.count ?? 0;
    setRows(addModel(rows(), ref));
    setPicking(false);
    // Picking a listed model adds no row, so the count IS the feedback: say it.
    // The full ref, and this is the surface that needs it most: the count change is ANNOUNCED
    // ONLY, so nothing visible tells the user which of two same-named rows moved (§9 "Add a model").
    if (before > 0) announce(`${ref} ×${Math.min(COUNT_MAX, before + 1)}.`);
  };

  return (
    <>
      <div class="scrim" onClick={() => !creating() && props.onClose()} />
      <div
        class="modal modal-wide fanout"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fanout-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          // Escape closes the frontmost surface only: the picker and the folder picker are their
          // own modals (nested, N10), and nothing closes while a creation is in flight — the
          // dialog "stays up and its fields disable", which an Escape hatch would undo.
          if (e.key === "Escape" && !creating() && !picking() && !folders()) props.onClose();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="fanout-title">
            Fan out
          </h2>
        </div>

        <div class="modal-body">
          <Show when={error()}>{(m) => <Banner tone="error" title="Couldn't create this fanout." body={m()} />}</Show>

          <Show when={props.source}>
            {(src) => (
              <div class="field">
                <span class="field-label" id="fanout-source">
                  Start from
                </span>
                <div role="radiogroup" aria-labelledby="fanout-source" class="fanout-source">
                  <label>
                    <input
                      type="radio"
                      name="fanout-src"
                      checked={mode() === "fork"}
                      onChange={() => setMode("fork")}
                      disabled={creating()}
                    />{" "}
                    Fork “{src().session.title}” at its latest message
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="fanout-src"
                      checked={mode() === "fresh"}
                      onChange={() => setMode("fresh")}
                      disabled={creating()}
                    />{" "}
                    A fresh prompt
                  </label>
                </div>
                {/* The Add-Members entry passes a seed, not a transcript: no message count was
                    shown to anyone, so the note hides rather than name a number nobody counted. */}
                <Show when={fork() && src().messages !== undefined}>
                  <p class="field-hint fanout-source-note">
                    Each member gets the whole conversation up to message {src().messages}, then goes its own way.
                  </p>
                </Show>
              </div>
            )}
          </Show>

          {/* Fresh mode: where the new sessions live, and the one message they all start from. */}
          <Show when={!fork()}>
            <div class="field">
              <span class="field-label" id="fanout-cwd">
                Folder
              </span>
              <div class="cluster">
                <span class="text-mono" aria-labelledby="fanout-cwd">
                  {cwd() || "No folder picked"}
                </span>
                <button
                  type="button"
                  class="button button-sm"
                  aria-disabled={creating() ? "true" : undefined}
                  onClick={() => !creating() && setFolders(true)}
                >
                  Choose…
                </button>
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="fanout-text">
                First message
              </label>
              <textarea
                class="input textarea"
                id="fanout-text"
                rows={3}
                placeholder="Ask all of them to…"
                value={text()}
                disabled={creating()}
                onInput={(e) => {
                  setText(e.currentTarget.value);
                  // Only while the name is still ours to guess at, and only in fresh mode — the
                  // gate is the MODE, not how the dialog was opened, so a dialog opened on a
                  // session still regenerates once the user switches to a fresh prompt. THIS SAME
                  // SIGNAL DECIDES PROVENANCE (`nameTouched` is read by `fanoutBody` as `named`),
                  // so changing when regeneration stops also changes who owns the name — and no
                  // test in this file would fail. Anyone altering either rule owns both (§14b).
                  if (!fork() && !nameTouched()) setName(defaultGroupName(e.currentTarget.value));
                }}
              />
            </div>
          </Show>

          <div class="field">
            <span class="field-label" id="fanout-models">
              Members
            </span>
            <Show
              when={rows().length > 0}
              fallback={<p class="field-hint">No members yet. Add a model, then set how many of it you want.</p>}
            >
              <ul class="fanout-rows" aria-labelledby="fanout-models">
                <For each={fills()}>
                  {({ row, fill }) => (
                    <li class="fanout-row">
                      <span class="fanout-row-model text-mono">{row.ref}</span>
                      <span class={`fanout-row-fill context-meta ${fill.step}`.trim()}>{fill.text}</span>
                      <div class="fanout-count">
                        <button
                          type="button"
                          class="button button-icon button-ghost button-sm"
                          aria-label={fewerLabel(row.ref, row.count)}
                          aria-disabled={creating() ? "true" : undefined}
                          onClick={() => !creating() && setRows(stepCount(rows(), row.ref, -1))}
                        >
                          −
                        </button>
                        <span class="text-num" aria-live="off">
                          {row.count}
                        </span>
                        <button
                          type="button"
                          class="button button-icon button-ghost button-sm"
                          aria-label={moreLabel(row.ref)}
                          aria-disabled={creating() ? "true" : undefined}
                          onClick={() => {
                            // At the cap the press is not silent: the count can't move, so the
                            // answer is the whole feedback — a toast for the eye, the live region
                            // for AT, the app's wordless-control precedent (§2's rail). No
                            // aria-disabled here: a control that answers is not a dead one.
                            if (creating()) return;
                            if (row.count >= COUNT_MAX) {
                              const capped = `${row.ref} is already at ${COUNT_MAX}, the most per model.`;
                              toast(capped);
                              announce(capped);
                              return;
                            }
                            setRows(stepCount(rows(), row.ref, 1));
                          }}
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        class="button button-sm button-ghost"
                        aria-label={removeLabel(row.ref)}
                        aria-disabled={creating() ? "true" : undefined}
                        onClick={() => !creating() && setRows(removeModel(rows(), row.ref))}
                      >
                        <Icon name="close" small />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={overflowing().length > 0}>
              <p class="field-error">This model's window is smaller than the fork.</p>
            </Show>
            <button
              type="button"
              class="button button-sm button-ghost fanout-add"
              aria-disabled={creating() ? "true" : undefined}
              onClick={() => !creating() && setPicking(true)}
            >
              <Icon name="plus" small />
              Add a Model
            </button>
          </div>

          <Show when={props.into} fallback={null}>
            {(into) => (
              <p class="field-hint">
                New members land in <strong>{into().name}</strong>, beside the ones already there.
              </p>
            )}
          </Show>
          <div class="field" hidden={!!props.into}>
            <label class="field-label" for="fanout-name">
              Group name
            </label>
            <input
              class="input"
              id="fanout-name"
              maxlength={GROUP_NAME_MAX}
              placeholder="Group name"
              value={name()}
              disabled={creating()}
              onInput={(e) => {
                setNameTouched(true);
                setName(e.currentTarget.value);
              }}
            />
          </div>

          {/* Two facts, because the gesture multiplies both: how full each member starts, and what
              every shared turn costs from then on. */}
          <Show when={members() > 0}>
            <div class="fanout-preview">
              <p class="fanout-note">{sharedTurnLine(members(), startFill())}</p>
              <p class="fanout-note">
                Turns start together, so one provider may answer some members with 429. Sova doesn't stagger them.
              </p>
            </div>
          </Show>
        </div>

        <footer class="modal-foot">
          <span class="modal-spacer" />
          <button
            type="button"
            class="button button-ghost"
            aria-disabled={creating() ? "true" : undefined}
            onClick={() => !creating() && props.onClose()}
          >
            Cancel
          </button>
          <button
            type="button"
            class="button button-primary"
            aria-disabled={blocked() || creating() ? "true" : undefined}
            title={blocked()?.why ?? undefined}
            onClick={() => void create()}
          >
            {creating() ? "Creating…" : createLabel(members())}
          </button>
        </footer>
        {/* Why the primary is off, under the press it explains. Always shown when there is one —
            "Add at least 1 member." is the first thing an empty dialog has to say. A reason the
            user has done nothing wrong (empty plan, unfinished form, a busy source) is a HINT;
            the one error-toned reason is the overflow, which §14b refuses to make a warning to
            click through. Same words either way — only the treatment changes (§9). */}
        <Show when={blocked()}>
          {(why) => <p class={`${why().tone === "error" ? "field-error" : "field-hint"} fanout-blocked`}>{why().why}</p>}
        </Show>
      </div>

      <Show when={picking()}>
        <div class="scrim" onClick={() => setPicking(false)} />
        {/* Its own modal, not a panel of this one: it traps focus like one and Escape closes it
            FIRST (the nested surface goes before the one under it), which is what its footer's
            "Esc to close" has always promised. The dialog's own Escape handler defers while this
            is open, so one press never falls through both. */}
        <div
          class="modal model-menu-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Add a model"
          ref={(el) => trapFocus(el)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setPicking(false);
            }
          }}
        >
          <ModelPicker
            control={{
              model: () => null,
              pending: () => null,
              choose: (ref: string) => addRow(ref),
              blocked: () => null,
            }}
            autoFocus
            onChosen={() => setPicking(false)}
          />
        </div>
      </Show>

      <Show when={folders()}>
        <FolderPicker
          start={cwd()}
          recents={[...new Set(props.sessions.map((s) => s.cwd))].slice(0, 8)}
          onPick={(path) => {
            setCwd(path);
            setFolders(false);
          }}
          onClose={() => setFolders(false)}
        />
      </Show>
    </>
  );
}

/**
 * A partial creation is reported where the members are, not where the dialog was: the workspace
 * opens with the k that started, and the banner sits above them. Handing it over through module
 * state rather than the route keeps it out of the URL, where it would survive a reload and
 * re-report a creation the user already read.
 */
const [pendingPartial, setPendingPartial] = createSignal<{
  groupId: string;
  failed: BatchRefusal[];
  planned: number;
  /** How many actually started: the banner's own count, so it never has to infer one from the
   *  pane tree it lands above (F3 — a member that failed to start has no pane to count). */
  created: number;
} | null>(null);
export { pendingPartial };
export const clearPartial = () => setPendingPartial(null);
const reportPartial = (groupId: string, failed: BatchRefusal[], planned: number, created: number) =>
  setPendingPartial({ groupId, failed, planned, created });
