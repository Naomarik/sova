import { createSignal, For, Show } from "solid-js";
import type { ProjectSkillRow, ProjectSkillState, ProjectSkillsView } from "../../shared/project-skills";
import { getProjectSkills, setProjectSkills } from "../lib/api";
import { createPoll } from "../lib/poll";
import { approveLabel, disallowLabel, shortDescription, SKILLS_CARD_HINT, SKILLS_CARD_NONE, sourceLabel, STATE_CHIP, STATE_WORD } from "../lib/project-skills";
import { toast } from "../lib/ui-state";

const SKILLS_POLL_MS = 30_000;

/**
 * The project page's Skills card: every skill a chat in this project could be offered, each Approved,
 * Disallowed or Waiting, with Approve and Disallow. Kept on this computer; a click saves at once and
 * reaches new chats only.
 */
export function ProjectSkillsCard(props: { projectId: string; /** After a save: All settings reads again. */ onChanged?: () => void }) {
  const poll = createPoll<ProjectSkillsView>(() => getProjectSkills(props.projectId), SKILLS_POLL_MS, { cacheKey: `project:${props.projectId}:skills` });
  const [busy, setBusy] = createSignal<string | null>(null);
  const decide = (row: ProjectSkillRow, state: Exclude<ProjectSkillState, "waiting">) => {
    if (busy() || row.state === state) return;
    setBusy(row.name);
    setProjectSkills(props.projectId, { [row.name]: state })
      .then((next) => {
        poll.set(next);
        props.onChanged?.();
      })
      .catch((err: Error) => toast(`Couldn't save ${row.name}. ${err.message}`))
      .finally(() => setBusy(null));
  };
  return (
    <section class="card orgs-section project-skills" aria-labelledby="project-skills">
      <h2 class="orgs-h2" id="project-skills">
        Skills
      </h2>
      <p class="orgs-line">{SKILLS_CARD_HINT}</p>
      <Show when={poll.error() && !poll.data()}>
        <p class="field-error">Couldn't read the project's skills. {poll.error()}</p>
      </Show>
      <Show when={poll.data()} fallback={<Show when={!poll.error()}><div class="skeleton skeleton-line" /></Show>}>
        {(d) => (
          <Show when={d().skills.length} fallback={<p class="orgs-line">{SKILLS_CARD_NONE}</p>}>
            <ul class="list project-skills-rows">
              <For each={d().skills}>
                {(r) => (
                  <li class="list-row project-skill-row" title={r.path}>
                    <div class="list-main">
                      <span class="list-title">
                        <span class="text-mono">{r.name}</span>
                        <span class="project-skill-source">{sourceLabel(r.source)}</span>
                      </span>
                      <Show when={shortDescription(r.description)}>{(t) => <span class="list-meta">{t()}</span>}</Show>
                    </div>
                    <span class={`chip ${STATE_CHIP[r.state]}`}>
                      <i class="chip-dot" />
                      {STATE_WORD[r.state]}
                    </span>
                    <div class="project-skill-actions">
                      <button
                        type="button"
                        class="button button-sm"
                        aria-label={approveLabel(r.name)}
                        aria-pressed={r.state === "approved"}
                        aria-disabled={busy() !== null || r.state === "approved" ? "true" : undefined}
                        onClick={() => decide(r, "approved")}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        class="button button-sm"
                        aria-label={disallowLabel(r.name)}
                        aria-pressed={r.state === "disallowed"}
                        aria-disabled={busy() !== null || r.state === "disallowed" ? "true" : undefined}
                        onClick={() => decide(r, "disallowed")}
                      >
                        Disallow
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </section>
  );
}
