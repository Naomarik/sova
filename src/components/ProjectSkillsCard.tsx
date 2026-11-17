import { createMemo, createSignal, For, Index, type JSX, Show } from "solid-js";
import type { ApprovalRow, ApprovalSaveAnswer, ApprovalSource, ApprovalState } from "../../shared/approvals";
import type { ProjectSkillRow } from "../../shared/project-skills";
import { getProjectContextFiles, getProjectSkills, setProjectContextFiles, setProjectSkills, undoProjectContextFiles, undoProjectSkills } from "../lib/api";
import { cardLine, decideAll, flipTo, groupDoneLine, groupFlip, groupState, isOn, itemsPhrase, markOf, type Approval, type Decision, type ItemKind } from "../lib/approvals";
import { begin, EMPTY, failed, inOrder, projectQueue, settled, type Overlay } from "../lib/approval-overlay";
import { dropUndo, setUndoLine, undoFor } from "../lib/approval-undo";
import { createPoll } from "../lib/poll";
import { shortDescription } from "../lib/project-skills";
import { contextSwitchLabel, skillSwitchLabel, tokenFacts } from "../lib/session-setup";
import { SLASH_NOTE, slashHeading } from "../lib/setup-approvals";
import { toast } from "../lib/ui-state";
import { ChangedLine, GroupHead, GroupSwitch, NewChip, PartialNote, RowSwitch, showsChanged, showsNew, SizeButton, UndoLine } from "./ApprovalSwitches";

const POLL_MS = 30_000;

/** The groups a card lists, in order; a folder that isn't a project says "folder". */
const groupsFor = (folder: "project" | "folder"): { kind: ApprovalSource; label: string }[] => [
  { kind: "project", label: folder === "project" ? "In the project" : "In this folder" },
  { kind: "subfolder", label: "In folders inside it" },
  { kind: "above", label: folder === "project" ? "Above the project" : "Above this folder" },
  { kind: "user", label: "Yours" },
  { kind: "claude", label: "Claude folder" },
];

export const approvalOf = (r: Pick<ApprovalRow, "state" | "changed">): Approval => (r.changed ? "changed" : r.state);

/** A list's view, whichever list it is. */
export interface ApprovalsList {
  rows: (ApprovalRow & { description?: string })[];
  asking: boolean;
  complete: boolean;
}

/**
 * One list of what a folder's new chats may load (context files, or skills), grouped by where each
 * comes from. Each row is one switch, kept for the folder: on, new chats load it. Each group has one
 * switch too (mixed between), and its press leaves a line with Undo under its heading. A row new since
 * (while new items start off) says New; one changed since it was turned on says so, with Accept Change.
 * A flip shows at once and saves behind the row (lib/approval-overlay), reaching new chats only; a
 * refusal or failure puts the row back, with its toast.
 */
