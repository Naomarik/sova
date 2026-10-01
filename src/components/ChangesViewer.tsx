import { batch, createContext, createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, Show, Switch, useContext, type JSX } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Portal } from "solid-js/web";
import type { DiffFilePatch, DiffFileSummary, DiffScope, DiffSummary, TranscriptItem } from "../../shared/protocol";
import { parseUnifiedPatch, type FileDiff } from "../lib/diff";
import { fetchTranscriptWithContext } from "../lib/api";
import { allDirs, buildTree, treeOrder, visibleRows, type TreeRow } from "../lib/changes-tree";
import {
  repoPath,
  stepHunksOf,
  stepsFromAgent,
  stepsFromTurns,
  turnsFromItems,
  type AgentStepInput,
  type Step,
  type StepFile,
  type StepPlan,
} from "../lib/changes-steps";
import {
  changesPaneHidden,
  countsLine,
  fetchDiffPatch,
  fetchDiffSummary,
  inPaths,
  scopeFromDetails,
  scopeTitle,
  setChangesPaneHidden,
  STATUS_WORD,
  stepMark,
} from "../lib/changes-view";
import { DiffLayoutToggle, DiffStat, DiffView, diffLayout, setDiffLayout, type ContextState, type DiffLayout } from "./DiffView";
import type { ShowChangesDetails } from "../../pi-config/extensions/show-changes/details";
import { tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { Icon, trapFocus } from "./ui";
import "./ChangesViewer.css";

/** What the viewer shows: a comparison the server resolves, and where its steps come from. */
export interface ChangesSource {
  scope: DiffScope;
  /** Transcript rows to take turns from; without them the viewer reads the session's whole
      transcript itself (a chat holds only its newest rows, and the Session tab a light copy). */
  items?: TranscriptItem[];
  /** The session's folder, for tool paths relative to it. */
  cwd?: string;
  /** A show_changes call: its title, path filter and steps (these replace the turns). */
  agent?: { title?: string; paths?: string[]; steps?: AgentStepInput[] };
}

type PatchState =
  | { state: "loading" }
  | { state: "error"; message: string }
  /** `diff` null: binary, too large, or a mode-only change; `patch` says which. `context`: the
      old side's whole text, asked for when a fold is opened (then in `diff.oldText`). */
  | { state: "ok"; patch: DiffFilePatch; diff: FileDiff | null; context?: ContextState };

type Pick = { kind: "file"; path: string } | { kind: "step"; id: string };

/** Split needs the diff pane at least this wide (§chat.changes/viewer). */
const SPLIT_MIN = 520;
/** Patches read at once: the server's own git concurrency. */
const PATCH_CONCURRENCY = 4;

/** The session a transcript belongs to, for the cards inside it that open the viewer. Absent
    (a subagent's transcript, say) means those cards show without their Review control. */
export interface ChangesSessionInfo {
  path: string;
  cwd?: string;
}
export const ChangesSession = createContext<ChangesSessionInfo | null>(null);
export const useChangesSession = () => useContext(ChangesSession);

let seq = 0;

/** The viewer as a dialog over the page (a full-height sheet at folded width). */
export function ChangesDialog(props: ChangesSource & { onClose(): void }) {
  const titleId = `changes-title-${++seq}`;
  // On the document, not the dialog: focus can sit on the page for a moment (a control that just
  // hid itself), and Esc still closes.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    props.onClose();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal changes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        // Also on the dialog: a Portal hands delegated events on to its owner, so without this the
        // session pane's own Esc handler (an ancestor there) runs first and closes the whole pane.
        onKeyDown={onKey}
      >
        <ChangesViewer {...props} titleId={titleId} onClose={props.onClose} />
      </div>
    </Portal>
  );
}

/**
 * The changes viewer (§chat.changes/viewer): the file tree and the steps on the left, one file or
 * one step on the right. Read-only; it reads the summary once, patches per file as they are shown,
 * and the patches of the files the steps need to place hunks.
 */
