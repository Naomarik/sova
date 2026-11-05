import { createEffect, createMemo, createResource, createSignal, For, Index, on, type JSX, Show, untrack } from "solid-js";
import type { FolderRef, MergeQueueSettings, MergeSettingsChange, ModelChoice, SettingSource } from "../../../shared/merge-queue-settings";
import type { ModelPick } from "../../../shared/powers";
import { cancelMergeSettings, listProjects, putMergeModels, saveMergeSettings } from "../../lib/api";
import { folderGroup } from "../../lib/folder-sources";
import { fileCount } from "../../lib/folder-viewer";
import { tildePath } from "../../lib/format";
import { short } from "../../lib/merge-queue";
import { mergeChanged, readQueue } from "../../lib/merge-queue-client";
import { showsPushToOrigin } from "../../lib/merge-queue-requests";
import {
  changeLines,
  changesOf,
  draftProblem,
  minutesTextOf,
  typedMinutes,
  checksCaption,
  minutes,
  modelWords,
  minutesRule,
  rebaseDraft,
  refusalWords,
  pendingSaveTitle,
  saveResultWords,
  freshChatWords,
  SOURCE_TAG,
  threadFolderCaption,
  toProjectDraft,
  type ProjectDraft,
} from "../../lib/merge-queue-settings";
import { discardStaged, stagedDirty, stagedEdit, stageEdit } from "../../lib/merge-queue-settings-draft";
import { sortProjects } from "../../lib/projects";
import { projectTabHref } from "../../lib/projects-route";
import { closeSettings } from "../../lib/settings-nav";
import { announce, home, toast } from "../../lib/ui-state";
import { FolderViewer } from "../FolderViewer";
import { notSetUp, requestInitialize } from "../../lib/merge-queue-initialize";
import { ModelPickButton } from "../ModelPickButton";
import { NumberField, Select, Toggle } from "../form";
import { Banner } from "../ui";
import { MergeQueueLandHow, MergeQueueLandSuggestion } from "./MergeQueueLandHow";
import "./MergeQueueSettings.css";

/** Checks shown before Show N More. */
const CHECKS_SHOWN = 4;

/**
 * Settings → Merge Queue: one project's queue settings, as the queue uses them (the values on its
 * target), grouped Landing, Checks, Before the checks, Review, Merge thread and Where it checks, each
 * row tagged with where it lives. The switches and numbers the project file holds are edited here and
 * saved onto the target as one commit after a confirm; the review's and merge thread's models are
 * this computer's, saved on pick. `project`: the one whose page opened it; else the picker's first.
 */
