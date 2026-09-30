import { createSignal, For, Show } from "solid-js";
import type { OrgDetail } from "../../shared/orgs";
import { ApiError, putOrgHours } from "../lib/api";
import { relativeTime, stampTime } from "../lib/format";
import { orgHoursChangeLine } from "../lib/profile-changes";
import { companyHoursLine } from "../lib/working-hours";
import { createHoursDraft, HoursFieldset } from "./HoursFields";
import { Icon } from "./ui";

type Act = (fn: () => Promise<OrgDetail | unknown>, done?: string) => Promise<boolean>;
const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/**
 * Company hours (r13, §app.organizations/working-hours): the company's zone and working hours, the
 * default for anyone without their own. Operator only; its changes are the org's history, as About's.
 */
export function CompanyHoursCard(props: { org: OrgDetail; act: Act }) {
  const [editing, setEditing] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const history = () => props.org.hoursHistory ?? [];
  const line = () => companyHoursLine(props.org);
  // A fresh draft each time the form opens, from what is saved then.
  const [draft, setDraft] = createSignal(createHoursDraft(props.org));
  const open = () => {
    setDraft(createHoursDraft(props.org));
    setProblem(null);
    setEditing(true);
  };
  const save = async () => {
    const d = draft();
    if (d.check()) return;
    const hours = d.hours();
    setSaving(true);
    try {
      const next = await putOrgHours(props.org.id, { tz: d.zone(), hours });
      setProblem(null);
      setEditing(false);
      await props.act(async () => next, hours ? "Saved. Anyone without hours of their own works these." : "Saved. Nobody works company hours now.");
    } catch (err) {
      setProblem(errText(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section class="card orgs-section" aria-labelledby="orgs-company-hours">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="orgs-company-hours">
          Company hours
        </h2>
        <Show when={!editing()}>
          <button type="button" class="button button-sm button-ghost" aria-label="Edit company hours" onClick={open}>
            <Icon name="pencil" small /> Edit
          </button>
        </Show>
      </div>
      <p class="orgs-line project-muted">
        The default for anyone without working hours of their own; theirs win when set. What Sova starts on its own, and what the overseer does unattended, waits for them. Yours go
        at once.
      </p>
      <Show when={!editing()}>
        <p class="orgs-line">{line() ?? "None set: anyone without hours of their own is always in hours."}</p>
      </Show>
      <Show when={editing()}>
        <form
          class="orgs-form orgs-subform"
          onSubmit={(e) => {
            e.preventDefault();
            if (!saving()) void save();
          }}
        >
          <HoursFieldset draft={draft()} hint="Turn them off to clear them." toggle="Set company hours" timesHint="In the company's time zone. An end before the start runs overnight." />
          <Show when={problem()}>{(p) => <p class="field-error">{p()}</p>}</Show>
          <div class="button-row">
            <button type="button" class="button button-ghost" disabled={saving()} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" class="button button-primary" disabled={saving()}>
              Save
            </button>
          </div>
        </form>
      </Show>
      <Show when={history().length}>
        <details class="orgs-history orgs-history-section">
          <summary>History ({history().length})</summary>
          <ul class="orgs-history-list">
            <For each={history()}>
              {(c) => (
                <li class="orgs-change">
                  <span>
                    {orgHoursChangeLine(c)}
                    <span class="list-meta">
                      {" · "}
                      <time title={stampTime(c.at)}>{relativeTime(c.at)}</time>
                      {c.by.via === "overseer" ? " · by you, via the Overseer" : " · by you"}
                    </span>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  );
}
