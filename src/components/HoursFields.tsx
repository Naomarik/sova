import { createSignal, createUniqueId, For, Show } from "solid-js";
import type { PersonHours } from "../../shared/orgs";
import { DEFAULT_HOURS, knownZones, validZone, WEEK } from "../lib/working-hours";

/** A zone and working hours being edited (r7 a person's, r13 the company's): hours only once turned on. */
export function createHoursDraft(init: { tz?: string; hours?: PersonHours | null } | undefined) {
  const [tz, setTz] = createSignal(init?.tz ?? "");
  const [on, setOn] = createSignal(!!init?.hours);
  const [days, setDays] = createSignal<number[]>(init?.hours?.days ?? DEFAULT_HOURS.days);
  const [from, setFrom] = createSignal(init?.hours?.from ?? DEFAULT_HOURS.from);
  const [to, setTo] = createSignal(init?.hours?.to ?? DEFAULT_HOURS.to);
  const [error, setError] = createSignal<string | null>(null);
  return {
    tz, setTz, on, setOn, days, setDays, from, setFrom, to, setTo, error, setError,
    /** The form's problem, said under the fields; null when it can be saved. */
    check(): string | null {
      const zone = tz().trim();
      const problem = !validZone(zone)
        ? `"${zone}" isn't a time zone this browser knows. Use an IANA name, like Europe/Istanbul.`
        : on() && !days().length
          ? "Pick at least one working day, or turn working hours off."
          : on() && (!from() || !to())
            ? "Working hours need a start and an end."
            : null;
      setError(problem);
      return problem;
    },
    zone: () => tz().trim(),
    hours: (): PersonHours | null => (on() ? { days: days(), from: from(), to: to() } : null),
  };
}
export type HoursDraft = ReturnType<typeof createHoursDraft>;

/** The zone, the Set Working Hours toggle, the days and the times, with the draft's problem under them. */
export function HoursFieldset(props: { draft: HoursDraft; hint: string; toggle?: string; timesHint?: string }) {
  const d = props.draft;
  const zonesId = createUniqueId();
  const zones = knownZones();
  const toggleDay = (day: number, on: boolean) => d.setDays((ds) => (on ? [...new Set([...ds, day])] : ds.filter((x) => x !== day)).sort((a, b) => a - b));
  return (
    <fieldset class="person-hours">
      <legend class="field-label">Working hours</legend>
      <p class="field-hint person-hours-hint">{props.hint}</p>
      <label class="field">
        <span class="field-label">Time zone</span>
        <input
          class="input"
          value={d.tz()}
          list={zonesId}
          placeholder="Europe/Istanbul"
          autocomplete="off"
          spellcheck={false}
          aria-invalid={!validZone(d.tz()) ? "true" : undefined}
          onInput={(e) => {
            d.setTz(e.currentTarget.value);
            d.setError(null);
          }}
        />
        <datalist id={zonesId}>
          <For each={zones}>{(z) => <option value={z} />}</For>
        </datalist>
      </label>
      <label class="toggle person-hours-toggle">
        <input type="checkbox" checked={d.on()} onChange={(e) => d.setOn(e.currentTarget.checked)} />
        <span class="toggle-box" />
        <span>{props.toggle ?? "Set working hours"}</span>
      </label>
      <Show when={d.on()}>
        <div class="person-hours-days" role="group" aria-label="Working days">
          <For each={WEEK}>
            {(w) => (
              <label class="toggle person-hours-day" title={w.long}>
                <input type="checkbox" checked={d.days().includes(w.day)} aria-label={w.long} onChange={(e) => toggleDay(w.day, e.currentTarget.checked)} />
                <span class="toggle-box" />
                <span aria-hidden="true">{w.short}</span>
              </label>
            )}
          </For>
        </div>
        <div class="orgs-fields person-hours-times">
          <label class="field">
            <span class="field-label">From</span>
            <input class="input text-num" type="time" value={d.from()} onInput={(e) => d.setFrom(e.currentTarget.value)} />
          </label>
          <label class="field">
            <span class="field-label">To</span>
            <input class="input text-num" type="time" value={d.to()} onInput={(e) => d.setTo(e.currentTarget.value)} />
          </label>
        </div>
        <p class="field-hint">{props.timesHint ?? "In their time zone. An end before the start runs overnight."}</p>
      </Show>
      <Show when={d.error()}>{(e) => <p class="field-error">{e()}</p>}</Show>
    </fieldset>
  );
}
