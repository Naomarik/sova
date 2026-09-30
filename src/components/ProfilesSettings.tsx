import { createEffect, createResource, createSignal, For, onMount, Show } from "solid-js";
import {
  BUILTIN_PROFILES,
  CAPABILITY_LABEL,
  DEFAULT_LIMITS,
  DEFAULT_PROFILE_ID,
  GRANTABLE,
  LIMIT_KEYS,
  LIMIT_LABEL,
  lockedReason,
  normalizeCaps,
  PROFILE_ICONS,
  REMOVABLE,
  type Grantable,
  type Profile,
  type ProfileLimits,
  type ProfilesFile,
  type Removable,
} from "../../shared/profiles";
import { fetchProfiles, listModels } from "../lib/api";
import { profileIconName } from "../lib/profiles";
import { profilesDraft, profilesProblem, profilesSaveError, setProfilesDraft, setProfilesSaved } from "../lib/profiles-draft";
import { Banner, Icon, trapFocus } from "./ui";

/** "Reads sessions · no web · One at a time": a profile's summary line in the list. */
export function profileSummary(p: Pick<Profile, "remove" | "grant" | "singleton">): string {
  const parts: string[] = [];
  const g = new Set(p.grant);
  if (g.has("sessions.message")) parts.push(g.has("sessions.all") ? "sees and messages all sessions" : "messages sessions");
  else if (g.has("sessions.read")) parts.push(g.has("sessions.all") ? "reads all sessions" : "reads sessions");
  const off = p.remove.filter((r) => r !== "workers" || p.remove.length === 1);
  if (off.length) parts.push(`no ${off.map((r) => CAPABILITY_LABEL[r].toLowerCase()).join(", ")}`);
  if (p.singleton) parts.push("One at a time");
  return parts.length ? parts.join(" · ") : "Nothing changed";
}

