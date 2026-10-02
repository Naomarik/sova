import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { SESSION_TITLE_MAX, type SessionSummary } from "../../shared/protocol";
import { assignSessionGroup, setSessionArchived } from "../lib/api";
import { renameSession } from "../lib/session-actions";
import { inPlaceTitleEnd } from "../lib/title-field";
import {
  archiveSummary,
  beginSelectionAction,
  clearSelection,
  finishSelectionAction,
  groupMoveSummary,
  selectedPaths,
  selectedSessions,
  selectionBusy,
  selectionPlan,
} from "../lib/session-selection";
import { createGroup, groupNameOf, loadSessionGroups, quoted, sessionGroups } from "../lib/session-groups";
import { announce, toast } from "../lib/ui-state";
import { ActionMenu } from "./ActionMenu";
import { GroupNameField } from "./Groups";
import { Icon } from "./ui";

/** "3 sessions" / "1 session" — every sentence and label in here counts the same way. */
const sessionsWord = (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`;

/**
 * One inline title field: the sidebar's Rename, for the single selected session.
 * Enter saves, Escape cancels, and an
 * EMPTY field clears the user's title so the session goes back to the one derived from its first
 * message — which is why this can't be `GroupNameField`, where empty means cancel.
 */
export function TitleField(props: {
  initial: string;
  label: string;
  onDone(title: string | null): void;
  onCancel(): void;
  /** The hint the field is described by (default: the toolbar's own). */
  describedBy?: string;
  /** Leaving the field saves what's in it, and cancels when it's empty — the in-place rename of a
      row, where a field left open under a moving list would be lost. The toolbar's stays open.
      Such a field also cancels, on Enter or leaving, when it still holds the title it opened with
      (`inPlaceTitleEnd`): the row's title may have moved under it. */
  blurSaves?: boolean;
}) {
  const opened = props.initial;
  const [value, setValue] = createSignal(props.initial);
  const end = (via: "enter" | "leave") => {
    const r = inPlaceTitleEnd(opened, value(), via);
    return () => (r ? props.onDone(r.save) : props.onCancel());
  };
  let input!: HTMLInputElement;
  let settled = false;
  const finish = (act: () => void) => {
    if (settled) return;
    settled = true;
    act();
  };
  return (
    <form
      class="group-field session-title-field"
      aria-label={props.label}
      onSubmit={(e) => {
        e.preventDefault();
        finish(props.blurSaves ? end("enter") : () => props.onDone(value().trim() ? value().trim() : null));
      }}
    >
      <input
        ref={(el) => {
          input = el;
          queueMicrotask(() => {
            input.focus();
            input.select();
          });
        }}
        class="input"
        type="text"
        maxlength={SESSION_TITLE_MAX}
        placeholder="Session title"
        aria-label={props.label}
        aria-describedby={props.describedBy ?? "selection-rename-hint"}
        value={value()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation(); // Escape belongs to the field while it is open, not to the mode
          finish(() => props.onCancel());
        }}
        onBlur={(e) => {
          if (!props.blurSaves) return;
          // Onto the field's own Save button: the submit settles it.
          if (e.relatedTarget instanceof Node && e.currentTarget.form?.contains(e.relatedTarget)) return;
          finish(end("leave"));
        }}
      />
      <button type="submit" class="button button-sm">
        Save
      </button>
    </form>
  );
}

/**
 * The selection toolbar: what the
 * sidebar offers the sessions that are selected right now. It lives INSIDE the sidebar, above the
 * list, so the rows it acts on stay on screen under a thumb as well as a mouse.
 *
 * Rename is a one-session gesture and disappears at two — a single field cannot mean two titles.
 * Archive points one way for the whole selection: all-archived unarchives, none-archived
 * archives, and a mix is disabled with the count of each, because guessing which half the user
 * meant is how a bulk gesture loses work. Everything it skipped or failed on is said ONCE, in one
 * sentence, and stays selected so the user can see what is left.
 */
export function SelectionToolbar(props: { sessions: SessionSummary[]; onRefresh(): void }) {
  const chosen = createMemo(() => selectedSessions(props.sessions, selectedPaths()) as SessionSummary[]);
  /** An organization's or a project's session: it lives in that region, never in a group. */
  const ownedRow = (path: string): boolean => {
    const x = props.sessions.find((r) => r.path === path);
    return !!(x?.org || x?.project);
  };
  const plan = createMemo(() => selectionPlan(chosen()));
  const [renaming, setRenaming] = createSignal(false);
  /** An action in flight belongs to the TAB, not to this component instance: the toolbar is
      rebuilt whenever selection mode is re-entered, and a fresh `busy` signal in a fresh instance
      is exactly how a finished run came back and wrote over a newer selection. */
  const busy = selectionBusy;

  /** The one selected session's path, or "" — a MEMO, so the effect below fires when the
      SELECTION changes and not on every poll that hands us a fresh list of the same rows. */
  const renameTarget = createMemo(() => (plan().canRename ? (chosen()[0]?.path ?? "") : ""));
  const one = () => chosen()[0];
  // A field left open would otherwise keep the old session's title over a new one's row.
  createEffect(on(renameTarget, () => setRenaming(false), { defer: true }));

  /**
   * Run one action under the tab's lock. Everything it needs off the selection is read BEFORE the
   * first await (the action's own snapshot), and what it leaves over is applied through
   * `finishSelectionAction`, which drops it on the floor if the tab has moved on. `keep`
   * `undefined` means "this action has nothing to say about the selection" — a rename.
   */
  const run = async (act: () => Promise<readonly string[] | undefined>) => {
    const token = beginSelectionAction();
    if (token === null) return; // another action holds the tab; the controls already say so
    let keep: readonly string[] | undefined;
    try {
      keep = await act();
    } finally {
      finishSelectionAction(token, keep);
    }
  };

  const saveTitle = (title: string | null) =>
    run(async () => {
      const s = one();
      setRenaming(false);
      if (!s) return undefined;
      if (await renameSession(s, title)) props.onRefresh();
      return undefined; // a rename never moves the selection
    });

  /** Archive (or unarchive) everything eligible, then say what happened in one sentence. */
  const runArchive = () =>
    run(async () => {
      const p = plan(); // the plan this press was made against, read before the first request
      if (p.disabled) return undefined;
      const archived = p.mode === "archive";
      const failed: { path: string; reason: string }[] = [];
      let done = 0;
      for (const s of p.eligible) {
        try {
          await setSessionArchived(s.path, archived);
          done++;
        } catch (err) {
          failed.push({ path: s.path, reason: (err as Error).message });
        }
      }
      const failedPaths = new Set(failed.map((f) => f.path));
      const org = p.eligible.filter((s) => !failedPaths.has(s.path) && ownedRow(s.path)).length;
      const sentence = archiveSummary({ mode: p.mode, done, blocked: p.blocked, failed, org });
      toast(sentence);
      announce(sentence);
      props.onRefresh(); // one refresh for the whole run, not one per row
      // What it couldn't do stays selected and visible; a clean run ends the mode.
      return [...p.blocked.map((b) => b.session.path), ...failed.map((f) => f.path)];
    });

  /**
   * Move `paths` into `groupId` (null takes them out of their groups). The paths are a PARAMETER,
   * not a read of `chosen()` inside the loop: "New group…" has to create the group first, and by
   * the time that request lands the selection may be a different one. What is moved is what was
   * selected when the menu row was pressed.
   */
  const movePaths = async (groupId: string | null, paths: readonly string[]): Promise<string[]> => {
    const failed: string[] = [];
    let done = 0;
    // Organization sessions are never put in a group (the server refuses too): skipped, and said
    // once. Taking one out of a group made before that rule is still allowed.
    const isOrg = (path: string) => groupId !== null && ownedRow(path);
    const skippedOrg = paths.filter(isOrg).length;
    for (const path of paths.filter((p) => !isOrg(p))) {
      try {
        await assignSessionGroup(path, groupId);
        done++;
      } catch {
        failed.push(path); // counted once in the sentence below, never a toast per row
      }
    }
    const sentence = groupMoveSummary({ done, groupName: groupId ? groupNameOf(sessionGroups(), groupId) : null, failed: failed.length, skippedOrg });
    toast(sentence);
    announce(sentence);
    props.onRefresh();
    return failed;
  };

  const moveToGroup = (groupId: string | null, paths: readonly string[]) =>
    run(async () => (paths.length === 0 ? undefined : await movePaths(groupId, paths)));

  /**
   * "New group…": two requests, ONE action. The sessions are snapshotted before the group is
   * created — the tab is locked for the whole thing, so the selection cannot move under it, and
   * the snapshot is what makes that true even if it somehow did.
   */
  const createAndMove = (name: string) =>
    run(async () => {
      const paths = chosen().map((s) => s.path);
      if (paths.length === 0) return undefined;
      const group = await createGroup(name); // toasts its own failure
      return group ? await movePaths(group.id, paths) : undefined;
    });

  /** What every control says instead of running while an action is in flight. One sentence, so
      the reason is the same wherever it is read — a row, a button, a menu item. */
  const running = () => (busy() ? "Something is still running. It'll be a moment." : "");

  const archiveLabel = () => (plan().mode === "unarchive" ? "Unarchive" : "Archive");
  const archiveAria = () => `${archiveLabel()} ${sessionsWord(plan().mode === "mixed" ? plan().count : plan().eligible.length)}`;
  /** The reason Archive can't run. There is no note line (the bar is one row), so the reason
      lives where every user meets it before the press: the control's own accessible name and
      title. */
  const archiveBlock = () => (busy() ? running() : plan().disabled);
  const archiveName = () => (archiveBlock() ? `${archiveAria()}. ${archiveBlock()}` : archiveAria());
  /** A disabled control names itself and its reason. */
  const withReason = (name: string) => (running() ? `${name}. ${running()}` : name);

  return (
    <div class="sidebar-select-bar" role="group" aria-label="Selected sessions">
      {/* One row: the count leads and takes the leftover width; the actions are one cluster at
          the right end — Move, then Rename, then Archive, and Cancel after a wider step, so it
          reads as the way out rather than a fifth action. */}
      <div class="sidebar-select-row">
        <p class="sidebar-select-count" aria-live="polite">
          <span class="text-num">{plan().count}</span> selected
        </p>
        <div class="sidebar-select-actions">
        <ActionMenu
          label={`Move ${sessionsWord(plan().count)} into a group`}
          title="Move into group"
          text="Move"
          icon={null}
          caret={false}
          class="button-sm sidebar-select-move"
          align="start"
        >
          {(menu) => (
            <Show
              when={menu.screen() === "new"}
              fallback={
                <div class="model-menu-list" role="menu" aria-label="Move into group">
                  <div class="model-menu-group" role="group" aria-label="Groups">
                    <div class="list-group-label">Groups</div>
                    {/* "No group" first, exactly as the one-session menu orders it. */}
                    {/* Each row snapshots the selection AT THE PRESS and moves exactly that. */}
                    <menu.Item
                      label="No group"
                      aria={`Take ${sessionsWord(plan().count)} out of their groups`}
                      icon={<Icon name="close" small />}
                      disabled={running()}
                      onRun={() => void moveToGroup(null, chosen().map((x) => x.path))}
                    />
                    <For each={sessionGroups()}>
                      {(g) => (
                        <menu.Item
                          label={g.name}
                          aria={`Move ${sessionsWord(plan().count)} to ${quoted(g.name)}`}
                          icon={<Icon name="folder" small />}
                          disabled={running()}
                          onRun={() => void moveToGroup(g.id, chosen().map((x) => x.path))}
                        />
                      )}
                    </For>
                  </div>
                  <div class="model-menu-group" role="group" aria-label="New group">
                    <menu.Item
                      label="New group…"
                      aria="Make a group and move these sessions into it"
                      icon={<Icon name="plus" small />}
                      disabled={running()}
                      stayOpen
                      onRun={() => {
                        void loadSessionGroups();
                        menu.show("new");
                      }}
                    />
                  </div>
                </div>
              }
            >
              <div class="group-menu-screen">
                <GroupNameField
                  label="New group name"
                  onDone={(name) => {
                    menu.dismiss();
                    void createAndMove(name);
                  }}
                  onCancel={() => menu.dismiss()}
                />
              </div>
            </Show>
          )}
        </ActionMenu>
        {/* Rename: only ever at one session. At two there is nothing for one field to mean. */}
        <Show when={plan().canRename}>
          <button
            type="button"
            class="button button-sm button-icon"
            aria-label={withReason("Rename this session")}
            aria-expanded={renaming() ? "true" : "false"}
            aria-disabled={busy() ? "true" : undefined}
            title={running() || (one()?.originalTitle ? `Renamed in Sova. Originally ${quoted(one()!.originalTitle!)}` : "Rename this session in Sova")}
            onClick={() => !busy() && setRenaming((r) => !r)}
          >
            <Icon name="pencil" />
          </button>
        </Show>
        <button
          type="button"
          class={plan().mode === "unarchive" ? "button button-sm button-icon sidebar-select-archive" : "button button-sm button-icon button-destructive sidebar-select-archive"}
          aria-label={archiveName()}
          aria-disabled={plan().disabled || busy() ? "true" : undefined}
          title={running() || (plan().disabled ? archiveName() : archiveAria())}
          onClick={() => !busy() && void runArchive()}
        >
          <Icon name="archive" />
        </button>
        {/* Cancel is refused while an action runs: leaving the mode mid-run is exactly how a
            finished run came back to a tab that had moved on. */}
        <button
          type="button"
          class="button button-sm button-ghost sidebar-select-cancel"
          aria-label={withReason("Cancel")}
          aria-disabled={busy() ? "true" : undefined}
          title={running() || undefined}
          onClick={() => !busy() && clearSelection()}
        >
          Cancel
        </button>
        </div>
      </div>
      {/* The open rename field is the one thing below the row; its hint is the field's description. */}
      <Show when={renaming() && plan().canRename}>
        <div class="sidebar-select-rename">
          <TitleField
            initial={one()?.title ?? ""}
            label={`Rename ${quoted(one()?.title ?? "this session")}`}
            onDone={(title) => void saveTitle(title)}
            onCancel={() => setRenaming(false)}
          />
          <p class="sidebar-select-note" id="selection-rename-hint">
            Kept in Sova only — the session's own transcript isn't touched. Empty restores {quoted(one()?.originalTitle ?? one()?.title ?? "its first message")}.
          </p>
        </div>
      </Show>
    </div>
  );
}