export function MergeQueueSettingsSection(props: { project: string | null }) {
  const [projects] = createResource(async () => sortProjects((await listProjects()).projects).live);
  const [picked, setPicked] = createSignal<string | null>(props.project);
  /** A switch asked for over unsaved edits: the project it would switch to. */
  const [askSwitch, setAskSwitch] = createSignal<string | null>(null);
  // Queue Settings pressed on another project's page while this tab shows: follow it, asking first over unsaved edits.
  createEffect(
    on(
      () => props.project,
      (p) => {
        if (!p) return;
        if (stagedDirty() && stagedEdit()?.project !== p) setAskSwitch(p);
        else setPicked(p);
      },
      { defer: true },
    ),
  );
  const switchName = () => projects()?.find((p) => p.id === askSwitch())?.name ?? "the other project";
  const current = createMemo(() => {
    const list = projects() ?? [];
    return list.find((p) => p.id === picked()) ?? list[0] ?? null;
  });
  return (
    <section class="settings-delegate mqs" aria-labelledby="settings-mq-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="settings-mq-title">
          Merge queue
        </h3>
        <Show when={(projects() ?? []).length > 0}>
          <Select
            class="mqs-project"
            label="Project"
            value={current()?.id ?? ""}
            options={(projects() ?? []).map((p) => ({ value: p.id, label: p.name }))}
            onChange={(next, el) => {
              // Unsaved edits of another project's settings: ask before they go.
              if (stagedDirty() && stagedEdit()?.project !== next) {
                el.value = current()?.id ?? "";
                setAskSwitch(next);
                return;
              }
              setPicked(next);
            }}
          />
        </Show>
      </div>
      <Show when={askSwitch()}>
        <Banner
          tone="warn"
          title={`Your changes to ${projects()?.find((p) => p.id === stagedEdit()?.project)?.name ?? "this project"}'s queue settings aren't saved.`}
          body={`Save them first, or discard them and switch to ${switchName()}.`}
          action={
            <span class="button-row">
              <button type="button" class="button button-sm button-ghost" onClick={() => setAskSwitch(null)}>
                Keep Editing
              </button>
              <button
                type="button"
                class="button button-sm"
                onClick={() => {
                  discardStaged();
                  setPicked(askSwitch());
                  setAskSwitch(null);
                }}
              >
                Discard and Switch
              </button>
            </span>
          }
        />
      </Show>
      <p class="settings-intro">What the merge queue uses for each landing. Values in the project file are read from its target branch; the models are kept on this computer.</p>
      <Show when={!projects.loading} fallback={<p class="text-caption text-muted">Reading the projects.</p>}>
        <Show when={current()} fallback={<p class="text-caption text-muted">{projects.error ? `Couldn't read the projects. ${String(projects.error)}` : "No projects yet. Add one on the Projects page and its queue shows here."}</p>}>
          {(p) => <ProjectQueueSettings projectId={p().id} root={p().root} />}
        </Show>
      </Show>
    </section>
  );
}

/** One project's settings, read through its queue view. Keyed by root, so a picker change reads afresh. */
function ProjectQueueSettings(props: { projectId: string; root: string }) {
  const root = createMemo(() => props.root);
  const [view, { refetch }] = createResource(root, (r) => readQueue(r));
  createEffect(on(mergeChanged, () => void refetch(), { defer: true }));
  return (
    <Show when={view()} fallback={<p class="text-caption text-muted">{view.error ? `Couldn't read this project's merge queue. ${String(view.error)}` : "Reading the merge queue."}</p>}>
      {(v) => (
        <Show when={!notSetUp(v())} fallback={<NotServed projectId={props.projectId} target={v().target} settings={v().settings} />}>
        <Show
          when={v().settings}
          fallback={
            <p class="text-caption text-muted">
              {v().invalid ? "This project's .sova/project.json doesn't parse, so its queue settings can't be read. " : "This project's merge queue isn't set up yet. "}
              <a href={projectTabHref(props.projectId, "merge-queue")} onClick={() => closeSettings()}>
                Open Its Merge Queue
              </a>
            </p>
          }
        >
          {(s) => <SettingsBody projectId={props.projectId} settings={s()} hasOrigin={v().heads.hasOrigin ?? !!v().heads.pushed} running={!!v().current} onChanged={() => void refetch()} />}
        </Show>
        </Show>
      )}
    </Show>
  );
}

/** A project the queue doesn't serve (no merge setup): the Merge Queue tab's words; Initialize opens that tab straight on its setup. */
function NotServed(props: { projectId: string; target: string; settings: MergeQueueSettings | undefined }) {
  return (
    <div class="mqs-body">
      <Banner
        tone="info"
        title="No merge queue settings are set up for this project"
        body={`Until they are, its chats merge branches into ${props.target} themselves when you ask.`}
        action={
          <a
            class="button button-sm"
            href={projectTabHref(props.projectId, "merge-queue")}
            onClick={() => {
              requestInitialize(props.projectId);
              closeSettings();
            }}
          >
            Initialize
          </a>
        }
      />
      <MergeQueueLandSuggestion settings={props.settings} />
    </div>
  );
}

function Tag(props: { source: SettingSource }) {
  return <span class="mqs-tag">{SOURCE_TAG[props.source]}</span>;
}

