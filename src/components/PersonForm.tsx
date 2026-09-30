import { createSignal, Show, type JSX } from "solid-js";
import { unwrap } from "solid-js/store";
import type { Person, PersonHours, PersonInput } from "../../shared/orgs";
import { changedFields } from "../lib/person-patch";
import { companyHoursLine } from "../lib/working-hours";
import { createHoursDraft, HoursFieldset } from "./HoursFields";

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Add Person submits the whole profile; Edit submits only the fields changed in the form. */
type PersonFormProps = { submitLabel: string; onCancel(): void; company?: { tz?: string; hours?: PersonHours | null } } & (
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
  const hours = createHoursDraft(p);
  // r13: with none of their own they work the company's hours, when it has some.
  const companyLine = props.company ? companyHoursLine(props.company) : null;
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
        if (hours.check()) return;
        const zone = hours.zone();
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
          ...(hours.on() ? { hours: hours.hours() } : p ? { hours: null } : {}),
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
      <HoursFieldset
        draft={hours}
        hint={`What Sova starts on its own, and what the overseer does unattended, waits for their hours. Yours go at once.${
          props.company?.hours && companyLine ? ` Leave them off to use the company's hours (${companyLine}).` : ""
        }`}
      />
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
