import { createSignal, For, type JSX, Show } from "solid-js";
import type { ApprovalRow, ApprovalSource, ApprovalState } from "../../shared/approvals";
import type { ProjectSkillRow } from "../../shared/project-skills";
import { getProjectContextFiles, getProjectSkills, setProjectContextFiles, setProjectSkills } from "../lib/api";
import { ACTION_DECISION, ACTION_WORD, CHANGED_LINE, rowActions, stateChip, stateWord, type Approval } from "../lib/approvals";
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
 * comes from, each row with its state and its buttons. Kept on this computer; a click saves at once
 * and reaches new chats only.
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
}) {
  const [busy, setBusy] = createSignal<string | null>(null);
  const act = (r: ApprovalRow, a: keyof typeof ACTION_WORD) => {
    if (busy()) return;
    setBusy(r.key);
    props
      .decide({ [r.key]: ACTION_DECISION[a] })
      .catch((err: Error) => toast(`Couldn't save ${r.name}. ${err.message}`))
      .finally(() => setBusy(null));
  };
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
              <For each={groupsFor(props.folder ?? "project").filter((g) => l().rows.some((r) => r.source.kind === g.kind))}>
                {(g) => (
                  <div class="project-settings-group">
                    <span class="text-eyebrow">{g.label}</span>
                    <ul class="list project-skills-rows">
                      <For each={l().rows.filter((r) => r.source.kind === g.kind)}>
                        {(r) => (
                          <li class="list-row project-skill-row" title={r.path}>
                            <div class="list-main">
                              <span class="list-title">
                                <span class="text-mono">{r.name}</span>
                                <Show when={r.source.folder}>{(f) => <span class="project-skill-source">{f()}</span>}</Show>
                              </span>
                              <Show when={r.changed}>
                                <span class="list-meta project-skill-changed">{CHANGED_LINE}</span>
                              </Show>
                              <Show when={shortDescription(r.description)}>{(t) => <span class="list-meta">{t()}</span>}</Show>
                            </div>
                            <span class={`chip ${stateChip(approvalOf(r), l().asking)}`}>
                              <i class="chip-dot" />
                              {stateWord(approvalOf(r), l().asking)}
                            </span>
                            <div class="project-skill-actions">
                              <For each={rowActions(approvalOf(r), l().asking, "card")}>
                                {(a) => (
                                  <button
                                    type="button"
                                    class="button button-sm"
                                    aria-label={`${ACTION_WORD[a]} ${r.name}`}
                                    aria-disabled={busy() !== null ? "true" : undefined}
                                    aria-busy={busy() === r.key ? "true" : undefined}
                                    onClick={() => act(r, a)}
                                  >
                                    {ACTION_WORD[a]}
                                  </button>
                                )}
                              </For>
                            </div>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                )}
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