function Row(props: { label: JSX.Element; children: JSX.Element; end?: JSX.Element; hint?: JSX.Element; id?: string }) {
  return (
    <>
      <div class="mqs-row" id={props.id}>
        <span class="mqs-label">{props.label}</span>
        <span class="mqs-value">{props.children}</span>
        <span class="mqs-end">{props.end}</span>
      </div>
      <Show when={props.hint}>
        <p class="mqs-hint">{props.hint}</p>
      </Show>
    </>
  );
}

function Group(props: { title: string; caption?: string | null; children: JSX.Element }) {
  const id = `mqs-group-${props.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div class="mqs-group" role="group" aria-labelledby={id}>
      <h4 class="mqs-group-title" id={id}>
        {props.title}
        <Show when={props.caption}>
          <span class="mqs-group-caption"> {props.caption}</span>
        </Show>
      </h4>
      {props.children}
    </div>
  );
}

const asPick = (m: ModelChoice | null | undefined): ModelPick | null => (m ? ({ model: m.model, ...(m.thinking ? { thinking: m.thinking } : {}) } as ModelPick) : null);

function SettingsBody(props: { projectId: string; settings: MergeQueueSettings; hasOrigin: boolean; running: boolean; onChanged(): void }) {
  const s = () => props.settings;
  const blocked = () => s().editBlocked ?? null;
  const pending = () => s().pendingSave ?? null;
  /** Why the waiting save couldn't be applied, when it couldn't. */
  const pendingFailed = () => (pending() as { failed?: string } | null)?.failed ?? null;
  // The form's copy of the project-file values: the staged edit (module state, kept across tabs and
  // holding the dialog's close) when it is this project's, else master's values.
  const mine = () => {
    const e = stagedEdit();
    return e && e.project === props.projectId ? e : null;
  };
  const draft = (): ProjectDraft => mine()?.draft ?? toProjectDraft(s(), props.hasOrigin);
  const setDraft = (d: ProjectDraft) => stageEdit({ project: props.projectId, base: s(), hasOrigin: props.hasOrigin, draft: d });
  // A newer read of master: the edits stay, every field left alone follows it.
  const values = createMemo(() => JSON.stringify(toProjectDraft(s(), props.hasOrigin)));
  createEffect(
    on(
      values,
      () => {
        const e = untrack(mine);
        if (!e) return;
        stageEdit({ ...e, base: s(), hasOrigin: props.hasOrigin, draft: rebaseDraft(e.draft, toProjectDraft(e.base, e.hasOrigin), toProjectDraft(s(), props.hasOrigin)) });
      },
      { defer: true },
    ),
  );
  const changes = createMemo(() => changesOf(draft(), s(), props.hasOrigin));
  /** A time-limit box that isn't one: the save waits, saying which. */
  const problem = createMemo(() => draftProblem(draft(), s()));
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [said, setSaid] = createSignal<string | null>(null);
  /** The request a save opened (Open PR / Open MR), beside what it said. */
  const [saidLink, setSaidLink] = createSignal<{ href: string; label: string } | null>(null);
  const [showAll, setShowAll] = createSignal(false);
  const [folder, setFolder] = createSignal<"review" | "thread" | null>(null);
  /** The controls a project-file edit uses: off while the file has an uncommitted edit, a save waits, or one is in flight. */
  const locked = () => !!blocked() || !!pending() || busy();
  const target = () => s().landing.target;
  const pushesAfter = () => draft().push && props.hasOrigin;
  /** The project lands by request or by pushing a branch: a save goes out the same way, not onto the target. */
  const how = () => s().how?.effective ?? "local";
  const byRequest = () => how() !== "local";
  const saveVerb = () => (how() === "github-pr" ? "Open a PR" : how() === "gitlab-mr" ? "Open an MR" : "Push a Branch");
  const viaWords = () =>
    how() === "github-pr" ? ` in a PR into ${target()}` : how() === "gitlab-mr" ? ` in an MR into ${target()}` : how() === "push-branch" ? ` on a branch pushed to origin` : ` as 1 commit on ${target()}`;

  const editCheck = (id: string, next: Partial<ProjectDraft["checks"][string]>) => {
    const d = draft();
    const cur = d.checks[id];
    if (!cur) return;
    setDraft({ ...d, checks: { ...d.checks, [id]: { ...cur, ...next } } });
    setSaid(null);
    setSaidLink(null);
  };

  const save = async (ch: MergeSettingsChange) => {
    setBusy(true);
    setError(null);
    try {
      const r = await saveMergeSettings(props.projectId, ch);
      const w = saveResultWords(r, { target: target(), pushes: pushesAfter(), gitlab: s().how?.effective === "gitlab-mr" });
      const m = w.text;
      setSaid(m);
      setSaidLink(w.link ?? null);
      toast(m);
      announce(m);
      setConfirming(false);
      discardStaged();
      props.onChanged();
    } catch (err) {
      const m = refusalWords(err);
      setError(m);
      announce(m);
    } finally {
      setBusy(false);
    }
  };
  const cancelPending = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancelMergeSettings(props.projectId);
      const m = "Cancelled the waiting save. Nothing changed.";
      setSaid(m);
      setSaidLink(null);
      announce(m);
      props.onChanged();
    } catch (err) {
      setError(refusalWords(err));
    } finally {
      setBusy(false);
    }
  };

  const shownChecks = () => (showAll() ? s().checks.list : s().checks.list.slice(0, CHECKS_SHOWN));
  const capMin = () => Math.floor(s().fixed.checkMaxMin);

  return (
    <div class="mqs-body">
      <p class="text-caption text-muted mqs-from">
        From {target()} at <span class="text-mono">{short(s().at)}</span>
      </p>
      <Show when={s().projectFileDiffers}>
        <p class="mqs-note" role="note">
          The project folder's <span class="text-mono">.sova/project.json</span> differs from {target()}'s. These are {target()}'s values, which the queue uses.
        </p>
      </Show>
      <Show when={blocked()}>{(b) => <p class="mqs-note mqs-blocked">{b()}.</p>}</Show>
      <Show when={pending()}>
        <Banner
          tone={pendingFailed() ? "warn" : "info"}
          title={pendingSaveTitle(pending()!, !!pendingFailed())}
          body={`${changeLines(pending()!.changes, s()).join("; ")}.${pendingFailed() ? ` ${pendingFailed()!.replace(/[.]$/, "")}.` : ""}`}
          action={
            <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => void cancelPending()}>
              Cancel Save
            </button>
          }
        />
      </Show>

      <Group title="Landing">
        <MergeQueueLandHow project={props.projectId} target={target()} settings={s()} editBlocked={s().editBlocked} onSaved={props.onChanged} />
        <Row label="Lands into" end={<Tag source="project" />}>
          <span class="text-mono">{target()}</span>
        </Row>
        <Show when={showsPushToOrigin(s().how?.effective)}>
          <Row label="Push after each landing" end={<Tag source="project" />} hint={!props.hasOrigin ? "This project has no origin, so nothing is pushed." : undefined}>
            <Toggle label={draft().push ? "On" : "Off"} checked={draft().push} disabled={locked() || !props.hasOrigin} onChange={(on) => setDraft({ ...draft(), push: on })} />
          </Row>
        </Show>
        <Row label="Private names" end={<Tag source="computer" />}>
          {s().landing.names.setUp ? `Set up · ${s().landing.names.count} name${s().landing.names.count === 1 ? "" : "s"}` : "Not set up"}
        </Row>
      </Group>

      <Group title="Checks" caption={checksCaption(s().checks)}>
        <Show when={s().checks.mode === "declared" && s().checks.list.length > 0} fallback={<Row label="Checks" end={<Tag source="project" />}>{s().checks.mode === "test-command" ? "The project's test command" : "None declared"}</Row>}>
          <Index each={shownChecks()}>
            {(c) => {
              const d = () => draft().checks[c().id] ?? { timeoutSec: c().timeoutSec, rerun: c().rerun, optional: c().optional };
              // What was typed lives in the staged edit (kept across tabs, cleared by a discard or a save),
              // so a box that isn't a time limit holds the save instead of saving the last good number.
              const text = () => minutesTextOf(draft(), c().id, s());
              return (
                <Row label={c().label} end={<Tag source="project" />}>
                  <span class="mqs-check">
                    <NumberField
                      label={`${c().label}: time limit in minutes`}
                      hideLabel
                      rule={minutesRule(capMin(), c().label)}
                      value={text()}
                      disabled={locked()}
                      afterClass="mqs-minutes"
                      after={<span class="text-caption text-muted">min</span>}
                      onInput={(v) => {
                        setDraft(typedMinutes(draft(), c().id, v, s()));
                        setSaid(null);
                        setSaidLink(null);
                      }}
                    />
                    <Toggle label="Reruns failed files" checked={d().rerun} disabled={locked()} onChange={(on) => editCheck(c().id, { rerun: on })} />
                    <Select
                      label={`${c().label}: when it runs`}
                      hideLabel
                      value={d().optional ? "picked" : "always"}
                      options={[
                        { value: "always", label: "Every time" },
                        { value: "picked", label: "Only when picked" },
                      ]}
                      disabled={locked()}
                      onChange={(v) => editCheck(c().id, { optional: v === "picked" })}
                    />
                  </span>
                </Row>
              );
            }}
          </Index>
          <Show when={s().checks.list.length > CHECKS_SHOWN}>
            <button type="button" class="button button-sm button-ghost mqs-more" aria-expanded={showAll()} onClick={() => setShowAll(!showAll())}>
              {showAll() ? "Show Fewer" : `Show ${s().checks.list.length - CHECKS_SHOWN} More`}
            </button>
          </Show>
        </Show>
        <Row label="Longest a check runs" end={<Tag source="sova" />}>
          {s().fixed.checkMaxMin} min
        </Row>
      </Group>

      <Group title="Before the checks">
        <Row label="Setup" end={<Tag source="project" />}>
          {s().setup.steps.length ? `${s().setup.steps.length} step${s().setup.steps.length === 1 ? "" : "s"}: ${s().setup.steps.map((x) => x.label ?? x.id).join(", ")}` : "None"}
        </Row>
        <Row label="Install" end={<Tag source="project" />}>
          <Show when={s().install} fallback="None">
            {(i) => `When ${i().inputs.length ? i().inputs.join(", ") : "its inputs"} change${i().inputs.length === 1 ? "s" : ""} · ${minutes(i().timeoutSec)}`}
          </Show>
        </Row>
        <Row label="A failed setup" end={<Tag source="sova" />}>
          Tried again once after {s().fixed.setupRetrySec} s
        </Row>
      </Group>

      <Group title="Review">
        <Row label="Review each landing" end={<Tag source="project" />} hint={!draft().review && !s().review.canTurnOn ? "Turning it on needs the review folder on the target: .sova/playbooks/review." : undefined}>
          <Toggle label={draft().review ? "On" : "Off"} checked={draft().review} disabled={locked() || (!s().review.on && !s().review.canTurnOn)} onChange={(on) => setDraft({ ...draft(), review: on })} />
        </Row>
        <Row
          label="Instructions"
          end={
            <Show when={s().review.kit}>
              <button type="button" class="button button-sm" aria-expanded={folder() === "review"} onClick={() => setFolder(folder() === "review" ? null : "review")}>
                {folder() === "review" ? "Close Folder" : "Open Folder"}
              </button>
            </Show>
          }
        >
          <Show when={s().review.kit} fallback="None">
            {(k) => (
              <>
                <span class="text-mono">{k()}</span> · {fileCount(s().review.files.length)}
              </>
            )}
          </Show>
        </Row>
        <Show when={folder() === "review" && s().review.kit}>
          <FolderViewer
            id="mqs-review-folder"
            title="Review instructions"
            subtitle="Read only. To change them, edit them in a branch; it lands through the queue."
            groups={[folderGroup({ id: "review", label: s().review.folder?.label ?? "Review instructions", source: s().review.folder?.source ?? { kind: "project", project: props.projectId, ref: s().at, dir: s().review.kit! } })]}
            onClose={() => setFolder(null)}
          />
        </Show>
        <ModelRow projectId={props.projectId} which="review" settings={s()} onChanged={props.onChanged} />
        <Row label="Time limit" end={<Tag source="sova" />}>
          {s().fixed.reviewTimeoutMin} min, tried {s().fixed.reviewTries === 2 ? "twice" : `${s().fixed.reviewTries} times`}, then the queue pauses
        </Row>
      </Group>

      <Group title="Merge thread">
        <ModelRow projectId={props.projectId} which="thread" settings={s()} onChanged={props.onChanged} />
        <Row
          label="Instructions"
          end={
            <Show when={s().thread.playbooks.length > 0}>
              <button type="button" class="button button-sm" aria-expanded={folder() === "thread"} onClick={() => setFolder(folder() === "thread" ? null : "thread")}>
                {folder() === "thread" ? "Close Folder" : "Open Folder"}
              </button>
            </Show>
          }
        >
          <span class="text-muted">{threadSources(s().thread.playbooks)}</span>
        </Row>
        <Show when={threadFolderCaption(s())}>{(c) => <p class="mqs-hint">{c()}</p>}</Show>
        <Show when={folder() === "thread"}>
          <FolderViewer
            id="mqs-thread-folder"
            title="Merge thread instructions"
            subtitle="Sova's method first, then this project's own; the project's wins where they differ."
            groups={s().thread.playbooks.map((p, i) => folderGroup({ id: `thread-${i}`, label: p.label, source: p.source }))}
            onClose={() => setFolder(null)}
          />
        </Show>
        <Row label="Fresh chat" end={<Tag source="sova" />}>
          {freshChatWords(s().fixed)}
        </Row>
      </Group>

      <Group title="Where it checks">
        <Row label="Merge copy" end={<Tag source="sova" />}>
          <span class="text-mono">{tildePath(s().fixed.mergeCopy, home())}</span>
        </Row>
      </Group>

      <Show when={changes() || problem() || said() || error()}>
        <div class="mqs-save" role="region" aria-label="Save to the project file">
          <Show when={error()}>{(e) => <Banner tone="error" title="Couldn't save the queue settings." body={`${e().replace(/[.]$/, "")}. Nothing changed on ${target()}.`} />}</Show>
          <Show when={said() && !changes() && !problem()}>
            <p class="text-caption" role="status">
              {said()}
              <Show when={saidLink()}>
                {(l) => (
                  <>
                    {" "}
                    <a href={l().href} target="_blank" rel="noopener noreferrer">
                      {l().label}
                    </a>
                  </>
                )}
              </Show>
            </p>
          </Show>
          <Show when={changes() || problem()}>
            {(_) => (
              <Show
                when={confirming() && changes() && !problem()}
                fallback={
                  <div class="spread mqs-save-row">
                    <Show
                      when={problem()}
                      fallback={
                        <span class="text-caption">
                          {changeLines(changes()!, s()).length} change{changeLines(changes()!, s()).length === 1 ? "" : "s"} to the project file.
                        </span>
                      }
                    >
                      {(p) => (
                        <span class="field-error" id="mqs-save-problem">
                          {p()}
                        </span>
                      )}
                    </Show>
                    <span class="button-row">
                      <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => discardStaged()}>
                        Discard Changes
                      </button>
                      <button
                        type="button"
                        class="button button-sm button-primary"
                        disabled={locked() || !!problem() || !changes()}
                        aria-describedby={problem() ? "mqs-save-problem" : undefined}
                        onClick={() => setConfirming(true)}
                      >
                        {byRequest() ? saveVerb() : `Save to ${target()}`}…
                      </button>
                    </span>
                  </div>
                }
              >
                <div class="mqs-confirm" role="group" aria-label="Confirm the save">
                  <p class="text-body">
                    Save {changeLines(changes()!, s()).length === 1 ? "this change" : "these changes"} to <span class="text-mono">.sova/project.json</span> {viaWords()}?
                  </p>
                  <ul class="mqs-confirm-list">
                    <For each={changeLines(changes()!, s())}>{(l) => <li>{l}</li>}</For>
                  </ul>
                  <p class="text-caption text-muted">
                    {byRequest() ? `It applies once it's merged into ${target()}.` : "It applies from the next landing and isn't checked first."}
                    {props.running && !byRequest() ? " A branch is being checked now, so it saves when that branch finishes." : ""}
                    {pushesAfter() && !byRequest() ? " It goes to origin with the next landing." : ""}
                  </p>
                  <div class="button-row">
                    <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => setConfirming(false)}>
                      Cancel
                    </button>
                    <button type="button" class="button button-sm button-primary" disabled={locked() || !!problem() || !changes()} onClick={() => { const ch = changes(); if (ch && !problem()) void save(ch); }}>
                      {busy() ? "Saving…" : props.running && !byRequest() ? "Save When It Finishes" : byRequest() ? saveVerb() : `Save to ${target()}`}
                    </button>
                  </div>
                </div>
              </Show>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** "Sova's method, then this project's own" from the playbooks the thread reads, in order. */
