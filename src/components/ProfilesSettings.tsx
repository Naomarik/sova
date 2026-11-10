import { createEffect, createMemo, createResource, createSignal, For, on, onMount, Show, untrack, type JSX } from "solid-js";
import { CAPABILITY_LABEL, GRANTABLE, LIMIT_KEYS, OFF_KEY, PROFILE_MINOR_MODES, powersText, REMOVABLE, type Grantable, type ProfileProblem, type ProfileSource, type Removable } from "../../shared/profiles";
import type { SubagentProfile } from "../../shared/subagent-profiles";
import { PROFILE_LABEL_RULE } from "../../shared/profile-limits";
import { approveProfile, fetchProfiles, getDelegateSettings, getSubagentProfiles, getTeamDefaults, restoreSubagentProfiles, setProfileHidden } from "../lib/api";
import { tildePath } from "../lib/format";
import { home, toast } from "../lib/ui-state";
import { loadModels, modelList } from "../lib/models";
import { modelEfforts } from "../lib/delegate-form";
import { liveDelegateOptions } from "../lib/claude-catalog";
import { replacedNotice } from "../lib/subagent-replaced";
import { teamsSeed } from "../lib/subagent-editor";
import { clearProfilesRequest, clearSettingsSection, profilesRequest, settingsSection, subagentSettingsPath, type ProfilesPart } from "../lib/settings-nav";
import { lastSavedKeys, profilesDraft as store, profilesListing, setProfilesCwd, takeListing } from "../lib/profiles-draft";
import {
  alsoUsedBy,
  helpersOf,
  LIMIT_RULES,
  listGroups,
  nameIssue,
  plainStarts,
  setAllTo,
  sharersOf,
  withDeleted,
  withDuplicate,
  withNewProfile,
  type DraftRow,
  type JoinedRowWire,
  type ListRow,
  type ProfilesDraft,
  type Starts,
} from "../lib/profiles-settings";
import { NumberField, Select, TextArea, TextField, Toggle } from "./form";
import { Banner, Chip, Icon } from "./ui";
import { RetryButton, sentence } from "./WorkerSlotRow";
import { ProfileModelsPart } from "./SubagentProfilesSettings";

/** Where Settings links for the file format (served from the repo's docs/ on GitHub). */
const FORMAT_URL = "https://github.com/Naomarik/sova/blob/master/docs/profiles.md";
const MINOR_LABEL: Record<(typeof PROFILE_MINOR_MODES)[number], string> = { align: "Align", spec: "Spec", vis: "Visuals" };
const SHARES_WORKERS = "Workers would get every tool back, so removing anything removes them too.";
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Settings → Profiles (§app.settings-dialog/profiles): the one place profiles are listed and edited,
 * both parts. The list beside the editor (under it on a narrow panel): New Profile, then Yours, This
 * project and Built in. The editor (§app.settings-dialog/profile-editor): the name and Default or
 * Make Default, then the Models part (§chat.subagent-profiles/settings) and the When a Chat Starts
 * part. Yours are the dialog's draft, saved with Save Changes; a project's are read-only, with
 * Approve Profile; Approve and Hide save at once.
 */
