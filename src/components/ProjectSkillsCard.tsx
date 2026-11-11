import { createSignal, For, Index, type JSX, Show } from "solid-js";
import type { ApprovalRow, ApprovalSource, ApprovalState } from "../../shared/approvals";
import type { ProjectSkillRow } from "../../shared/project-skills";
import { getProjectContextFiles, getProjectSkills, setProjectContextFiles, setProjectSkills } from "../lib/api";
import { ACTION_DECISION, ACTION_WORD, CHANGED_LINE, PARTIAL_FINGERPRINT_LINE, rowActions, stateChip, stateWord, type Approval } from "../lib/approvals";
import { begin, EMPTY, failed, inOrder, projectQueue, settled, type Overlay } from "../lib/approval-overlay";
import { createPoll } from "../lib/poll";
import { shortDescription } from "../lib/project-skills";
import { toast } from "../lib/ui-state";

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
 * One list of what a folder's new chats may load (context files, or skills): grouped by where each
 * comes from, each row with its state and its buttons. Kept on this computer; a click shows the
 * decision at once and saves it behind the row (lib/approval-overlay), reaching new chats only; a
 * refusal or failure puts the row back, with its toast.
 */
export function ApprovalsCard(props: {
  id: string;
  title: string;
  /** What the list holds, in words, for its empty state and its errors ("context files", "skills"). */
  what: string;
  list: ApprovalsList | undefined;
  error: string | null;
  decide(change: Record<string, ApprovalState>): Promise<void>;
  extra?: JSX.Element;
  /** Whose list: a project's (the default) or a folder's that isn't one. */
  folder?: "project" | "folder";
  /** The folder's save queue (lib/approval-overlay): its saves go out in click order, whichever surface made them. */
  queue: string;
}) {
  const [overlay, setOverlay] = createSignal<Overlay>(EMPTY);
  let saves = 0;
  const act = (r: ApprovalRow, a: keyof typeof ACTION_WORD) => {
    const id = ++saves;
    const to = ACTION_DECISION[a];
    setOverlay((o) => begin(o, [r.key], to, id));
    // The PUT answers with the whole list, which then carries the decision: the row is the server's again.
    inOrder(props.queue, () => props.decide({ [r.key]: to }))
      .then(() => setOverlay((o) => settled(o, id)))
      .catch((err: Error) => {
        setOverlay((o) => failed(o, id));
        toast(`Couldn't save ${r.name}. ${err.message}`);
      });
  };
  /** A row's decision as shown: the one clicked while it saves, else the server's. */
  const shown = (r: ApprovalRow): Approval => overlay()[r.key]?.to ?? approvalOf(r);
  return (
    <section class="card orgs-section project-skills" aria-labelledby={props.id}>
      <h2 class="orgs-h2" id={props.id}>
        {props.title}
      </h2>
      <p class="orgs-line">
        {props.list?.asking
          ? `New chats load the ${props.what} you approve. Open chats keep theirs.`
          : `New chats load these ${props.what}, except the ones you disallow. Open chats keep theirs.`}
      </p>
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
              <For each={groupsFor(props.folder ?? "project").filter((g) => l().rows.some((r) => r.source.kind === g.kind)).map((g) => g.label)}>
                {(label) => {
                  const g = () => groupsFor(props.folder ?? "project").find((x) => x.label === label)!;
                  return (
                  <div class="project-settings-group">
                    <span class="text-eyebrow">{label}</span>
                    <ul class="list project-skills-rows">
                      <Index each={l().rows.filter((r) => r.source.kind === g().kind)}>
                        {(r) => (
                          <li class="list-row project-skill-row" title={r().path}>
                            <div class="list-main">
                              <span class="list-title">
                                <span class="text-mono">{r().name}</span>
                                <Show when={r().source.folder}>{(f) => <span class="project-skill-source">{f()}</span>}</Show>
                              </span>
                              <Show when={shown(r()) === "changed"}>
                                <span class="list-meta project-skill-changed">{CHANGED_LINE}</span>
                              </Show>
                              <Show when={shortDescription(r().description)}>{(t) => <span class="list-meta">{t()}</span>}</Show>
                              <Show when={r().fingerprintPartial}>
                                <span class="list-meta">{PARTIAL_FINGERPRINT_LINE}</span>
                              </Show>
                            </div>
                            <span class={`chip ${stateChip(shown(r()), l().asking)}`}>
                              <i class="chip-dot" />
                              {stateWord(shown(r()), l().asking)}
                            </span>
                            <div class="project-skill-actions">
                              <For each={rowActions(shown(r()), l().asking, "card")}>
                                {(a) => (
                                  <button
                                    type="button"
                                    class="button button-sm"
                                    aria-label={`${ACTION_WORD[a]} ${r().name}`}
                                    onClick={() => act(r(), a)}
                                  >
                                    {ACTION_WORD[a]}
                                  </button>
                                )}
                              </For>
                            </div>
                          </li>
                        )}
                      </Index>
                    </ul>
                  </div>
                  );
                }}
              </For>
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
      decide={async (change) => {
        poll.set(await setProjectSkills(props.projectId, change));
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
      decide={async (change) => {
        poll.set(await setProjectContextFiles(props.projectId, change));
        props.onChanged?.();
      }}
    />
  );
}