function threadSources(list: readonly FolderRef[]): string {
  if (!list.length) return "None";
  return list.map((p) => p.label).join(", then ");
}

/** A model row: what it starts on, Change (the shared picker), and Use New-Chat Model to clear a pick. Saved on pick, on this computer. */
function ModelRow(props: { projectId: string; which: "review" | "thread"; settings: MergeQueueSettings; onChanged(): void }) {
  const m = () => (props.which === "review" ? props.settings.review.model : props.settings.thread.model);
  const words = () => modelWords(m());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const applies = () => (props.which === "review" ? "Applies from the next review; one running keeps its model." : "Applies from the next fresh merge thread.");
  const put = async (pick: ModelChoice | null) => {
    setBusy(true);
    setError(null);
    try {
      await putMergeModels(props.projectId, { [props.which]: pick });
      const m = pick ? `Saved the ${props.which === "review" ? "review" : "merge thread"} model. ${applies()}` : `The ${props.which === "review" ? "review" : "merge thread"} uses the new-chat model again. ${applies()}`;
      toast(m);
      announce(m);
      props.onChanged();
    } catch (err) {
      setError(refusalWords(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Model"
      id={`mqs-${props.which}-model`}
      end={
        <span class="button-row mqs-model-actions">
          <Show when={m().picked}>
            <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => void put(null)}>
              Use New-Chat Model
            </button>
          </Show>
          <ModelPickButton
            id={`mqs-${props.which}-pick`}
            label="Change"
            ariaLabel={props.which === "review" ? "Change the review's model" : "Change the merge thread's model"}
            value={asPick(m().picked ?? m().effective)}
            busy={busy()}
            onPick={(p) => void put({ model: p.model, thinking: p.thinking ?? null })}
          />
          <Tag source="computer" />
        </span>
      }
      hint={error() ? `Couldn't save it: ${error()}` : words().why}
    >
      {words().value}
      <Show when={words().today}>{(t) => <span class="text-muted"> ({t()} today)</span>}</Show>
    </Row>
  );
}