/** Settings → Profiles (§app.settings-dialog/profiles). */
export function ProfilesSettingsSection() {
  const [listing, { refetch }] = createResource(() => fetchProfiles());
  const [models] = createResource(() => listModels().catch(() => []));
  const [editing, setEditing] = createSignal<number | null>(null);
  const [deleting, setDeleting] = createSignal<number | null>(null);
  onMount(() => void refetch());
  createEffect(() => {
    const l = listing();
    if (l && !l.error) setProfilesSaved({ version: 1, profiles: l.profiles, hiddenBuiltins: l.hiddenBuiltins });
  });
  const draft = (): ProfilesFile | null => profilesDraft();
  const edit = (fn: (d: ProfilesFile) => void) => {
    const d = structuredClone(draft()!);
    fn(d);
    setProfilesDraft(d);
  };
  const uniqueName = (base: string) => {
    const taken = new Set([...BUILTIN_PROFILES, ...(draft()?.profiles ?? [])].map((p) => p.label.toLowerCase()));
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    return name;
  };
  const newId = (label: string) => {
    const taken = new Set([...BUILTIN_PROFILES, ...(draft()?.profiles ?? [])].map((p) => p.id));
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "profile";
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  };
  const duplicate = (p: Profile) => {
    const label = uniqueName(`${p.label} copy`);
    edit((d) => d.profiles.push({ ...structuredClone(p), id: newId(label), label, overseerMayStart: false }));
    setEditing(draft()!.profiles.length - 1);
  };
  const create = () => {
    const label = uniqueName("New profile");
    edit((d) => d.profiles.push({ id: newId(label), label, icon: "wrench", description: "", remove: [], grant: [], singleton: false, limits: { ...DEFAULT_LIMITS }, overseerMayStart: false }));
    setEditing(draft()!.profiles.length - 1);
  };
  const hidden = (id: string) => draft()?.hiddenBuiltins.includes(id) ?? false;

  return (
    <section class="settings-section profiles-settings" aria-labelledby="profiles-title">
      <h3 class="settings-section-title" id="profiles-title">
        Profiles
      </h3>
      <p class="field-hint">Profiles set what a new session can do. Edits reach new sessions only.</p>
      <Show when={listing()?.error}>{(e) => <Banner tone="error" title="Your profiles couldn't be read." body={e()} />}</Show>
      <Show when={profilesSaveError()}>{(e) => <Banner tone="error" title="Couldn't save your profiles." body={e().message} />}</Show>
      <Show when={draft()}>
        {(d) => (
          <>
            <ul class="profiles-list" aria-label="Built-in profiles">
              <For each={BUILTIN_PROFILES}>
                {(p) => (
                  <li class="profiles-row">
                    <Icon name={profileIconName(p.icon)} small />
                    <div class="profiles-row-main">
                      <span class="profiles-row-name">
                        {p.label} <span class="chip">Built in</span>
                        <Show when={hidden(p.id)}>
                          <span class="chip">Hidden</span>
                        </Show>
                      </span>
                      <span class="profile-muted">{profileSummary(p)}</span>
                    </div>
                    <Show when={p.id !== DEFAULT_PROFILE_ID}>
                      <div class="profiles-row-actions">
                        <button type="button" class="button button-sm" onClick={() => duplicate(p)}>
                          Duplicate
                        </button>
                        <button
                          type="button"
                          class="button button-sm button-ghost"
                          onClick={() => edit((x) => (x.hiddenBuiltins = hidden(p.id) ? x.hiddenBuiltins.filter((h) => h !== p.id) : [...x.hiddenBuiltins, p.id]))}
                        >
                          {hidden(p.id) ? "Show In Picker" : "Hide From Picker"}
                        </button>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <h4 class="text-eyebrow profiles-yours-head">Yours</h4>
            <Show when={d().profiles.length} fallback={<p class="profile-muted">None yet. Duplicate a built-in, or save one from a new session's Custom board.</p>}>
              <ul class="profiles-list" aria-label="Your profiles">
                <For each={d().profiles}>
                  {(p, i) => (
                    <li class="profiles-row" classList={{ "profiles-row-open": editing() === i() }}>
                      <Icon name={profileIconName(p.icon)} small />
                      <div class="profiles-row-main">
                        <span class="profiles-row-name">
                          {p.label || "Untitled profile"} <span class="chip">Yours</span>
                        </span>
                        <span class="profile-muted">{profileSummary(p)}</span>
                      </div>
                      <div class="profiles-row-actions">
                        <button type="button" class="button button-sm" aria-expanded={editing() === i()} onClick={() => setEditing(editing() === i() ? null : i())}>
                          Edit
                        </button>
                        <button type="button" class="button button-sm button-ghost" onClick={() => duplicate(p)}>
                          Duplicate
                        </button>
                        <button type="button" class="button button-sm button-ghost" onClick={() => setDeleting(i())}>
                          Delete
                        </button>
                      </div>
                      <Show when={editing() === i()}>
                        <ProfileEditor
                          profile={p}
                          models={(models() ?? []).map((m) => m.ref)}
                          nameProblem={profilesProblem({ ...d(), profiles: d().profiles.filter((x, j) => j === i() || x.label.trim().toLowerCase() !== p.label.trim().toLowerCase()) })}
                          onChange={(next) => edit((x) => (x.profiles[i()] = next))}
                        />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <button type="button" class="button button-primary profiles-new" onClick={create}>
              <Icon name="plus" small /> New Profile
            </button>
          </>
        )}
      </Show>
      <Show when={deleting() !== null && draft()?.profiles[deleting()!]}>
        {(p) => (
          <>
            <div class="scrim" onClick={() => setDeleting(null)} />
            <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="pd-title" ref={(el) => trapFocus(el)} onKeyDown={(e) => e.key === "Escape" && setDeleting(null)}>
              <div class="modal-head">
                <h2 class="modal-title" id="pd-title">
                  Delete {p().label}?
                </h2>
              </div>
              <div class="modal-body">
                <p>It leaves the picker. Sessions started with it keep their permissions.</p>
              </div>
              <div class="modal-foot">
                <button type="button" class="button button-ghost" onClick={() => setDeleting(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="button button-danger"
                  onClick={() => {
                    const i = deleting()!;
                    edit((x) => x.profiles.splice(i, 1));
                    setEditing(null);
                    setDeleting(null);
                  }}
                >
                  Delete Profile
                </button>
              </div>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}

function ProfileEditor(props: { profile: Profile; models: string[]; nameProblem: string | null; onChange(p: Profile): void }) {
  const p = () => props.profile;
  const set = (patch: Partial<Profile>) => props.onChange({ ...p(), ...patch });
  const setCaps = (remove: string[], grant: string[]) => set(normalizeCaps(remove, grant));
  const setLimit = (k: keyof ProfileLimits, v: string) => {
    const n = Math.floor(Number(v));
    if (Number.isFinite(n) && n >= 1) set({ limits: { ...p().limits, [k]: n } });
  };
  const id = (s: string) => `pe-${p().id}-${s}`;
  const webWarn = () => p().grant.includes("sessions.all") && !p().remove.includes("web");
  return (
    <div class="profile-editor">
      <label class="field">
        <span class="field-label">Name</span>
        <input class="input" value={p().label} maxLength={60} onInput={(e) => set({ label: e.currentTarget.value })} aria-describedby={props.nameProblem ? id("name-err") : undefined} />
        <Show when={props.nameProblem}>{(m) => <span class="field-error" id={id("name-err")}>{m().replace(/^Profiles: /, "")}</span>}</Show>
      </label>
      <label class="field">
        <span class="field-label">Icon</span>
        <select class="input" value={p().icon} onChange={(e) => set({ icon: e.currentTarget.value as Profile["icon"] })}>
          <For each={[...PROFILE_ICONS]}>{(i) => <option value={i}>{i}</option>}</For>
        </select>
      </label>
      <label class="field">
        <span class="field-label">Description</span>
        <input class="input" value={p().description} maxLength={200} placeholder="One line, shown under the name" onInput={(e) => set({ description: e.currentTarget.value })} />
      </label>
      <fieldset class="field profile-editor-caps">
        <legend class="field-label">Can</legend>
        <For each={[...GRANTABLE]}>
          {(g: Grantable) => (
            <label class="toggle toggle-switch">
              <span>{CAPABILITY_LABEL[g]}</span>
              <input type="checkbox" checked={p().grant.includes(g)} onChange={(e) => setCaps(p().remove, e.currentTarget.checked ? [...p().grant, g] : p().grant.filter((x) => x !== g && !(g === "sessions.read" && x !== "sessions.read")))} />
              <span class="toggle-box" />
            </label>
          )}
        </For>
        <Show when={webWarn()}>
          <p class="field-hint profile-warn" role="note">
            This profile can read every session and reach the web, so what it reads could leave this host.
          </p>
        </Show>
      </fieldset>
      <fieldset class="field profile-editor-caps">
        <legend class="field-label">Can't</legend>
        <For each={[...REMOVABLE]}>
          {(r: Removable) => {
            const why = () => lockedReason(r, p().remove);
            return (
              <label class="toggle toggle-switch" title={why() ?? undefined}>
                <span>{CAPABILITY_LABEL[r]}</span>
                <input
                  type="checkbox"
                  checked={p().remove.includes(r)}
                  disabled={!!why()}
                  onChange={(e) => {
                    let remove = e.currentTarget.checked ? [...p().remove, r] : p().remove.filter((x) => x !== r);
                    if (r !== "workers" && remove.length === 1 && remove[0] === "workers") remove = [];
                    setCaps(remove, p().grant);
                  }}
                />
                <span class="toggle-box" />
              </label>
            );
          }}
        </For>
      </fieldset>
      <label class="toggle toggle-switch">
        <span>One at a time</span>
        <input type="checkbox" checked={p().singleton} onChange={(e) => set({ singleton: e.currentTarget.checked })} />
        <span class="toggle-box" />
      </label>
      <fieldset class="field profile-editor-limits">
        <legend class="field-label">Limits</legend>
        <For each={[...LIMIT_KEYS]}>
          {(k) => (
            <label class="field">
              <span class="field-label">{LIMIT_LABEL[k]}</span>
              <input class="input" type="number" min="1" step="1" value={p().limits[k]} onChange={(e) => setLimit(k, e.currentTarget.value)} />
            </label>
          )}
        </For>
      </fieldset>
      <fieldset class="field">
        <legend class="field-label">Starts with</legend>
        <label class="field">
          <span class="field-label">Mode</span>
          <select class="input" value={p().mode ?? ""} onChange={(e) => set({ mode: e.currentTarget.value || undefined })}>
            <option value="">Session default</option>
            <option value="normal">normal</option>
            <option value="delegate">delegate</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">Model</span>
          <select class="input" value={p().model ?? ""} onChange={(e) => set({ model: e.currentTarget.value || undefined })}>
            <option value="">Session default</option>
            <Show when={p().model && !props.models.includes(p().model!)}>
              <option value={p().model}>{p().model} — not offered</option>
            </Show>
            <For each={props.models}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
        </label>
        <label class="field">
          <span class="field-label">First message</span>
          <textarea class="input" rows={3} value={p().firstMessage ?? ""} placeholder="Optional. Put in the composer when the session starts." onInput={(e) => set({ firstMessage: e.currentTarget.value || undefined })} />
        </label>
      </fieldset>
      <label class="toggle toggle-switch">
        <span>The Overseer may start it</span>
        <input type="checkbox" checked={p().overseerMayStart} onChange={(e) => set({ overseerMayStart: e.currentTarget.checked })} />
        <span class="toggle-box" />
      </label>
    </div>
  );
}