export function ProfilesSettingsSection(props: { cwd: string | null }) {
  setProfilesCwd(props.cwd);
  const [listing, { refetch }] = createResource(() => props.cwd ?? "", (cwd) => fetchProfiles(cwd || null));
  const [library, { refetch: refetchLibrary }] = createResource(() => getSubagentProfiles(subagentSettingsPath()));
  const [options, { refetch: refetchOptions }] = liveDelegateOptions();
  const [rows] = createResource(getDelegateSettings);
  const [teams] = createResource(getTeamDefaults);
  onMount(() => {
    if (!modelList()) void loadModels().catch(() => undefined);
  });
  const safeListing = () => (listing.error ? undefined : listing());
  const safeLibrary = () => (library.error ? undefined : library());
  const optionsReady = () => (options.state === "ready" ? options() : undefined);

  // What's saved, whenever the list (re)loads; a draft kept from an earlier visit stays.
  createEffect(() => {
    const l = safeListing();
    if (l) untrack(() => takeListing(l, store.draft() === null));
  });
  const wire = (): JoinedRowWire[] => profilesListing()?.joined ?? safeListing()?.joined ?? [];
  const l = () => profilesListing() ?? safeListing();
  const draft = () => store.draft();
  const groups = createMemo(() => (draft() ? listGroups(draft()!, wire(), store.saved()) : null));

  const [picked, setPicked] = createSignal<string | null>(null);
  const [part, setPart] = createSignal<ProfilesPart>("models");
  const [focusSpec, setFocusSpec] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [actionError, setActionError] = createSignal<string | null>(null);

  // A new profile, once saved, keeps its editor open under its saved key.
  createEffect(
    on(lastSavedKeys, (keys) => {
      const to = keys.get(untrack(picked) ?? "");
      if (to) setPicked(to);
    }),
  );
  const allRows = (): ListRow[] => (groups() ? [...groups()!.yours, ...groups()!.project, ...groups()!.builtin] : []);
  /** The open profile: the one picked, else the one asked for, else the chat's, else the default, else Off. */
  const current = (): ListRow | undefined => {
    const all = allRows();
    return all.find((r) => r.key === picked()) ?? all.find((r) => r.isDefault) ?? all.find((r) => r.key === OFF_KEY) ?? all[0];
  };
  // The mode menu's gears, Manage Profiles… and the limit row open a profile at a part.
  createEffect(() => {
    const ask = profilesRequest();
    const all = allRows();
    if (!ask || all.length === 0) return;
    const chatLib = subagentSettingsPath() ? safeLibrary()?.current.id : undefined;
    if (!ask.profile && subagentSettingsPath() && library.loading) return;
    const hit =
      (ask.profile && all.find((r) => r.key === ask.profile || r.wire?.id === ask.profile)) ||
      (chatLib && chatLib !== "off" && all.find((r) => r.wire?.libraryId === chatLib && r.group === "yours")) ||
      (chatLib === "off" && all.find((r) => r.key === OFF_KEY)) ||
      undefined;
    untrack(() => {
      if (hit) setPicked(hit.key);
      setPart(ask.part);
      if (settingsSection() === "spec") {
        clearSettingsSection();
        setPart("models");
        setFocusSpec(true);
      }
      clearProfilesRequest();
    });
  });

  const row = (key: string): DraftRow | undefined => draft()?.rows.find((r) => r.key === key);
  const edit = (fn: (d: ProfilesDraft) => ProfilesDraft | void) => {
    const d = draft();
    if (!d) return;
    const copy = clone(d);
    const out = fn(copy);
    store.setDraft(out ?? copy);
  };
  const editRow = (key: string, fn: (r: DraftRow) => void) =>
    edit((d) => {
      const r = d.rows.find((x) => x.key === key);
      if (r) fn(r);
    });
  /** The library half of `key` as a library profile, for the Models part. */
  const libProfile = (key: string): SubagentProfile | null => {
    const r = row(key);
    const h = r?.lib ? draft()!.library[r.lib] : undefined;
    return h && r ? ({ ...h, id: r.lib!, name: r.name } as SubagentProfile) : null;
  };
  const changeLib = (key: string, fn: (p: SubagentProfile) => SubagentProfile | void) =>
    edit((d) => {
      const r = d.rows.find((x) => x.key === key);
      const h = r?.lib ? d.library[r.lib] : undefined;
      if (!r || !h) return;
      const p = { ...h, id: r.lib!, name: r.name } as SubagentProfile;
      d.library[r.lib!] = helpersOf(fn(p) ?? p);
    });
  const template = () => l()?.template ?? (safeLibrary() ? helpersOf(safeLibrary()!.template) : null);

  const newProfile = () => {
    const d = draft();
    const c = current();
    if (!d) return;
    // The models of the profile open in the editor; Off's are the default's.
    const fromKey = c && c.group === "yours" ? c.key : d.default;
    const src = d.rows.find((r) => r.key === fromKey);
    const wired = !src ? wire().find((w) => w.key === (c?.key === OFF_KEY ? d.default : c?.key)) : undefined;
    const from = src
      ? { model: src.model, thinking: src.thinking, helpers: src.lib ? (d.library[src.lib] ?? null) : null }
      : wired
        ? { model: wired.session?.model ?? null, thinking: wired.session?.thinking ?? null, helpers: wired.library ? helpersOf(wired.library) : null }
        : null;
    const out = withNewProfile(d, from, template());
    store.setDraft(out.draft);
    setPicked(out.key);
    setPart("models");
    queueMicrotask(() => document.getElementById("profile-name")?.focus());
  };
  const duplicate = (key: string) => {
    const d = draft();
    if (!d) return;
    const out = withDuplicate(d, key, template());
    store.setDraft(out.draft);
    setPicked(out.key);
  };
  const remove = (key: string) => {
    const d = draft();
    if (!d) return;
    const out = withDeleted(d, key);
    if (typeof out === "string") return setActionError(out);
    setActionError(null);
    store.setDraft(out);
    setPicked(null);
  };
  const makeDefault = (key: string) => edit((d) => void (d.default = key));

  /** Approve and Hide save at once (§app.settings-dialog/profile-editor); the draft stays as it is. */
  const act = async (key: string, fn: () => Promise<import("../../shared/profiles").ProfilesListing>, failed: string) => {
    setBusy(key);
    try {
      takeListing(await fn());
    } catch (err) {
      toast(`${failed} ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  // Another device's copy changed the library in the last day (§chat.subagent-profiles/replaced).
  const [restoredFile, setRestoredFile] = createSignal<string | null>(null);
  const [restoring, setRestoring] = createSignal(false);
  const [restoreError, setRestoreError] = createSignal<string | null>(null);
  const replaced = () => {
    const r = safeLibrary()?.replaced;
    return r && r.file !== restoredFile() ? r : undefined;
  };
  const restore = async (file: string) => {
    if (store.dirty() || restoring()) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await restoreSubagentProfiles(file);
      setRestoredFile(file);
      const fresh = await fetchProfiles(props.cwd);
      takeListing(fresh);
      store.setSaved(store.saved()!, { replaceDraft: true });
      void refetchLibrary();
    } catch (e) {
      setRestoreError(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  };
  // A save's answer reloads the library facts the notice reads.
  createEffect(on(store.result, () => void refetchLibrary(), { defer: true }));

  const path = (p: string) => tildePath(p, home());
  const problemsOf = (source: ProfileSource): ProfileProblem[] => (l()?.problems ?? []).filter((x) => x.source === source);

  const ListItem = (lp: { r: ListRow }) => (
    <li>
      <button
        type="button"
        class="profiles-pick"
        classList={{ "is-picked": current()?.key === lp.r.key }}
        aria-current={current()?.key === lp.r.key ? "true" : undefined}
        onClick={() => {
          setPicked(lp.r.key);
          setActionError(null);
        }}
      >
        <span class="profiles-pick-name">
          <span class="profiles-pick-title">{lp.r.name}</span>
          <Show when={lp.r.isDefault}>
            <Chip tone="accent">Default</Chip>
          </Show>
          <Show when={lp.r.needsApproval}>
            <Chip tone="warn">Needs approval</Chip>
          </Show>
          <Show when={lp.r.hidden}>
            <Chip>Hidden</Chip>
          </Show>
        </span>
        <span class="profiles-pick-meta">{lp.r.footprint}</span>
      </button>
    </li>
  );
  const Problem = (pp: { x: ProfileProblem }) => (
    <li class="profiles-row profiles-row-problem">
      <Icon name="attention" small />
      <div class="profiles-row-main">
        <span class="profiles-row-name">
          {pp.x.file.split("/").pop()} <span class="chip chip-error">Can't be read</span>
        </span>
        <span class="profile-muted text-mono profiles-row-file">{path(pp.x.file)}</span>
        <span class="profiles-row-error">{pp.x.error}</span>
      </div>
    </li>
  );
  const Group = (gp: { title: string; rows: ListRow[]; problems: ProfileProblem[]; empty?: JSX.Element }) => (
    <>
      <h4 class="text-eyebrow profiles-group-head">{gp.title}</h4>
      <Show when={gp.rows.length || gp.problems.length} fallback={gp.empty}>
        <ul class="profiles-picks" aria-label={gp.title}>
          <For each={gp.rows}>{(r) => <ListItem r={r} />}</For>
          <For each={gp.problems}>{(x) => <Problem x={x} />}</For>
        </ul>
      </Show>
    </>
  );

  const projectTitle = () => (l()?.project.state === "ok" ? `This project (${l()!.project.name})` : "This project");
  const projectEmpty = () => {
    const p = l()?.project;
    if (!p) return null;
    const text =
      p.state === "ok" ? `None yet. A profile here is a file in ${path(p.dir ?? "")}.` : p.state === "none" ? "Open a session to see its project's profiles." : (p.message ?? "This session's folder has no project profiles.");
    return <p class="profile-muted">{text}</p>;
  };

  return (
    <section class="settings-section profiles-settings" aria-labelledby="profiles-title">
      <h3 class="settings-section-title" id="profiles-title">
        Profiles
      </h3>
      <Show when={listing.error}>
        <Banner tone="error" title="Couldn't load profiles." body={`${sentence(String(listing.error?.message ?? listing.error))} Your profiles are unchanged.`} action={<RetryButton label="Try Again" onClick={() => void refetch()} />} />
      </Show>
      <Show when={options.loading}>
        <p class="settings-intro" role="status">
          Checking which models each backend offers…
        </p>
      </Show>
      <Show when={options.error}>
        <Banner tone="warn" title="Couldn't check which models are offered." body="Your saved choices stay, marked not verified." action={<RetryButton label="Check Again" onClick={() => void refetchOptions()} />} />
      </Show>
      <Show when={store.error()}>{(e) => <Banner tone="error" title="Couldn't save profiles." body={sentence(e().message)} />}</Show>
      <Show when={store.warnings().length > 0}>
        <Banner tone="warn" title="Saved, with notes." body={store.warnings().map(sentence).join(" ")} />
      </Show>

      <Show when={draft() && groups()}>
        <div class="profiles-layout">
          <div class="profiles-list-pane">
            <Show when={restoreError()}>{(e) => <Banner tone="error" title="Couldn't restore your previous library." body={`${sentence(e())} Your library is unchanged.`} />}</Show>
            <Show when={replaced()}>
              {(r) => {
                const notice = () => replacedNotice(r());
                return (
                  <Banner
                    tone="info"
                    title={notice().title}
                    body={notice().body}
                    action={
                      <button
                        type="button"
                        class="button button-sm"
                        disabled={store.dirty() || store.saving() || restoring()}
                        title={store.dirty() ? "Save or discard your Profiles changes first" : undefined}
                        onClick={() => void restore(r().file)}
                      >
                        {restoring() ? "Restoring…" : "Restore Previous Library"}
                      </button>
                    }
                  />
                );
              }}
            </Show>
            <div class="button-row">
              <button type="button" class="button button-sm" disabled={store.saving() || !!l()?.error} onClick={newProfile}>
                <Icon name="plus" small />
                New Profile
              </button>
            </div>
            <h4 class="text-eyebrow profiles-group-head">Yours</h4>
            <Show when={l()?.error}>{(e) => <Banner tone="error" title="Your profiles couldn't be read." body={e()} />}</Show>
            <Show when={groups()!.yours.length || problemsOf("user").length} fallback={<Show when={!l()?.error}><p class="profile-muted">None yet.</p></Show>}>
              <ul class="profiles-picks" aria-label="Yours">
                <For each={groups()!.yours}>{(r) => <ListItem r={r} />}</For>
                <For each={problemsOf("user")}>{(x) => <Problem x={x} />}</For>
              </ul>
            </Show>
            <Group title={projectTitle()} rows={groups()!.project} problems={problemsOf("project")} empty={projectEmpty()} />
            <Group title="Built in" rows={groups()!.builtin} problems={problemsOf("sova")} />
          </div>

          <div class="profiles-editor-pane">
            <Show when={current()?.key} keyed>
              {(key) => {
                // Remounted only when another profile is picked: an edit keeps its open rows and focus.
                const c = () => (current()?.key === key ? current()! : allRows().find((r) => r.key === key)!);
                return (
                <ProfileEditor
                  r={c()}
                  part={part()}
                  setPart={setPart}
                  focusSpec={focusSpec()}
                  onSpecFocused={() => setFocusSpec(false)}
                  draft={draft()!}
                  draftRow={row(c().key)}
                  libProfile={libProfile(c().key)}
                  busy={busy() === c().key}
                  saving={store.saving()}
                  actionError={actionError()}
                  cwd={props.cwd}
                  wire={wire()}
                  rows={rows.error ? undefined : rows()}
                  options={optionsReady()}
                  teamsSeed={teamsSeed(c().wire?.library?.teams, teams.error ? undefined : teams()?.defaults)}
                  template={template()}
                  onName={(v) => editRow(c().key, (r) => (r.name = v))}
                  onStarts={(s) => editRow(c().key, (r) => (r.starts = s))}
                  onChat={(next) =>
                    editRow(c().key, (r) => {
                      r.model = next.model;
                      r.thinking = next.thinking;
                      if (!r.starts) r.starts = plainStarts();
                    })
                  }
                  changeLib={(fn) => changeLib(c().key, fn)}
                  onChooseHelpers={() =>
                    edit((d) => {
                      const r = d.rows.find((x) => x.key === c().key);
                      const t = template();
                      if (!r || !t) return;
                      const lib = `new:${c().key}`;
                      d.library[lib] = clone(t);
                      r.lib = lib;
                    })
                  }
                  onSetAll={(pick) =>
                    store.setDraft(
                      setAllTo(draft()!, c().key, pick, {
                        efforts: (b, m) => modelEfforts(optionsReady(), b, m),
                        levels: (ref) => modelList()?.find((x) => x.ref === ref)?.thinkingLevels ?? null,
                      }),
                    )
                  }
                  onMakeDefault={() => makeDefault(c().key)}
                  onDuplicate={() => duplicate(c().key)}
                  onDelete={() => remove(c().key)}
                  onHide={(hidden) => void act(c().key, () => setProfileHidden(c().key, hidden, props.cwd), `Couldn't change ${c().name}.`)}
                  onApprove={() => {
                    const s = c().wire?.session;
                    if (s && props.cwd) void act(c().key, () => approveProfile(props.cwd!, { id: s.id, grant: s.grant, overseerMayStart: s.overseerMayStart }), `Couldn't approve ${c().name}.`);
                  }}
                />
              );
              }}
            </Show>
          </div>
        </div>
      </Show>

      <p class="field-hint profiles-foot">
        Stored in <code>{l() ? path(l()!.yoursFile) : "session-profiles.json"}</code> and <code>{l()?.library?.file ? path(l()!.library!.file) : "subagent-profiles.json"}</code>.{" "}
        <a href={FORMAT_URL} target="_blank" rel="noopener">
          File Format
        </a>
      </p>
    </section>
  );
}

