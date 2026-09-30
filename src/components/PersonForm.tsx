import { createSignal, createUniqueId, For, Show, type JSX } from "solid-js";
import { unwrap } from "solid-js/store";
import type { Person, PersonInput } from "../../shared/orgs";
import { changedFields } from "../lib/person-patch";
import { DEFAULT_HOURS, knownZones, validZone, WEEK } from "../lib/working-hours";

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Add Person submits the whole profile; Edit submits only the fields changed in the form. */
type PersonFormProps = { submitLabel: string; onCancel(): void } & (
  | { person?: undefined; onSubmit(input: PersonInput): void }
  | { person: Person; onSubmit(input: Partial<PersonInput>): void }
);

/**
 * A person's profile form: Add Person on the People tab, Edit on a card and on their page. Edit
 * sends only what changed against the person as the form opened, so a field someone else wrote
 * meanwhile (a wrap-up, another tab) is kept; with nothing changed it just closes.
 */
export function PersonForm(props: PersonFormProps) {
  // A copy, never the prop itself: the page reconciles its store in place, so the prop already
  // holds what another tab or a wrap-up wrote by the time Save compares against it.
  const p = props.person && (structuredClone(unwrap(props.person)) as Person);
  const [name, setName] = createSignal(p?.name ?? "");
  const [status, setStatus] = createSignal<Person["status"]>(p?.status ?? "active");
  const [role, setRole] = createSignal(p?.role ?? "");
  const [decides, setDecides] = createSignal(p?.decides.join(", ") ?? "");
  const [skills, setSkills] = createSignal(p?.skills.join(", ") ?? "");
  const [language, setLanguage] = createSignal(p?.language ?? "");
  const [voice, setVoice] = createSignal(p?.voice ?? "");
  const [email, setEmail] = createSignal(p?.contact.email ?? "");
  const [phone, setPhone] = createSignal(p?.contact.phone ?? "");
  const [whatsapp, setWhatsapp] = createSignal(p?.contact.whatsapp ?? "");
  const [why, setWhy] = createSignal(p?.referral?.why ?? "");
  const [by, setBy] = createSignal(p?.referral?.referredBy ?? "");
  // Working hours (r7, §app.organizations/working-hours): a zone, and hours only once turned on.
  const [tz, setTz] = createSignal(p?.tz ?? "");
  const [hoursOn, setHoursOn] = createSignal(!!p?.hours);
  const [days, setDays] = createSignal<number[]>(p?.hours?.days ?? DEFAULT_HOURS.days);
  const [from, setFrom] = createSignal(p?.hours?.from ?? DEFAULT_HOURS.from);
  const [to, setTo] = createSignal(p?.hours?.to ?? DEFAULT_HOURS.to);
  const [hoursError, setHoursError] = createSignal<string | null>(null);
  const zonesId = createUniqueId();
  const zones = knownZones();
  const toggleDay = (d: number, on: boolean) => setDays((xs) => (on ? [...new Set([...xs, d])] : xs.filter((x) => x !== d)).sort((a, b) => a - b));
  const text = (label: string, get: () => string, set: (v: string) => void, extra: JSX.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label class="field">
      <span class="field-label">{label}</span>
      <input class="input" value={get()} onInput={(e) => set(e.currentTarget.value)} {...extra} />
    </label>
  );
  return (
    <form
      class="orgs-form orgs-subform"
      onSubmit={(e) => {
        e.preventDefault();
        const zone = tz().trim();
        const problem = !validZone(zone)
          ? `"${zone}" isn't a time zone this browser knows. Use an IANA name, like Europe/Istanbul.`
          : hoursOn() && !days().length
            ? "Pick at least one working day, or turn working hours off."
            : hoursOn() && (!from() || !to())
              ? "Working hours need a start and an end."
              : null;
        setHoursError(problem);
        if (problem) return;
        const contact = { ...(email().trim() ? { email: email().trim() } : {}), ...(phone().trim() ? { phone: phone().trim() } : {}), ...(whatsapp().trim() ? { whatsapp: whatsapp().trim() } : {}) };
        const input: PersonInput = {
          name: name().trim(),
          status: status(),
          role: role().trim(),
          decides: list(decides()),
          skills: list(skills()),
          language: language().trim(),
          voice: voice().trim(),
          contact,
          ...(status() === "proposed" || why().trim() || by().trim() ? { referral: { why: why().trim(), referredBy: by().trim() } } : {}),
          // A new person without them sends neither; an edit sends "" / null to clear them.
          ...(zone || p ? { tz: zone } : {}),
          ...(hoursOn() ? { hours: { days: days(), from: from(), to: to() } } : p ? { hours: null } : {}),
        };
        if (!p) return (props.onSubmit as (input: PersonInput) => void)(input);
        const patch = changedFields(p, input);
        if (Object.keys(patch).length) props.onSubmit(patch);
        else props.onCancel();
      }}
    >
      <div class="orgs-fields">
        {text("Name", name, setName, { maxlength: 80, required: true })}
        <label class="field">
          <span class="field-label">Status</span>
          <select class="select" value={status()} onChange={(e) => setStatus(e.currentTarget.value as Person["status"])}>
            <option value="active">Active</option>
            <option value="proposed">Proposed</option>
            <option value="left">Left</option>
          </select>
        </label>
        {text("Role", role, setRole, { maxlength: 300 })}
        {text("Language", language, setLanguage, { placeholder: "es-CO", maxlength: 35 })}
        {text("Decides", decides, setDecides, { placeholder: "invoicing, bank access" })}
        {text("Skills", skills, setSkills, { placeholder: "Excel, SQL" })}
        {text("Email", email, setEmail, { type: "email" })}
        {text("Phone", phone, setPhone)}
        {text("WhatsApp", whatsapp, setWhatsapp)}
      </div>
      <label class="field">
        <span class="field-label">Voice</span>
        <textarea class="input textarea" rows={2} maxlength={300} value={voice()} onInput={(e) => setVoice(e.currentTarget.value)} />
        <span class="field-hint">How to talk to them. Never shown to them or anyone else outside this page.</span>
      </label>
      <fieldset class="person-hours">
        <legend class="field-label">Working hours</legend>
        <p class="field-hint person-hours-hint">What Sova starts on its own, and what the overseer does unattended, waits for their hours. Yours go at once.</p>
        <label class="field">
          <span class="field-label">Time zone</span>
          <input class="input" value={tz()} list={zonesId} placeholder="Europe/Istanbul" autocomplete="off" spellcheck={false} aria-invalid={!validZone(tz()) ? "true" : undefined} onInput={(e) => {
              setTz(e.currentTarget.value);
              setHoursError(null);
            }} />
          <datalist id={zonesId}>
            <For each={zones}>{(z) => <option value={z} />}</For>
          </datalist>
        </label>
        <label class="toggle person-hours-toggle">
          <input type="checkbox" checked={hoursOn()} onChange={(e) => setHoursOn(e.currentTarget.checked)} />
          <span class="toggle-box" />
          <span>Set working hours</span>
        </label>
        <Show when={hoursOn()}>
          <div class="person-hours-days" role="group" aria-label="Working days">
            <For each={WEEK}>
              {(w) => (
                <label class="toggle person-hours-day" title={w.long}>
                  <input type="checkbox" checked={days().includes(w.day)} aria-label={w.long} onChange={(e) => toggleDay(w.day, e.currentTarget.checked)} />
                  <span class="toggle-box" />
                  <span aria-hidden="true">{w.short}</span>
                </label>
              )}
            </For>
          </div>
          <div class="orgs-fields person-hours-times">
            <label class="field">
              <span class="field-label">From</span>
              <input class="input text-num" type="time" value={from()} onInput={(e) => setFrom(e.currentTarget.value)} />
            </label>
            <label class="field">
              <span class="field-label">To</span>
              <input class="input text-num" type="time" value={to()} onInput={(e) => setTo(e.currentTarget.value)} />
            </label>
          </div>
          <p class="field-hint">In their time zone. An end before the start runs overnight.</p>
        </Show>
        <Show when={hoursError()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      </fieldset>
      <Show when={status() === "proposed"}>
        <div class="orgs-fields">
          {text("Why referred", why, setWhy, { maxlength: 300, required: true })}
          {text("Referred by", by, setBy, { maxlength: 80, required: true })}
        </div>
        <p class="field-hint">A proposed person needs a name, a contact, a role, and who referred them and why.</p>
      </Show>
      <div class="button-row">
        <button type="submit" class="button button-primary">
          {props.submitLabel}
        </button>
        <button type="button" class="button button-ghost" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