export function ChangesViewer(props: ChangesSource & { titleId?: string; onClose?(): void }) {
  const [summary, setSummary] = createSignal<DiffSummary | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [patches, setPatches] = createStore<Record<string, PatchState>>({});
  const [pick, setPick] = createSignal<Pick | null>(null);
  const [closedDirs, setClosedDirs] = createSignal<ReadonlySet<string>>(new Set());
  const [viewed, setViewed] = createSignal<ReadonlySet<string>>(new Set());
  /** Folded width: which of the two views shows. */
  const [view, setView] = createSignal<"list" | "diff">("list");
  const [paneWidth, setPaneWidth] = createSignal(0);
  const [sideWidth, setSideWidth] = createSignal(0);

  let run = 0;
  const load = async () => {
    const mine = ++run;
    setLoading(true);
    try {
      const next = await fetchDiffSummary(props.scope);
      if (mine !== run) return;
      batch(() => {
        setPatches(produce((p) => Object.keys(p).forEach((k) => delete p[k])));
        setSummary(next);
        setError(null);
      });
    } catch (err) {
      if (mine === run) setError((err as Error).message);
    } finally {
      if (mine === run) setLoading(false);
    }
  };
  // A memo on the scope's query, so a new but equal scope object never reloads.
  const scopeKey = createMemo(() => JSON.stringify(props.scope));
  createEffect(on(scopeKey, () => void load()));
  onCleanup(() => run++);

  const files = createMemo(() => (summary()?.files ?? []).filter((f) => inPaths(f.path, props.agent?.paths)));
  const byPath = createMemo(() => new Map(files().map((f) => [f.path, f])));
  const tree = createMemo(() => buildTree(files()));
  const rows = createMemo(() => visibleRows(tree(), closedDirs()));
  const ordered = createMemo(() => treeOrder(tree()));

  // ---- patches: one request per file, at most PATCH_CONCURRENCY at once ----
  const queue: DiffFileSummary[] = [];
  let active = 0;
  const pump = () => {
    while (active < PATCH_CONCURRENCY && queue.length) {
      const f = queue.shift()!;
      const mine = run;
      active++;
      fetchDiffPatch(props.scope, f)
        .then((patch) => {
          if (mine !== run) return;
          const diff = patch.patch ? (parseUnifiedPatch(patch.patch)[0] ?? null) : null;
          setPatches(f.path, { state: "ok", patch, diff });
        })
        .catch((err: Error) => mine === run && setPatches(f.path, { state: "error", message: err.message }))
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  /** A fold was opened on a file without its whole text: read the patch again with the old side
      (a fresh patch, so the text always matches the hunks it is shown with). */
  const loadContext = (f: DiffFileSummary) => {
    const cur = patches[f.path];
    if (cur?.state !== "ok" || !cur.diff || cur.diff.oldText !== undefined || cur.context === "loading" || cur.context === "none") return;
    const mine = run;
    setPatches(f.path, { context: "loading" });
    fetchDiffPatch(props.scope, f, { context: true })
      .then((patch) => {
        if (mine !== run) return;
        const parsed = patch.patch ? (parseUnifiedPatch(patch.patch)[0] ?? null) : null;
        const diff = parsed && patch.oldText !== undefined ? { ...parsed, oldText: patch.oldText } : parsed;
        setPatches(f.path, { state: "ok", patch, diff, context: patch.oldText !== undefined ? "idle" : "none" });
      })
      .catch(() => mine === run && setPatches(f.path, { context: "error" }));
  };
  const contextOf = (f: DiffFileSummary) => {
    const p = patches[f.path];
    return { state: (p?.state === "ok" && p.context) || "idle", load: () => loadContext(f) };
  };
  const ensure = (f: DiffFileSummary | undefined, retry = false) => {
    if (!f) return;
    const cur = patches[f.path];
    if (cur && !(retry && cur.state === "error")) return;
    setPatches(f.path, { state: "loading" });
    queue.push(f);
    pump();
  };

  // ---- steps ----
  const agentSteps = () => !!props.agent?.steps?.length;
  /** The rows turns come from: given, or read once; [] when there is nothing to read. */
  const [transcript, setTranscript] = createSignal<TranscriptItem[] | null>(props.items ?? null);
  const [transcriptError, setTranscriptError] = createSignal<string | null>(null);
  // A memo, so a new scope object for the same session (a card's details re-read on every new
  // transcript row) never refetches: on() re-fires on any read signal, not on a changed value.
  const sessionPath = createMemo(() => props.scope.sessionPath);
  createEffect(
    on(
      sessionPath,
      (path) => {
        if (props.items || agentSteps()) return;
        setTranscript(null);
        fetchTranscriptWithContext(path)
          .then((r) => path === sessionPath() && setTranscript(r.items))
          .catch((err: Error) => {
            setTranscriptError(err.message);
            setTranscript([]);
          });
      },
    ),
  );
  const turns = createMemo(() => (agentSteps() ? [] : turnsFromItems(transcript() ?? [])));
  /** Files whose hunks the steps need: the ones a turn edited, or an agent step names. */
  const needed = createMemo(() => {
    const s = summary();
    if (!s) return [] as DiffFileSummary[];
    const names = new Set<string>();
    const agent = props.agent?.steps;
    if (agent?.length) for (const st of agent) for (const h of st.hunks) names.add(repoPath(h.path, s.repo, s.repo) ?? h.path);
    else for (const t of turns()) for (const e of t.edits) {
      const p = repoPath(e.path, props.cwd ?? s.repo, s.repo);
      if (p) names.add(p);
    }
    return files().filter((f) => names.has(f.path) || (f.oldPath !== undefined && names.has(f.oldPath)));
  });
  createEffect(on(needed, (list) => list.forEach((f) => ensure(f))));
  const stepsReady = () => (agentSteps() || transcript() !== null) && needed().every((f) => patches[f.path] && patches[f.path]!.state !== "loading");
  const plan = createMemo<StepPlan | null>(() => {
    const s = summary();
    if (!s || !stepsReady()) return null;
    const need = new Set(needed().map((f) => f.path));
    const stepFiles: StepFile[] = files().map((f) => {
      const p = patches[f.path];
      const hunks = need.has(f.path) && p?.state === "ok" && p.diff ? p.diff.hunks : null;
      return { path: f.path, oldPath: f.oldPath, hunks };
    });
    const agent = props.agent?.steps;
    if (agent?.length) return stepsFromAgent(agent, stepFiles, s.repo);
    return stepsFromTurns(turns(), stepFiles, props.cwd ?? s.repo, s.repo);
  });
  const allSteps = createMemo(() => {
    const p = plan();
    return p ? [...p.steps, ...(p.other ? [p.other] : [])] : [];
  });
  const stepById = (id: string) => allSteps().find((s) => s.id === id);
  const stepByN = (n: number) => plan()?.steps.find((s) => s.n === n);

  // The first view: the first step once the steps are placed, else the first file.
  createEffect(() => {
    if (pick() || !summary()) return;
    const p = plan();
    if (p === null) return;
    const first = p.steps[0] ?? null;
    if (first) setPick({ kind: "step", id: first.id });
    else if (ordered()[0]) setPick({ kind: "file", path: ordered()[0]!.path });
  });

  const current = createMemo(() => {
    const p = pick();
    if (!p) return null;
    if (p.kind === "file") {
      const f = byPath().get(p.path);
      return f ? ({ kind: "file", file: f } as const) : null;
    }
    const s = stepById(p.id);
    return s ? ({ kind: "step", step: s } as const) : null;
  });
  // Read what the right pane shows.
  createEffect(() => {
    const c = current();
    if (c?.kind === "file") ensure(c.file);
    else if (c?.kind === "step") c.step.files.forEach((p) => ensure(byPath().get(p)));
  });

  // At folded width a pick swaps the list for the diff, and Back swaps it back: focus follows, or
  // it would fall to the page with the control that held it.
  let side: HTMLElement | undefined;
  let back: HTMLButtonElement | undefined;
  const folded = () => !!back && back.offsetParent !== null;
  const showDiff = () => {
    setView("diff");
    if (folded())
      queueMicrotask(() => diffPane?.focus({ preventScroll: true }));
  };
  const showList = () => {
    setView("list");
    queueMicrotask(() => (side?.querySelector<HTMLElement>('[aria-current="true"] button, button[aria-current="true"]') ?? side)?.focus());
  };
  const openFile = (path: string) => {
    setPick({ kind: "file", path });
    showDiff();
  };
  const openStep = (id: string) => {
    setPick({ kind: "step", id });
    showDiff();
  };
  const toggleFold = (path: string) =>
    setClosedDirs((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  const toggleViewed = (path: string) =>
    setViewed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const wide = () => paneWidth() >= SPLIT_MIN;
  const layout = (): DiffLayout => (diffLayout() === "split" && wide() ? "split" : "unified");
  const paneHidden = () => changesPaneHidden();
  // Split can fit once the left pane is hidden: the diff pane then takes the list's width too.
  const widenable = () => !wide() && !paneHidden() && paneWidth() + sideWidth() >= SPLIT_MIN;
  const widenForSplit = () => {
    batch(() => {
      setChangesPaneHidden(true);
      setDiffLayout("split");
    });
  };
  // The diff pane mounts once the summary is in, and again after a reload: measure whichever is
  // there, and the list beside it (0 while hidden).
  let diffPane: HTMLDivElement | undefined;
  let sidePane: HTMLElement | undefined;
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === diffPane) setPaneWidth(entry.contentRect.width);
      else if (entry.target === sidePane) setSideWidth((entry.target as HTMLElement).offsetWidth);
    }
  });
  onCleanup(() => ro.disconnect());
  const measure = (el: HTMLDivElement) => {
    if (diffPane) ro.unobserve(diffPane);
    diffPane = el;
    ro.observe(el);
  };
  const measureSide = (el: HTMLElement) => {
    side = el;
    if (sidePane) ro.unobserve(sidePane);
    sidePane = el;
    ro.observe(el);
  };
  // A new pick starts at the top of the diff pane.
  createEffect(on(pick, () => diffPane?.scrollTo?.({ top: 0 }), { defer: true }));

  const title = () => props.agent?.title || (summary() ? scopeTitle(summary()!) : "Changes");
  const totals = () => {
    const f = files();
    return countsLine(f.length, f.reduce((s, x) => s + x.added, 0), f.reduce((s, x) => s + x.removed, 0));
  };

  return (
    <div
      class="changes"
      data-view={view()}
      data-pane={paneHidden() ? "hidden" : "shown"}
      aria-busy={loading() ? "true" : undefined}
    >
      <div class="changes-head">
        <button
          type="button"
          class="button button-icon button-ghost changes-pane-toggle"
          aria-pressed={!paneHidden()}
          aria-label={paneHidden() ? "Show Files and Steps" : "Hide Files and Steps"}
          title={paneHidden() ? "Show files and steps" : "Hide files and steps"}
          onClick={() => setChangesPaneHidden(!paneHidden())}
        >
          <Icon name={paneHidden() ? "panel-expand" : "panel-collapse"} />
        </button>
        <div class="changes-titles">
          <h2 class="changes-title" id={props.titleId}>
            {title()}
          </h2>
          <p class="changes-meta text-caption text-muted">
            <Show when={summary()} fallback={loading() ? "Reading the diff…" : ""}>
              {props.agent?.title ? `${scopeTitle(summary()!)} · ` : ""}
              {totals()}
              <Show when={summary()!.truncated}> · the first {summary()!.files.length} of {summary()!.totals.files} files</Show>
            </Show>
          </p>
        </div>
        <button
          type="button"
          class="button button-sm button-ghost changes-refresh"
          aria-label="Refresh Changes"
          title="Read the diff again. Nothing is changed."
          aria-disabled={loading() ? "true" : undefined}
          onClick={() => !loading() && void load()}
        >
          <Icon name="refresh" small />
          <span class="changes-refresh-label">Refresh</span>
        </button>
        <Show when={props.onClose}>
          <button type="button" class="button button-icon button-ghost" aria-label="Close" title="Close" onClick={() => props.onClose?.()}>
            <Icon name="close" />
          </button>
        </Show>
      </div>

      <Switch>
        <Match when={!summary() && error()}>
          {(message) => (
            <div class="changes-empty" role="alert">
              <p>Couldn't read these changes. Nothing was changed. {message()}</p>
              <button type="button" class="button button-sm" onClick={() => void load()}>
                Try Again
              </button>
            </div>
          )}
        </Match>
        <Match when={!summary()}>
          <div class="changes-empty" aria-hidden="true">
            <span class="skeleton skeleton-line" />
            <span class="skeleton skeleton-line" />
            <span class="skeleton skeleton-line" />
          </div>
        </Match>
        <Match when={files().length === 0}>
          <div class="changes-empty">
            <p>{summary()!.totals.files > 0 ? "None of the changed files is in the paths the agent named." : `${scopeTitle(summary()!)}: no changes.`}</p>
          </div>
        </Match>
        <Match when={summary()}>
          <div class="changes-body">
            <nav class="changes-side" aria-label="Files and steps" ref={measureSide} tabindex="-1">
              <div class="changes-side-bar">
                <h3 class="text-eyebrow">Files</h3>
                <span class="changes-spacer" />
                <button type="button" class="button button-sm button-ghost" onClick={() => setClosedDirs(new Set<string>())}>
                  Expand All
                </button>
                <button type="button" class="button button-sm button-ghost" onClick={() => setClosedDirs(new Set(allDirs(tree())))}>
                  Collapse All
                </button>
              </div>
              <ul class="changes-tree" role="list">
                <For each={rows()}>
                  {(row) => (
                    <TreeItem
                      row={row}
                      current={isPick(pick(), "file", row.path)}
                      viewed={viewed().has(row.path)}
                      steps={plan()?.byFile[row.path] ?? []}
                      currentStep={currentStepN(pick(), stepById)}
                      onFold={toggleFold}
                      onFile={openFile}
                      onStep={(n) => {
                        const s = stepByN(n);
                        if (s) openStep(s.id);
                      }}
                    />
                  )}
                </For>
              </ul>
              <div class="changes-side-bar">
                <h3 class="text-eyebrow">Steps</h3>
              </div>
              <Show
                when={plan()}
                fallback={
                  <p class="changes-note text-caption text-muted" role="status">
                    Placing hunks into steps · {needed().filter((f) => patches[f.path]?.state === "ok" || patches[f.path]?.state === "error").length} of{" "}
                    {needed().length} files read
                  </p>
                }
              >
                {(p) => (
                  <>
                    <Show when={transcriptError()}>
                      {(message) => <p class="changes-note text-caption text-muted">Couldn't read this session's transcript, so there are no steps. {message()}</p>}
                    </Show>
                    <Show when={!transcriptError() && allSteps().length > 0 && p().steps.length === 0 && !agentSteps()}>
                      <p class="changes-note text-caption text-muted">No turn in this session made these changes.</p>
                    </Show>
                    <ol class="changes-steps" role="list">
                      <For each={allSteps()}>
                        {(s) => (
                          <li>
                            <button
                              type="button"
                              class="changes-step-row"
                              aria-current={isPick(pick(), "step", s.id) ? "true" : undefined}
                              onClick={() => openStep(s.id)}
                            >
                              <span class="changes-step-n" classList={{ "changes-step-other": s.n === 0 }} aria-hidden={s.n === 0 ? "true" : undefined}>
                                {s.n ? stepMark(s.n) : "·"}
                              </span>
                              <span class="changes-step-title">{s.title}</span>
                              <Show when={s.buildsOn.length}>
                                <span class="changes-step-builds text-caption text-muted">builds on {s.buildsOn.map(stepMark).join(" ")}</span>
                              </Show>
                            </button>
                          </li>
                        )}
                      </For>
                    </ol>
                    <Show when={p().unmatched.length}>
                      <p class="changes-note text-caption text-muted">
                        {p().unmatched.length === 1 ? "1 step the agent wrote names" : `${p().unmatched.length} steps the agent wrote name`} nothing in this diff:{" "}
                        {p().unmatched.join("; ")}.
                      </p>
                    </Show>
                  </>
                )}
              </Show>
            </nav>

            <section class="changes-main" aria-label="Diff">
              <div class="changes-main-bar">
                <button type="button" class="button button-sm button-ghost changes-back" ref={back} onClick={showList}>
                  <Icon name="chevron-left" small />
                  Back
                </button>
                <div class="changes-main-name">
                  <Show when={current()}>{(c) => <CurrentName current={c()} />}</Show>
                </div>
                <Show when={current()?.kind === "file" && current()}>
                  {(c) => {
                    const f = () => (c() as { kind: "file"; file: DiffFileSummary }).file;
                    return (
                      <label class="changes-viewed text-caption">
                        <input type="checkbox" checked={viewed().has(f().path)} onChange={() => toggleViewed(f().path)} />
                        Viewed
                      </label>
                    );
                  }}
                </Show>
                <DiffLayoutToggle
                  layout={layout()}
                  splitAllowed={wide()}
                  onChange={setDiffLayout}
                  widen={widenable() ? widenForSplit : undefined}
                  widenHint="Needs a wider pane — hides the file list"
                  narrowReason="Too narrow for two sides, even without the file list"
                />
              </div>
              <div class="changes-main-body" ref={measure} tabindex="-1">
                <Switch fallback={<p class="changes-note text-caption text-muted">Placing hunks into steps…</p>}>
                  <Match when={current()?.kind === "file" && current()}>
                    {(c) => (
                      <FileBody
                        file={(c() as { kind: "file"; file: DiffFileSummary }).file}
                        patch={patches[(c() as { kind: "file"; file: DiffFileSummary }).file.path]}
                        plan={plan()}
                        layout={layout()}
                        onStep={openStep}
                        onRetry={(f) => ensure(f, true)}
                        context={contextOf}
                      />
                    )}
                  </Match>
                  <Match when={current()?.kind === "step" && current()}>
                    {(c) => (
                      <StepBody
                        step={(c() as { kind: "step"; step: Step }).step}
                        files={byPath()}
                        patches={patches}
                        layout={layout()}
                        onFile={openFile}
                        onStep={(n) => {
                          const s = stepByN(n);
                          if (s) openStep(s.id);
                        }}
                        onRetry={(f) => ensure(f, true)}
                        context={contextOf}
                      />
                    )}
                  </Match>
                </Switch>
              </div>
            </section>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

const isPick = (p: Pick | null, kind: Pick["kind"], key: string) => (p?.kind === "file" ? kind === "file" && p.path === key : p?.kind === "step" && kind === "step" && p.id === key);

function currentStepN(p: Pick | null, stepById: (id: string) => Step | undefined): number | null {
  if (p?.kind !== "step") return null;
  return stepById(p.id)?.n ?? null;
}

/** A status letter with its word for assistive tech and on hover. */
function StatusMark(props: { status: DiffFileSummary["status"] }) {
  return (
    <span class={`changes-status changes-status-${props.status}`} title={STATUS_WORD[props.status]}>
      <span aria-hidden="true">{props.status}</span>
      <span class="visually-hidden">{STATUS_WORD[props.status]}</span>
    </span>
  );
}

function Counts(props: { added: number; removed: number }) {
  return <DiffStat added={props.added} removed={props.removed} class="changes-counts text-mono" />;
}

/** One tree row: a folder that folds, or a file with its steps. */
function TreeItem(props: {
  row: TreeRow<DiffFileSummary>;
  current: boolean;
  viewed: boolean;
  steps: number[];
  currentStep: number | null;
  onFold(path: string): void;
  onFile(path: string): void;
  onStep(n: number): void;
}) {
  const indent = () => ({ "--depth": String(props.row.depth) }) as JSX.CSSProperties;
  return (
    <Show
      when={props.row.kind === "file" && props.row}
      fallback={(() => {
        const d = props.row as Extract<TreeRow<DiffFileSummary>, { kind: "dir" }>;
        return (
          <li>
            <button type="button" class="changes-row changes-dir" style={indent()} aria-expanded={!d.folded} onClick={() => props.onFold(d.path)}>
              <Icon name={d.folded ? "chevron-right" : "chevron-down"} small />
              <Icon name="folder" small />
              <span class="changes-row-name text-mono">{d.name}/</span>
              <Show when={d.folded}>
                <span class="changes-dir-sum text-caption text-muted">
                  {d.files} {d.files === 1 ? "file" : "files"}
                </span>
                <Counts added={d.added} removed={d.removed} />
              </Show>
            </button>
          </li>
        );
      })()}
    >
      {(r) => (
        <li class="changes-file" aria-current={props.current ? "true" : undefined}>
          <button type="button" class="changes-row" style={indent()} title={r().file.oldPath ? `${r().file.oldPath} → ${r().path}` : r().path} onClick={() => props.onFile(r().path)}>
            <StatusMark status={r().file.status} />
            <span class="changes-row-name text-mono">{r().name}</span>
            <Show when={props.viewed}>
              <span class="changes-viewed-mark" title="Viewed">
                <Icon name="check" small />
                <span class="visually-hidden">Viewed</span>
              </span>
            </Show>
            <Counts added={r().file.added} removed={r().file.removed} />
          </button>
          <For each={props.steps}>
            {(n) => (
              <button
                type="button"
                class="changes-step-chip"
                aria-pressed={props.currentStep === n}
                aria-label={`Step ${n}`}
                title={`Show step ${n}`}
                onClick={() => props.onStep(n)}
              >
                {stepMark(n)}
              </button>
            )}
          </For>
        </li>
      )}
    </Show>
  );
}

/** The diff pane's header text: the file's path (a rename as "old → new") and counts, or the step. */
function CurrentName(props: { current: { kind: "file"; file: DiffFileSummary } | { kind: "step"; step: Step } }) {
  return (
    <Show
      when={props.current.kind === "file" && (props.current as { file: DiffFileSummary }).file}
      fallback={(() => {
        const s = (props.current as { step: Step }).step;
        return (
          <span class="changes-main-title">
            <Show when={s.n}>
              <span class="changes-step-n">{stepMark(s.n)}</span>{" "}
            </Show>
            {s.title}
          </span>
        );
      })()}
    >
      {(f) => (
        <span class="changes-main-title text-mono" title={f().path}>
          <StatusMark status={f().status} />{" "}
          <Show when={f().oldPath}>
            <span class="text-muted">{f().oldPath} → </span>
          </Show>
          {f().path} <Counts added={f().added} removed={f().removed} />
        </span>
      )}
    </Show>
  );
}

/** A patch's state when there is no diff to draw: reading, failed, binary, too large, mode only. */
function PatchNote(props: { file: DiffFileSummary; patch: PatchState | undefined; onRetry(f: DiffFileSummary): void }) {
  const p = () => props.patch;
  return (
    <Switch fallback={<p class="changes-note text-caption text-muted">Reading {props.file.path}…</p>}>
      <Match when={p()?.state === "error" && (p() as { message: string })}>
        {(e) => (
          <div class="changes-note text-caption">
            <p>Couldn't read this file's diff. {e().message}</p>
            <button type="button" class="button button-sm" onClick={() => props.onRetry(props.file)}>
              Try Again
            </button>
          </div>
        )}
      </Match>
      <Match when={p()?.state === "ok" && (p() as { patch: DiffFilePatch }).patch}>
        {(patch) => (
          <p class="changes-note text-caption text-muted">
            {patch().binary || props.file.status === "B"
              ? "A binary file: there are no lines to show."
              : patch().tooLarge
                ? `This file's diff is over ${Math.round(patch().tooLarge!.cap / 1_000_000)} MB, so it isn't shown. +${props.file.added} −${props.file.removed}.`
                : "Only the file's mode changed."}
          </p>
        )}
      </Match>
    </Switch>
  );
}

/** Consecutive hunk indexes grouped by the step that holds them, in file order. */
function runsByStep(plan: StepPlan | null, path: string, count: number): { n: number; step: Step | null; hunks: number[] }[] {
  const steps = plan ? [...plan.steps, ...(plan.other ? [plan.other] : [])] : [];
  const stepOf = (i: number) => steps.find((s) => s.hunks.some((r) => r.path === path && (r.hunk === i || r.hunk < 0))) ?? null;
  const runs: { n: number; step: Step | null; hunks: number[] }[] = [];
  for (let i = 0; i < count; i++) {
    const s = stepOf(i);
    const last = runs.at(-1);
    if (last && last.step === s) last.hunks.push(i);
    else runs.push({ n: s?.n ?? 0, step: s, hunks: [i] });
  }
  return runs;
}

/** One whole file; with steps, each run of hunks under the step that made it. */
function FileBody(props: {
  file: DiffFileSummary;
  patch: PatchState | undefined;
  plan: StepPlan | null;
  layout: DiffLayout;
  onStep(id: string): void;
  onRetry(f: DiffFileSummary): void;
  context(f: DiffFileSummary): { state: ContextState; load(): void };
}) {
  const diff = () => (props.patch?.state === "ok" ? props.patch.diff : null);
  const context = () => props.context(props.file);
  return (
    <Show when={diff()} fallback={<PatchNote file={props.file} patch={props.patch} onRetry={props.onRetry} />}>
      {(d) => (
        <Show when={props.plan && props.plan.steps.length > 0} fallback={<DiffView file={d()} layout={props.layout} splitMinWidth={0} header={false} context={context()} />}>
          {/* By position, so a run's view (and its open folds) outlives a re-read of the file. */}
          <Index each={runsByStep(props.plan, props.file.path, d().hunks.length)}>
            {(run) => (
              <div class="changes-run">
                <Show when={run().step}>
                  {(s) => (
                    <button type="button" class="changes-run-head" onClick={() => props.onStep(s().id)}>
                      <span class="changes-step-n" classList={{ "changes-step-other": s().n === 0 }}>
                        {s().n ? stepMark(s().n) : "·"}
                      </span>
                      <span class="changes-step-title">{s().title}</span>
                    </button>
                  )}
                </Show>
                <DiffView file={d()} hunks={run().hunks} layout={props.layout} splitMinWidth={0} header={false} context={context()} />
              </div>
            )}
          </Index>
        </Show>
      )}
    </Show>
  );
}

/** One step: its why and "builds on", then its hunks file by file under headers that open the file. */
function StepBody(props: {
  step: Step;
  files: Map<string, DiffFileSummary>;
  patches: Record<string, PatchState>;
  layout: DiffLayout;
  onFile(path: string): void;
  onStep(n: number): void;
  onRetry(f: DiffFileSummary): void;
  context(f: DiffFileSummary): { state: ContextState; load(): void };
}) {
  return (
    <div class="changes-step">
      <Show when={props.step.note || props.step.buildsOn.length || props.step.source === "other"}>
        <div class="changes-step-about">
          <Show when={props.step.source === "other"}>
            <p class="text-caption text-muted">Hunks no step made: edits by hand, by other tools, or by another session.</p>
          </Show>
          <Show when={props.step.note}>
            <p>{props.step.note}</p>
          </Show>
          <Show when={props.step.buildsOn.length}>
            <p class="changes-builds text-caption">
              Builds on
              <For each={props.step.buildsOn}>
                {(n) => (
                  <button type="button" class="changes-step-chip" aria-label={`Step ${n}`} title={`Show step ${n}`} onClick={() => props.onStep(n)}>
                    {stepMark(n)}
                  </button>
                )}
              </For>
            </p>
          </Show>
        </div>
      </Show>
      <For each={props.step.files}>
        {(path) => {
          const f = () => props.files.get(path);
          const patch = () => props.patches[path];
          const diff = () => {
            const p = patch();
            return p?.state === "ok" ? p.diff : null;
          };
          return (
            <Show when={f()}>
              {(file) => (
                <div class="changes-step-file">
                  <button type="button" class="changes-file-head" title={`Open ${file().path}`} onClick={() => props.onFile(file().path)}>
                    <StatusMark status={file().status} />
                    <span class="changes-row-name text-mono">
                      <Show when={file().oldPath}>
                        <span class="text-muted">{file().oldPath} → </span>
                      </Show>
                      {file().path}
                    </span>
                    <Counts added={file().added} removed={file().removed} />
                  </button>
                  <Show when={diff()} fallback={<PatchNote file={file()} patch={patch()} onRetry={props.onRetry} />}>
                    {(d) => <DiffView file={d()} hunks={stepHunksOf(props.step, path) ?? undefined} layout={props.layout} splitMinWidth={0} header={false} context={props.context(file())} />}
                  </Show>
                </div>
              )}
            </Show>
          );
        }}
      </For>
    </div>
  );
}

/** The comparison a show_changes call named, in words. */
function detailsScopeLine(d: ShowChangesDetails): string {
  const s = d.scope;
  if (s.kind === "dirty") return `Uncommitted changes in ${tildePath(s.root, home())}`;
  if (s.kind === "worktree") return `${s.branch} against ${s.baseRef} in ${tildePath(s.root, home())}`;
  return `Commit ${s.sha.slice(0, 7)} in ${tildePath(s.root, home())}`;
}

/**
 * An agent's show_changes result (§chat.changes/show-changes-card): what it compares, its title,
 * how many steps it wrote, and Review Changes, which opens the viewer on it with those steps.
 */
export function ShowChangesCard(props: { details: ShowChangesDetails }) {
  const session = useChangesSession();
  const [open, setOpen] = createSignal(false);
  const d = () => props.details;
  const steps = () => d().steps?.length ?? 0;
  return (
    <div class="card changes-card" role="note" aria-label={d().title ?? detailsScopeLine(d())}>
      <div class="changes-card-main">
        <span class="icon icon-sm" style={{ "--icon": "url(/icons/file.svg)" }} aria-hidden="true" />
        <div class="changes-card-text">
          <p class="changes-card-title">{d().title ?? "Changes to review"}</p>
          <p class="changes-card-meta text-caption text-muted">
            <span class="text-mono">{detailsScopeLine(d())}</span>
            <Show when={steps()}>
              {" "}
              · {steps()} {steps() === 1 ? "step" : "steps"}
            </Show>
            <Show when={d().paths?.length}>
              {" "}
              · limited to {d().paths!.length} {d().paths!.length === 1 ? "path" : "paths"}
            </Show>
          </p>
        </div>
        <Show when={session}>
          <button type="button" class="button button-sm" onClick={() => setOpen(true)}>
            Review Changes
          </button>
        </Show>
      </div>
      <Show when={open() && session}>
        {(s) => (
          <ChangesDialog
            scope={scopeFromDetails(d(), s().path)}
            cwd={s().cwd}
            agent={{ title: d().title, paths: d().paths, steps: d().steps }}
            onClose={() => setOpen(false)}
          />
        )}
      </Show>
    </div>
  );
}