export function ApprovalsCard(props: {
  id: string;
  title: string;
  /** What the list holds, in words, for its empty state and its errors ("context files", "skills"). */
  what: "context files" | "skills";
  list: ApprovalsList | undefined;
  error: string | null;
  /** Saves these changes; answers the save's view (its `undo` token after a group save). */
  decide(change: Record<string, ApprovalState>, group?: true): Promise<ApprovalSaveAnswer>;
  /** Undo of a group save, by its token. */
  undo(token: string): Promise<void>;
  extra?: JSX.Element;
  /** Whose list: a project's (the default) or a folder's that isn't one. */
  folder?: "project" | "folder";
  /** The folder's save queue (lib/approval-overlay): its saves go out in click order, whichever surface made them. */
  queue: string;
}) {
  const [overlay, setOverlay] = createSignal<Overlay>(EMPTY);
  const [undoing, setUndoing] = createSignal(false);
  const kind = (): ItemKind => (props.what === "skills" ? "skill" : "context");
  let saves = 0;
  const groupId = (source: string) => `card:${props.what}:${source}`;
  /** Saves rows at one decision, shown at once; `group` names the group switch pressed, and its done line. */
  const save = (rows: ApprovalRow[], to: Decision, what: string, group?: { source: string; text: string }) => {
    if (!rows.length) return;
    const id = ++saves;
    for (const source of new Set(rows.map((r) => r.source.kind))) dropUndo(props.queue, groupId(source));
    setOverlay((o) => begin(o, rows.map((r) => r.key), to, id));
    // The PUT answers with the whole list, which then carries the decision: the row is the server's again.
    inOrder(props.queue, () => props.decide(decideAll(rows, to), group ? true : undefined))
      .then((answer) => {
        setOverlay((o) => settled(o, id));
        if (group && answer.undo) setUndoLine({ queue: props.queue, group: groupId(group.source), text: group.text, token: answer.undo });
      })
      .catch((err: Error) => {
        setOverlay((o) => failed(o, id));
        toast(`Couldn't save ${what}. ${err.message}`);
      });
  };
  const runUndo = (source: string) => {
    const u = undoFor(props.queue, groupId(source));
    if (!u || undoing()) return;
    setUndoing(true);
    inOrder(props.queue, () => props.undo(u.token))
      .catch((err: Error) => toast(err.message))
      .finally(() => {
        dropUndo(props.queue);
        setUndoing(false);
      });
  };
  /** A row's decision as shown: the one flipped while it saves, else the server's. */
  const shown = (r: ApprovalRow): Approval => overlay()[r.key]?.to ?? approvalOf(r);
  const asking = () => !!props.list?.asking;
  const on = (r: ApprovalRow) => isOn(shown(r), asking());
  const asItems = (rows: ApprovalRow[]) => rows.map((r) => ({ kind: kind(), key: r.key, approval: shown(r), row: r }));
  const pressGroup = (source: string, rows: ApprovalRow[]) => {
    const g = groupFlip(asItems(rows), asking());
    save(
      g.rows.map((i) => i.row),
      g.to,
      itemsPhrase(kind() === "context" ? g.rows.length : 0, kind() === "skill" ? g.rows.length : 0),
      { source, text: groupDoneLine(g.rows.length, kind(), g.on) },
    );
  };
  /** One row: its name (a slash command as typed), its marks, its figure, its switch. Reads its row through
      `p.r`, so a fresh read of the list redraws it in place. */
  const CardRow = (p: { r: ApprovalRow & { description?: string } }) => (
    <li class="list-row project-skill-row approval-card-row" classList={{ "approval-row-off": !on(p.r) }} title={p.r.path}>
      <div class="list-main">
        <span class="list-title">
          <span class="text-mono">{p.r.manualOnly ? `/skill:${p.r.name}` : p.r.name}</span>
          <Show when={p.r.source.folder}>{(f) => <span class="project-skill-source">{f()}</span>}</Show>
          <Show when={showsNew(markOf(shown(p.r), asking()))}>
            <NewChip />
          </Show>
        </span>
        <Show when={shortDescription(p.r.description)}>{(t) => <span class="list-meta approval-card-desc">{t()}</span>}</Show>
        <Show when={showsChanged(markOf(shown(p.r), asking())) && on(p.r)}>
          <ChangedLine name={p.r.name} onAccept={() => save([p.r], "approved", p.r.name)} />
        </Show>
        <Show when={p.r.fingerprintPartial}>
          <PartialNote />
        </Show>
      </div>
      <Show when={!p.r.manualOnly && typeof p.r.tokens === "number" ? p.r.tokens : undefined}>
        {(t) => (
          <Show when={kind() === "skill" && typeof p.r.fileTokens === "number"} fallback={<span class="approval-card-size">{tokenFacts(t())}</span>}>
            <SizeButton
              text={tokenFacts(t())}
              title={p.r.name}
              facts={[
                { label: "Description", when: "in every chat", value: tokenFacts(t()) },
                { label: "SKILL.md", when: "when used", value: tokenFacts(p.r.fileTokens!) },
              ]}
            />
          </Show>
        )}
      </Show>
      <RowSwitch
        label={kind() === "skill" ? skillSwitchLabel(p.r.name) : contextSwitchLabel(p.r.source.folder ? `${p.r.source.folder}/${p.r.name}` : p.r.name)}
        on={on(p.r)}
        onFlip={(now) => save([p.r], flipTo(now, asking()), p.r.name)}
      />
    </li>
  );

  /** The rows the source groups list; manual-only skills sit apart, as slash commands. */
  const listed = () => (props.list?.rows ?? []).filter((r) => !r.manualOnly);
  const slash = () => (props.list?.rows ?? []).filter((r) => r.manualOnly);
  return (
    <section class="card orgs-section project-skills" aria-labelledby={props.id}>
      <h2 class="orgs-h2" id={props.id}>
        {props.title}
      </h2>
      <p class="orgs-line">{cardLine(props.what)}</p>
      <Show when={props.error && !props.list}>
        <p class="field-error">
          Couldn't read the {props.what}. {props.error}
        </p>
      </Show>
      <Show when={props.list} fallback={<Show when={!props.error}><div class="skeleton skeleton-line" /></Show>}>
        {(l) => (
          <>
            <Show when={!l().complete}>
              <p class="orgs-line">The search stopped early, so this list may miss some {props.what}.</p>
            </Show>
            <Show when={l().rows.length} fallback={<p class="orgs-line">No {props.what} found. A chat here would load none.</p>}>
              <For each={groupsFor(props.folder ?? "project").filter((g) => listed().some((r) => r.source.kind === g.kind)).map((g) => g.label)}>
                {(label) => {
                  const g = () => groupsFor(props.folder ?? "project").find((x) => x.label === label)!;
                  const rows = createMemo(() => listed().filter((r) => r.source.kind === g().kind));
                  const onCount = () => rows().filter(on).length;
                  return (
                    <div class="project-settings-group approval-card-group">
                      <GroupHead title={label} facts={`${onCount()} of ${rows().length} on`}>
                        <GroupSwitch
                          label={`All ${props.what} ${label.toLowerCase()}`}
                          state={groupState(asItems(rows()), asking())}
                          onPress={() => pressGroup(g().kind, rows())}
                        />
                      </GroupHead>
                      <Show when={undoFor(props.queue, groupId(g().kind))}>{(u) => <UndoLine text={u().text} busy={undoing()} onUndo={() => runUndo(g().kind)} />}</Show>
                      <ul class="list project-skills-rows">
                        <Index each={rows()}>
                          {(r) => <CardRow r={r()} />}
                        </Index>
                      </ul>
                    </div>
                  );
                }}
              </For>
              <Show when={slash().length > 0}>
                <div class="project-settings-group approval-card-group approval-card-slash">
                  <p class="approval-card-slash-head">
                    <span class="text-eyebrow">{slashHeading(slash().length)}</span>
                    <span class="orgs-line">{SLASH_NOTE}</span>
                  </p>
                  <ul class="list project-skills-rows">
                    <Index each={slash()}>{(r) => <CardRow r={r()} />}</Index>
                  </ul>
                </div>
              </Show>
            </Show>
          </>
        )}
      </Show>
      {props.extra}
    </section>
  );
}

