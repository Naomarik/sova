import { createSignal, Show } from "solid-js";
import type { PlaybookSchedule } from "../../shared/protocol";
import { canApprove, canRevoke, eventsText, runsAsText, scheduleStateText } from "../lib/schedules";
import { Icon } from "./ui";

/** The state as a chip: a dot and the word, never hue alone. */
export function ScheduleStateChip(props: { schedule: PlaybookSchedule }) {
  const tone = () => {
    switch (props.schedule.state) {
      case "active":
        return { cls: "chip-success", word: "Approved" };
      case "needs-approval":
        return { cls: "chip-warn", word: "Needs approval" };
      case "paused":
        return { cls: "chip-warn", word: "Paused" };
      default:
        return { cls: "chip-error", word: "Not valid" };
    }
  };
  return (
    <span class={`chip ${tone().cls}`}>
      <span class="chip-dot" aria-hidden="true" />
      {tone().word}
    </span>
  );
}

/**
 * A playbook's schedule on the Playbooks dialog's step 2 (§chat.schedules/where-shown): what it runs
 * on and as, its state, and Approve Schedule or Revoke Schedule. Approving is the user's click only;
 * `onApprove`/`onRevoke` return an error sentence, or null when done (the caller refetches).
 */
export function ScheduleCard(props: { schedule: PlaybookSchedule; onApprove(): Promise<string | null>; onRevoke(): Promise<string | null> }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const s = () => props.schedule;
  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const failed = await fn();
    setBusy(false);
    if (failed) setError(failed);
  };
  const detail = () => {
    const st = s();
    if (st.state === "active") return st.next ? scheduleStateText(st) : eventsText(st);
    return st.reason ?? null;
  };
  return (
    <section class="schedule-card" aria-label="Schedule">
      <div class="schedule-card-head">
        <Icon name="clock" small />
        <h3 class="schedule-card-title">Schedule</h3>
        <ScheduleStateChip schedule={s()} />
      </div>
      <Show when={s().text} fallback={<p class="schedule-card-when text-mono">when: {s().when}</p>}>
        {(text) => <p class="schedule-card-when">{text()}</p>}
      </Show>
      <Show when={s().state !== "not-project"}>
        <p class="text-caption text-muted">{runsAsText(s())}</p>
      </Show>
      <Show when={detail()}>{(d) => <p class="text-caption schedule-card-detail">{d()}</p>}</Show>
      <Show when={canApprove(s())}>
        <p class="text-caption text-muted">
          Sova will start or wake {s().profileLabel ?? s().profile} sessions on this schedule without you. It asks again if the schedule or the profile changes; edits to the
          instructions don't.
        </p>
      </Show>
      <Show when={error()}>
        {(e) => (
          <p class="text-caption schedule-card-error" role="alert">
            {e()}
          </p>
        )}
      </Show>
      <Show when={canApprove(s()) || canRevoke(s())}>
        <div class="schedule-card-actions">
          <Show when={canApprove(s())}>
            {/* Secondary: the dialog's one primary action stays Send Playbook. */}
            <button type="button" class="button button-sm" disabled={busy()} onClick={() => void act(props.onApprove)}>
              Approve Schedule
            </button>
          </Show>
          <Show when={canRevoke(s())}>
            <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => void act(props.onRevoke)}>
              Revoke Schedule
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}