/** One profile's editor: its head, then Models or When a Chat Starts. */
function ProfileEditor(props: {
  r: ListRow;
  part: ProfilesPart;
  setPart(p: ProfilesPart): void;
  focusSpec: boolean;
  onSpecFocused(): void;
  draft: ProfilesDraft;
  draftRow: DraftRow | undefined;
  libProfile: SubagentProfile | null;
  busy: boolean;
  saving: boolean;
  actionError: string | null;
  cwd: string | null;
  wire: JoinedRowWire[];
  rows: Parameters<typeof ProfileModelsPart>[0]["rows"];
  options: Parameters<typeof ProfileModelsPart>[0]["options"];
  teamsSeed: Parameters<typeof ProfileModelsPart>[0]["teamsSeed"];
  template: unknown;
  onName(v: string): void;
  onStarts(s: Starts): void;
  onChat(next: { model: string | null; thinking: DraftRow["thinking"] }): void;
  changeLib(fn: (p: SubagentProfile) => SubagentProfile | void): void;
  onChooseHelpers(): void;
  onSetAll(pick: { backend: "pi" | "claude-code"; model: string }): void;
  onMakeDefault(): void;
  onDuplicate(): void;
  onDelete(): void;
  onHide(hidden: boolean): void;
  onApprove(): void;
}) {
  const yours = () => props.r.group === "yours" && !!props.draftRow;
  const isOff = () => props.r.key === OFF_KEY;
  const readOnly = () => !yours();
  const w = () => props.r.wire;
  const session = () => (yours() ? props.draftRow!.starts : w()?.session ? (w()!.session as unknown as Starts) : null);
  const chat = () => (yours() ? { model: props.draftRow!.model, thinking: props.draftRow!.thinking } : { model: w()?.session?.model ?? null, thinking: w()?.session?.thinking ?? null });
  const helpers = () => (yours() ? props.libProfile : w()?.library ?? null);
  const shared = () => alsoUsedBy(yours() ? sharersOf(props.draft, props.r.key, props.wire) : (w()?.alsoUsedBy ?? []));
  const noHelpers = () => w()?.linkMissing ?? "No helpers of its own: a chat on it takes them from this computer's default.";
  const id = "profile-editor";

  const defaultControl = () => (
    <Show
      when={props.r.isDefault}
      fallback={
        <button type="button" class="button button-sm" disabled={props.saving} onClick={props.onMakeDefault}>
          Make Default
        </button>
      }
    >
      <Chip tone="accent">Default</Chip>
    </Show>
  );

  return (
    <div class="profiles-editor" aria-labelledby="profile-editor-title">
      <h4 class="visually-hidden" id="profile-editor-title">
        {props.r.name}
      </h4>
      <Show
        when={!isOff()}
        fallback={
          <>
            <div class="profiles-editor-head">
              <span class="profiles-editor-name">Off</span>
              {defaultControl()}
            </div>
            <p class="profile-muted">Built in. A chat keeps its own model and modes, and the agent picks every worker.</p>
          </>
        }
      >
        <div class="profiles-editor-head">
          <TextField
            class="profiles-editor-name-field"
            id="profile-name"
            label="Profile name"
            hideLabel
            rule={yours() ? PROFILE_LABEL_RULE : undefined}
            error={yours() ? nameIssue(props.draft, props.r.key) : null}
            value={yours() ? props.draftRow!.name : props.r.name}
            disabled={readOnly() || props.saving}
            onInput={(v) => props.onName(v)}
          />
          {defaultControl()}
        </div>
        <Show when={props.r.group === "project"}>
          <Banner
            tone="warn"
            title="This profile is a file in the project, so an agent or you change it there."
            body={props.r.needsApproval && w()?.session ? `It asks to ${powersText(w()!.session!)}.` : undefined}
            action={
              <Show when={props.r.needsApproval && props.cwd}>
                <button type="button" class="button button-sm button-primary" disabled={props.busy} onClick={props.onApprove}>
                  Approve Profile
                </button>
              </Show>
            }
          />
        </Show>
        <Show when={props.actionError}>{(e) => <Banner tone="error" title={e()} />}</Show>
        <div class="button-row profiles-editor-actions">
          <Show when={yours()}>
            <button type="button" class="button button-sm button-ghost" disabled={props.saving} onClick={props.onDuplicate}>
              Duplicate
            </button>
          </Show>
          <Show when={!props.r.unsaved}>
            <button type="button" class="button button-sm button-ghost" disabled={props.busy} onClick={() => props.onHide(!props.r.hidden)}>
              {props.r.hidden ? "Show In Picker" : "Hide From Picker"}
            </button>
          </Show>
          <Show when={yours()}>
            <button
              type="button"
              class="button button-sm button-destructive"
              disabled={props.saving || props.r.isDefault}
              title={props.r.isDefault ? "Make another profile the default first." : undefined}
              onClick={props.onDelete}
            >
              Delete
            </button>
          </Show>
        </div>

        <div class="tabs profiles-parts" role="tablist" aria-label="Parts">
          <For each={[["models", "Models"], ["start", "When a Chat Starts"]] as const}>
            {([k, label]) => (
              <button
                type="button"
                role="tab"
                id={`${id}-tab-${k}`}
                class={props.part === k ? "tab tab-active" : "tab"}
                aria-selected={props.part === k ? "true" : "false"}
                aria-controls={`${id}-part-${k}`}
                tabIndex={props.part === k ? 0 : -1}
                onClick={() => props.setPart(k)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    const next = k === "models" ? "start" : "models";
                    props.setPart(next);
                    queueMicrotask(() => document.getElementById(`${id}-tab-${next}`)?.focus());
                  }
                }}
              >
                {label}
              </button>
            )}
          </For>
        </div>

        <Show when={props.part === "models"}>
          <div role="tabpanel" id={`${id}-part-models`} aria-labelledby={`${id}-tab-models`} class="profiles-part">
            <p class="profile-muted">A chat can switch to these any time.</p>
            <Show when={shared()}>{(s) => <p class="field-hint profiles-shared">{s()}. An edit here changes it for each.</p>}</Show>
            <ProfileModelsPart
              idPrefix={`profile-${props.r.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
              readOnly={readOnly()}
              disabled={props.saving}
              chat={chat()}
              onChat={yours() ? props.onChat : undefined}
              profile={helpers()}
              change={(fn) => props.changeLib((p) => void fn(p))}
              replace={(fn) => props.changeLib(fn)}
              noHelpers={noHelpers()}
              onChooseHelpers={yours() && props.template ? props.onChooseHelpers : undefined}
              onSetAll={yours() ? props.onSetAll : undefined}
              rows={props.rows}
              options={props.options}
              models={modelList()}
              teamsSeed={props.teamsSeed}
              focusSpec={props.focusSpec}
              onSpecFocused={props.onSpecFocused}
            />
          </div>
        </Show>
        <Show when={props.part === "start"}>
          <div role="tabpanel" id={`${id}-part-start`} aria-labelledby={`${id}-tab-start`} class="profiles-part">
            <p class="profile-muted">Mode and add-ons are where a chat begins; you can still change them in its mode menu. Tools and powers lock at the first message.</p>
            <StartsPart idPrefix={id} starts={session() ?? plainStarts()} name={props.r.name} readOnly={readOnly()} disabled={props.saving} onChange={props.onStarts} />
          </div>
        </Show>
      </Show>
    </div>
  );
}

/**
 * When a Chat Starts (§app.settings-dialog/profile-editor): Mode, Add-ons, Tools, Session powers
 * with their limits, One at a time, the first message and whether the Overseer may start it, each
 * with the rules of the session profile it saves to (§chat.profiles/model, §chat.profiles/enforcement).
 */
function StartsPart(props: { idPrefix: string; starts: Starts; name: string; readOnly: boolean; disabled: boolean; onChange(s: Starts): void }) {
  const off = () => props.readOnly || props.disabled;
  const s = () => props.starts;
  const set = (fn: (x: Starts) => void) => {
    const next = clone(s());
    fn(next);
    props.onChange(next);
  };
  /** Workers never exceed their session: removing any tool but MCP Servers removes Workers & teams too. */
  const takesWorkers = (remove: readonly Removable[]) => remove.some((r) => r !== "workers" && r !== "mcp");
  const toggleTool = (cap: Removable, kept: boolean) =>
    set((x) => {
      const r = new Set(x.remove);
      if (kept) r.delete(cap);
      else r.add(cap);
      if (takesWorkers([...r])) r.add("workers");
      x.remove = REMOVABLE.filter((c) => r.has(c));
    });
  const toggleGrant = (g: Grantable, on: boolean) =>
    set((x) => {
      const r = new Set(x.grant);
      if (on) {
        r.add(g);
        // Messaging and See all each turn reading on.
        if (g !== "sessions.read") r.add("sessions.read");
      } else {
        r.delete(g);
        // Turning reading off turns both off.
        if (g === "sessions.read") {
          r.delete("sessions.message");
          r.delete("sessions.all");
        }
      }
      x.grant = GRANTABLE.filter((c) => r.has(c));
    });
  const toggleMinor = (m: (typeof PROFILE_MINOR_MODES)[number], on: boolean) =>
    set((x) => {
      const r = new Set(x.minorModes ?? []);
      if (on) r.add(m);
      else r.delete(m);
      x.minorModes = PROFILE_MINOR_MODES.filter((c) => r.has(c));
    });
  return (
    <div class="profiles-starts">
      <Select
        id={`${props.idPrefix}-mode`}
        label="Mode"
        class="settings-field"
        value={s().mode ?? ""}
        options={[
          { value: "", label: "This computer's default" },
          { value: "normal", label: "Normal" },
          { value: "delegate", label: "Delegate" },
        ]}
        disabled={off()}
        onChange={(v) =>
          set((x) => {
            if (v === "normal" || v === "delegate") x.mode = v;
            else delete x.mode;
          })
        }
      />
      <fieldset class="profiles-starts-group">
        <legend class="field-label">Add-ons</legend>
        <div class="profiles-starts-checks">
          <For each={PROFILE_MINOR_MODES}>
            {(m) => <Toggle label={MINOR_LABEL[m]} checked={(s().minorModes ?? []).includes(m)} disabled={off()} onChange={(v) => toggleMinor(m, v)} />}
          </For>
        </div>
        <Show
          when={s().minorModes !== undefined}
          fallback={<p class="field-hint">Not set: a chat starts with this computer's default add-ons.</p>}
        >
          <Show when={!props.readOnly}>
            <button type="button" class="button button-sm button-ghost" disabled={off()} onClick={() => set((x) => void delete x.minorModes)}>
              Use Default Add-Ons
            </button>
          </Show>
        </Show>
      </fieldset>
      <fieldset class="profiles-starts-group">
        <legend class="field-label">Tools</legend>
        <div class="profiles-starts-checks">
          <For each={REMOVABLE}>
            {(cap) => (
              <Toggle
                switch
                label={CAPABILITY_LABEL[cap]}
                checked={!s().remove.includes(cap)}
                disabled={off() || (cap === "workers" && takesWorkers(s().remove))}
                title={cap === "workers" && takesWorkers(s().remove) ? SHARES_WORKERS : undefined}
                onChange={(v) => toggleTool(cap, v)}
              />
            )}
          </For>
        </div>
        <Show when={takesWorkers(s().remove)}>
          <p class="field-hint">{SHARES_WORKERS}</p>
        </Show>
      </fieldset>
      <fieldset class="profiles-starts-group">
        <legend class="field-label">Session powers</legend>
        <div class="profiles-starts-checks">
          <For each={GRANTABLE}>{(g) => <Toggle switch label={CAPABILITY_LABEL[g]} checked={s().grant.includes(g)} disabled={off()} onChange={(v) => toggleGrant(g, v)} />}</For>
        </div>
        <Show when={s().grant.length > 0}>
          <div class="settings-team-numbers profiles-limits">
            <For each={LIMIT_KEYS}>
              {(k) => (
                <NumberField
                  class="subagent-editor-number"
                  id={`${props.idPrefix}-limit-${k}`}
                  label={LIMIT_RULES[k].label}
                  rule={LIMIT_RULES[k]}
                  value={String(s().limits[k] ?? "")}
                  disabled={off()}
                  onInput={(raw) => set((x) => ((x.limits as unknown as Record<string, unknown>)[k] = raw))}
                />
              )}
            </For>
          </div>
        </Show>
      </fieldset>
      <Toggle switch label="One at a time" hint="Only one chat on this profile runs at once." checked={s().singleton} disabled={off()} onChange={(v) => set((x) => (x.singleton = v))} />
      <TextArea
        id={`${props.idPrefix}-first-message`}
        label="First message"
        hint="Sent as the chat's first message when it starts on this profile."
        rows={3}
        value={s().firstMessage ?? ""}
        disabled={off()}
        onInput={(v) =>
          set((x) => {
            if (v) x.firstMessage = v;
            else delete x.firstMessage;
          })
        }
      />
      <Toggle switch label="The Overseer may start it" checked={s().overseerMayStart} disabled={off()} onChange={(v) => set((x) => (x.overseerMayStart = v))} />
    </div>
  );
}
