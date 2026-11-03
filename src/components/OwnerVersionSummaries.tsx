import { createResource, createSignal, For, Show } from "solid-js";
import type { VersionSummaryRow } from "../../shared/project-assistant";
import { ApiError, getVersionSummaries, setVersionSummary } from "../lib/api";
import { announce } from "../lib/ui-state";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** Where the summary comes from, in the operator's words (§design.copy-deck/owner-page). */
export function summarySource(r: Pick<VersionSummaryRow, "source">, first: string): string | null {
  if (r.source === "hidden") return `Hidden from ${first}`;
  if (r.source === "team") return "Written by you";
  if (r.source === "auto") return "Written automatically";
  return null;
}

/**
 * The versions on the owner's page with what each changes (§app.project-assistant/versions), on the project page's
 * Owner Page card: each fix's summary, written automatically, with Rewrite (the team's words replace it until Use
 * Automatic) and Hide / Show. The Current version has no summary.
 */
export function OwnerVersionSummaries(props: { orgId: string; projectId: string; first: string }) {
  const [rows, { mutate }] = createResource(
    () => ({ o: props.orgId, p: props.projectId }),
    (k) => getVersionSummaries(k.o, k.p),
  );
  const [editing, setEditing] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const fixes = () => (rows() ?? []).filter((r) => !r.current);

  const save = async (r: VersionSummaryRow, body: { text?: string | null; hidden?: boolean }, done: string) => {
    if (busy()) return;
    setBusy(true);
    try {
      mutate(await setVersionSummary(props.orgId, props.projectId, r.instance, body));
      setErr(null);
      setEditing(null);
      announce(done);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h3 class="orgs-h3" id="project-owner-versions">
        Versions on {props.first}'s page
      </h3>
      <Show when={rows.error}>
        <p class="field-error">{errText(rows.error)}</p>
      </Show>
      <Show when={rows()}>
        <Show when={fixes().length} fallback={<p class="orgs-empty">No version of this project is on {props.first}'s page right now.</p>}>
          <ul class="owner-updates" aria-labelledby="project-owner-versions">
            <For each={fixes()}>
              {(r) => (
                <li class="owner-update" classList={{ "owner-update-down": r.hidden }}>
                  <p class="owner-update-text">
                    <strong>{r.label}</strong>
                  </p>
                  <Show
                    when={editing() === r.instance}
                    fallback={
                      <>
                        <p class="owner-update-text">{r.hidden ? (r.team ?? r.auto ?? "No summary yet.") : (r.summary ?? "No summary yet.")}</p>
                        <div class="owner-update-foot">
                          <span class="list-meta owner-update-meta">{summarySource(r, props.first) ?? ""}</span>
                          <span class="button-row">
                            <button
                              type="button"
                              class="button button-sm button-ghost"
                              disabled={busy()}
                              aria-label={`Rewrite: ${r.label}`}
                              onClick={() => {
                                setDraft(r.team ?? r.auto ?? "");
                                setEditing(r.instance);
                              }}
                            >
                              Rewrite
                            </button>
                            <Show when={r.team}>
                              <button type="button" class="button button-sm button-ghost" disabled={busy()} aria-label={`Use Automatic: ${r.label}`} onClick={() => void save(r, { text: null }, `${r.label}: the automatic summary.`)}>
                                Use Automatic
                              </button>
                            </Show>
                            <button
                              type="button"
                              class="button button-sm button-ghost"
                              disabled={busy()}
                              aria-label={`${r.hidden ? "Show" : "Hide"}: ${r.label}`}
                              onClick={() => void save(r, { hidden: !r.hidden }, r.hidden ? `${r.label}: shown to ${props.first}.` : `${r.label}: hidden from ${props.first}.`)}
                            >
                              {r.hidden ? "Show" : "Hide"}
                            </button>
                          </span>
                        </div>
                      </>
                    }
                  >
                    <label class="field">
                      <span class="field-label">Summary for {props.first}</span>
                      <textarea class="input" rows={3} maxLength={300} value={draft()} onInput={(e) => setDraft(e.currentTarget.value)} />
                    </label>
                    <div class="button-row">
                      <button type="button" class="button button-sm" disabled={busy() || !draft().trim()} onClick={() => void save(r, { text: draft() }, `${r.label}: your summary.`)}>
                        Save Summary
                      </button>
                      <button type="button" class="button button-sm button-ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
      <Show when={err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
    </>
  );
}
