import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { GROUP_NAME_MAX, type BatchRefusal, type ContextInfo, type FanoutRequest, type SessionSummary } from "../../shared/protocol";
import { createFanout } from "../lib/api";
import {
  addModel,
  COUNT_MAX,
  createLabel,
  defaultGroupName,
  type MemberRow,
  modelOf,
  removeModel,
  rowFill,
  rowModel,
  sharedTurnLine,
  stepCount,
  totalMembers,
} from "../lib/fanout";
import { refusalSentence } from "../lib/group-prompt";
import { groupHref } from "../lib/group-route";
import { ensureModels, modelList } from "../lib/models";
import { newSessionCwd } from "../lib/new-session";
import { announce, home } from "../lib/ui-state";
import { FolderPicker } from "./FolderPicker";
import { ModelPicker } from "./ModelMenu";
import { Banner, Icon, trapFocus } from "./ui";

/** What the dialog was opened on: a session to fork, or nothing (a fresh prompt). */
export interface FanoutSource {
  session: SessionSummary;
  /** The entry the transcript is SHOWING as its last — never the file's tail (spec/14b). */
  leafId: string;
  /** How many rendered entries the branch has, for "up to message {n}". */
  messages: number;
  /** The branch's context fill at that leaf: what every forked member starts holding. */
  context: ContextInfo | null;
  /** Create is off while this is set: the source isn't quiet enough to read (§14b "States"). */
  blocked: string | null;
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
  /** Sessions, for the fresh mode folder default. */
  sessions: SessionSummary[];
  onClose(): void;
  /** A group was created: re-read the list before the workspace renders from it. */
  onCreated(): void;
}) {
  const [mode, setMode] = createSignal<"fork" | "fresh">(props.source ? "fork" : "fresh");
  const [rows, setRows] = createSignal<MemberRow[]>([]);
  const [name, setName] = createSignal(defaultGroupName(props.source?.session.title ?? ""));
  const [text, setText] = createSignal("");
  const [cwd, setCwd] = createSignal(newSessionCwd(props.source?.session.cwd, props.sessions) ?? home() ?? "");
  const [picking, setPicking] = createSignal(false);
  const [folders, setFolders] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  /** A refusal (the source isn't forkable) or a total failure: shown in the dialog, which stays. */
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => void ensureModels().catch(() => {}));

  const fork = () => mode() === "fork" && !!props.source;
  /** What each forked member starts holding; null in fresh mode, where there is no history. */
  const startTokens = () => (fork() ? (props.source?.context?.tokens ?? 0) : null);
  const members = createMemo(() => totalMembers(rows()));

  /** A row that can't fit its fork is a session that fails on its first turn, so Create is off. */
  const fills = createMemo(() =>
    rows().map((r) => ({ row: r, fill: rowFill(startTokens(), modelOf(modelList() ?? undefined, r.ref)?.contextWindow) })),
  );
  const overflowing = createMemo(() => fills().filter((f) => f.fill.overflows));

  /** Why Create can't run, in the order the user can act on: plan, then fit, then the source. */
  const blocked = (): string | null => {
    if (members() === 0) return "Add at least 1 member.";
    if (overflowing().length > 0) {
      const which = overflowing().map((f) => rowModel(f.row.ref)).join(", ");
      return `Remove ${which}, or lower its count, to create this fanout.`;
    }
    if (fork()) return props.source?.blocked ?? null;
    if (!cwd()) return "Pick a folder for the new sessions.";
    if (!text().trim()) return "Write the first message every member gets.";
    return null;
  };

  const create = async () => {
    if (blocked() || creating()) return;
    setCreating(true);
    setError(null);
    const body: FanoutRequest = fork()
      ? { name: name().trim(), members: rows(), source: { path: props.source!.session.path, leafId: props.source!.leafId } }
      : { name: name().trim(), members: rows(), cwd: cwd(), text: text().trim() };
    const out = await createFanout(body);
    setCreating(false);
    if (out.ok) {
      props.onCreated();
      // The failures ride to the workspace, where the banner sits above the panes that DID start.
      if (out.result.failed.length > 0) reportPartial(out.result.group.id, out.result.failed, members());
      const made = out.result.created.length;
      announce(`Created ${made} ${made === 1 ? "member" : "members"}.`);
      props.onClose();
      location.hash = groupHref(out.result.group.id);
      return;
    }
    if (out.refused) {
      // Exactly one entry, and it names the SOURCE — which is a member of nothing, so its id is
      // empty by design and the sentence is composed from the code plus the source's own title.
      const only = out.refused[0]!;
      setError(sentenceFor(only, props.source?.session.title ?? "This session"));
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
    if (before > 0) announce(`${rowModel(ref)} ×${Math.min(COUNT_MAX, before + 1)}.`);
  };

  return (
    <>
      <div class="scrim" onClick={props.onClose} />
      <div
        class="modal modal-wide fanout"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fanout-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !picking() && !folders()) props.onClose();
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
                    <input type="radio" name="fanout-src" checked={mode() === "fork"} onChange={() => setMode("fork")} />{" "}
                    Fork “{src().session.title}” at its latest message
                  </label>
                  <label>
                    <input type="radio" name="fanout-src" checked={mode() === "fresh"} onChange={() => setMode("fresh")} /> A fresh prompt
                  </label>
                </div>
                <Show when={fork()}>
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
                <button type="button" class="button button-sm" onClick={() => setFolders(true)}>
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
                onInput={(e) => {
                  setText(e.currentTarget.value);
                  if (!props.source) setName(defaultGroupName(e.currentTarget.value));
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
                          aria-label={row.count === 1 ? `Remove ${rowModel(row.ref)}` : `One fewer ${rowModel(row.ref)}`}
                          onClick={() => setRows(stepCount(rows(), row.ref, -1))}
                        >
                          −
                        </button>
                        <span class="text-num" aria-live="off">
                          {row.count}
                        </span>
                        <button
                          type="button"
                          class="button button-icon button-ghost button-sm"
                          aria-label={`One more ${rowModel(row.ref)}`}
                          aria-disabled={row.count >= COUNT_MAX ? "true" : undefined}
                          onClick={() => setRows(stepCount(rows(), row.ref, 1))}
                        >
                          +
                        </button>
                      </div>
                      <button
                        type="button"
                        class="button button-sm button-ghost"
                        aria-label={`Remove ${rowModel(row.ref)}`}
                        onClick={() => setRows(removeModel(rows(), row.ref))}
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
            <button type="button" class="button button-sm button-ghost fanout-add" onClick={() => setPicking(true)}>
              <Icon name="plus" small />
              Add a Model
            </button>
          </div>

          <div class="field">
            <label class="field-label" for="fanout-name">
              Group name
            </label>
            <input
              class="input"
              id="fanout-name"
              maxlength={GROUP_NAME_MAX}
              placeholder="Group name"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>

          {/* Two facts, because the gesture multiplies both: how full each member starts, and what
              every shared turn costs from then on. */}
          <Show when={members() > 0}>
            <div class="fanout-preview">
              <p class="fanout-note">{sharedTurnLine(members(), startTokens())}</p>
              <p class="fanout-note">
                Turns start together, so one provider may answer some members with 429. pi-web doesn't stagger them.
              </p>
            </div>
          </Show>
        </div>

        <footer class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="button button-primary"
            aria-disabled={blocked() || creating() ? "true" : undefined}
            title={blocked() ?? undefined}
            onClick={() => void create()}
          >
            {creating() ? "Creating…" : createLabel(members())}
          </button>
        </footer>
        {/* Why the primary is off, under the press it explains. Always shown when there is one:
            "Add at least 1 member." is the first thing an empty dialog has to say. */}
        <Show when={blocked()}>{(why) => <p class="field-error fanout-blocked">{why()}</p>}</Show>
      </div>

      <Show when={picking()}>
        <div class="scrim" onClick={() => setPicking(false)} />
        <div class="modal model-menu-modal" role="dialog" aria-modal="true" aria-label="Add a model">
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

/** The refusal's sentence: the batch's own code-to-sentence table, with the source as the name. */
function sentenceFor(refusal: BatchRefusal, title: string): string {
  return `${refusalSentence(refusal, `“${title}”`)}.`;
}

/**
 * A partial creation is reported where the members are, not where the dialog was: the workspace
 * opens with the k that started, and the banner sits above them. Handing it over through module
 * state rather than the route keeps it out of the URL, where it would survive a reload and
 * re-report a creation the user already read.
 */
const [pendingPartial, setPendingPartial] = createSignal<{ groupId: string; failed: BatchRefusal[]; planned: number } | null>(null);
export { pendingPartial };
export const clearPartial = () => setPendingPartial(null);
const reportPartial = (groupId: string, failed: BatchRefusal[], planned: number) =>
  setPendingPartial({ groupId, failed, planned });