/** The project page's Skills card. */
export function ProjectSkillsCard(props: { projectId: string; onChanged?: () => void }) {
  const poll = createPoll(() => getProjectSkills(props.projectId), POLL_MS, { cacheKey: `project:${props.projectId}:skills` });
  return (
    <ApprovalsCard
      id="project-skills"
      title="Skills"
      queue={projectQueue(props.projectId)}
      what="skills"
      list={poll.data() ? { rows: poll.data()!.skills as ProjectSkillRow[], asking: poll.data()!.asking, complete: poll.data()!.complete } : undefined}
      error={poll.error() ?? null}
      decide={async (change, group) => {
        const next = await setProjectSkills(props.projectId, change, group ? { group } : {});
        poll.set(next);
        props.onChanged?.();
        return next;
      }}
      undo={async (token) => {
        poll.set(await undoProjectSkills(props.projectId, token));
        props.onChanged?.();
      }}
    />
  );
}

/** The project page's Context Files card, right before Skills. */
export function ProjectContextCard(props: { projectId: string; onChanged?: () => void }) {
  const poll = createPoll(() => getProjectContextFiles(props.projectId), POLL_MS, { cacheKey: `project:${props.projectId}:context-files` });
  return (
    <ApprovalsCard
      id="project-context"
      title="Context Files"
      queue={projectQueue(props.projectId)}
      what="context files"
      list={poll.data() ? { rows: poll.data()!.files, asking: poll.data()!.asking, complete: poll.data()!.complete } : undefined}
      error={poll.error() ?? null}
      decide={async (change, group) => {
        const next = await setProjectContextFiles(props.projectId, change, group ? { group } : {});
        poll.set(next);
        props.onChanged?.();
        return next;
      }}
      undo={async (token) => {
        poll.set(await undoProjectContextFiles(props.projectId, token));
        props.onChanged?.();
      }}
    />
  );
}
