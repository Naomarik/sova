import { createResource, createSignal, For, Show } from "solid-js";
import type { OrgDetail, OrgProject } from "../../shared/orgs";
import type { ProjectUpdate } from "../../shared/owner";
import { ApiError, getProjectUpdates, setProjectOwnerHidden, withdrawProjectUpdate } from "../lib/api";
import { relativeTime, stampTime } from "../lib/format";
import { useMinuteNow } from "../lib/minute-clock";
import { updateMeta } from "../lib/owner-card";
import { firstName } from "../lib/person-page";
import { announce, toast } from "../lib/ui-state";
import "../orgs.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/**
 * The project page's Owner Page card (§app.owner-page/controls, /updates): whether this project
 * shows on the owner's page, and the log of every update the project overseer posted there, each
 * with Take Down (off the page; it stays in this list and the workspace history). No editor: the
 * overseer posts at milestones, or when the operator asks it to in its chat.
 */
export function OwnerProjectCard(props: { org: OrgDetail; project: OrgProject; onOrg(org: OrgDetail): void }) {
  const now = useMinuteNow();
  const first = () => (props.org.ownerPage?.person ? firstName(props.org.ownerPage.person.name) : "the owner");
  const [updates, { mutate }] = createResource(
    () => ({ o: props.org.id, p: props.project.id }),
    (k) => getProjectUpdates(k.o, k.p),
  );
  const [saving, setSaving] = createSignal(false);
  const [confirm, setConfirm] = createSignal<string | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const shown = () => !props.project.ownerHidden;

  const setShown = async (on: boolean) => {
    setSaving(true);
    try {
      props.onOrg(await setProjectOwnerHidden(props.org.id, props.project.id, !on));
      setErr(null);
      const done = on ? `${props.project.name} shows on ${first()}'s page.` : `${props.project.name} is off ${first()}'s page.`;
      toast(done);
      announce(done);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setSaving(false);
    }
  };
  const takeDown = async (u: ProjectUpdate) => {
    setConfirm(null);
    try {
      mutate(await withdrawProjectUpdate(props.org.id, props.project.id, u.id));
      setErr(null);
      toast("Taken down.");
      announce("Taken down.");
    } catch (x) {
      setErr(errText(x));
    }
  };

  return (
    <section class="card orgs-section" aria-labelledby="project-owner">
      <h2 class="orgs-h2" id="project-owner">
        Owner Page
      </h2>
      <label class="toggle toggle-switch">
        <span>Show this project on {first()}'s page</span>
        <input type="checkbox" checked={shown()} disabled={saving()} onChange={(e) => void setShown(e.currentTarget.checked)} />
        <span class="toggle-box" />
      </label>
      <h3 class="orgs-h3" id="project-owner-updates">
        Updates for {first()}
      </h3>
      <Show when={updates.error}>
        <p class="field-error">{errText(updates.error)}</p>
      </Show>
      <Show
        when={updates()?.length}
        fallback={
          <Show when={updates()}>
            <p class="orgs-empty">
              The overseer hasn't posted an update yet. It posts when a conversation finishes, something is agreed, or a piece of work is finished, at most once a day.
            </p>
          </Show>
        }
      >
        <ul class="owner-updates" aria-labelledby="project-owner-updates">
          <For each={updates()}>
            {(u) => (
              <li class="owner-update" classList={{ "owner-update-down": !!u.withdrawnAt }}>
                <p class="owner-update-text">{u.text}</p>
                <div class="owner-update-foot">
                  <span class="list-meta owner-update-meta">
                    <time title={stampTime(u.at)}>{updateMeta(u, now())}</time>
                    <Show when={u.withdrawnAt}>
                      {(at) => (
                        <>
                          {" · "}
                          <time title={stampTime(at())}>{`Taken down ${relativeTime(at(), now())}`}</time>
                        </>
                      )}
                    </Show>
                  </span>
                  <Show when={!u.withdrawnAt && confirm() !== u.id}>
                    <button type="button" class="button button-sm button-destructive" aria-expanded="false" onClick={() => setConfirm(u.id)}>
                      Take Down
                    </button>
                  </Show>
                </div>
                <Show when={!u.withdrawnAt && confirm() === u.id}>
                  <div class="orgs-owner-confirm" role="group" aria-label="Take down this update">
                    <p class="orgs-line">{first()} stops seeing this update. It stays in this list and in the workspace history.</p>
                    <div class="button-row">
                      <button type="button" class="button button-sm button-destructive" onClick={() => void takeDown(u)}>
                        Take Down
                      </button>
                      <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
    </section>
  );
}
