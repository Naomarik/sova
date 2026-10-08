import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  CAPABILITY_LABEL,
  DEFAULT_PROFILE_ID,
  GRANTABLE,
  keyOf,
  lockedReason,
  normalizeCaps,
  powersText,
  REMOVABLE,
  singletonRunningText,
  sourceOf,
  titleCase,
  type Grantable,
  type ListedProfile,
  type Removable,
} from "../../shared/profiles";
import type { ChatProfileInfo, PlaybookInfo } from "../../shared/protocol";
import { approveProfile, fetchProfiles, pickProfile, saveCurrentProfile, type ProfilePickRef } from "../lib/api";
import { allProfiles, cardUnusable, changeRows, defaultTools, guardrailNote, pickerProfiles, pickRef } from "../lib/profiles";
import { openSettings } from "../lib/settings-nav";
import { toast } from "../lib/ui-state";
import { PROFILE_GRID_CUSTOM, ProfileGrid } from "./ProfileGrid";
import { ProfilePlaybookCard } from "./ProfilePlaybookCard";
import { Banner, Icon } from "./ui";

/** Sessions whose Custom board is open, by path (module state: see `board`). */
const boardsOpen = new Set<string>();

/**
 * The empty screen's profile cards and what the picked one changes (§chat.profiles/picker). A pick is written
 * to the session at once and its runtime reopens (§chat.profiles/applying); the socket's next
 * `profile` message is what this shows, so it never keeps its own idea of the tools.
 */
export function ProfilePicker(props: {
  path: string;
  /** The session's folder: its project's profiles are listed (§chat.profiles/projects). */
  cwd: string | null;
  info: ChatProfileInfo;
  /** A One at a time race at Send: the session that has it. */
  race?: { label: string; running: { id: string; path: string; title: string } } | null;
  /** Put a profile's first message in an empty composer. */
  onFirstMessage?: (text: string) => void;
  /** Why sending isn't possible now, for Run Playbook (the composer's own reason), or null. */
  blocked?: string | null;
  /** Run Playbook (§chat.profiles/playbook): send the linked playbook's turn; false = refused. */
  onRunPlaybook?: (playbook: PlaybookInfo) => boolean;
}) {
  const [listing, { refetch, mutate }] = createResource(() => fetchProfiles(props.cwd).catch(() => undefined));
  // Save Current As Profile's form.
  const [saving, setSaving] = createSignal(false);
  const [saveName, setSaveName] = createSignal("");
  const [savingNow, setSavingNow] = createSignal(false);
  const [pending, setPending] = createSignal<string | null>(null);
  const [alert, setAlert] = createSignal<{ label: string; running: { id: string; path: string; title: string } } | null>(null);
  /** An unapproved project profile that was picked: nothing changed yet (§chat.profiles/trust). */
  const [asking, setAsking] = createSignal<ListedProfile | null>(null);
  // Each flip reopens the runtime and remounts this picker: the board stays open across that.
  const [board, setBoardOpen] = createSignal(boardsOpen.has(props.path));
  const setBoard = (on: boolean) => {
    if (on) boardsOpen.add(props.path);
    else boardsOpen.delete(props.path);
    setBoardOpen(on);
  };
  const [showAll, setShowAll] = createSignal(false);

  const current = () => props.info.profile;
  const label = () => current()?.label ?? "Default";
  const lists = createMemo(() => pickerProfiles(listing()));
  const runningElsewhere = (p: ListedProfile) => {
    const r = listing()?.running[p.key];
    return r && r.path !== props.path ? r : null;
  };
  const currentKey = () => {
    const c = current();
    return c && !c.custom ? keyOf(c) : c?.custom ? null : `sova:${DEFAULT_PROFILE_ID}`;
  };
  const problems = () => listing()?.problems.length ?? 0;
  const base = createMemo(() => defaultTools(props.info));
  const rows = createMemo(() => (current() ? changeRows(current()!, base()) : []));
  const same = createMemo(() => base().filter((t) => !props.info.removed.includes(t)));
  const note = createMemo(() => guardrailNote(current()?.remove ?? []));

  async function apply(choice: ProfilePickRef | { remove: string[]; grant: string[]; from?: ProfilePickRef } | null, what: string, profile?: ListedProfile) {
    setAlert(null);
    setPending(what);
    try {
      await pickProfile(props.path, choice);
      if (profile?.firstMessage) props.onFirstMessage?.(profile.firstMessage);
      void refetch();
    } catch (err) {
      const body = (err as { body?: { running?: { id: string; path: string; title: string } } }).body;
      if (body?.running && profile) setAlert({ label: profile.label, running: body.running });
      else toast(`Couldn't apply ${what}. ${err instanceof Error ? err.message : String(err)}`);
      setPending(null);
    }
  }
  const choose = (p: ListedProfile) => {
    setAsking(null);
    const r = runningElsewhere(p);
    if (p.singleton && r) {
      setAlert({ label: p.label, running: r });
      return;
    }
    if (p.approval === "needed") {
      setAlert(null);
      setAsking(p);
      return;
    }
    setBoard(false);
    void apply(p.source === "sova" && p.id === DEFAULT_PROFILE_ID ? null : pickRef(p), p.label, p);
  };
  const approveAndPick = async (p: ListedProfile) => {
    if (!props.cwd) return;
    try {
      mutate(await approveProfile(props.cwd, p));
    } catch (err) {
      toast(`Couldn't approve ${p.label}. ${err instanceof Error ? err.message : String(err)}`);
      void refetch();
      return;
    }
    setAsking(null);
    setBoard(false);
    void apply(pickRef(p), p.label, p);
  };

  async function saveCurrent() {
    const name = saveName().trim();
    if (!name) return;
    setSavingNow(true);
    try {
      mutate(await saveCurrentProfile(props.path, name));
      setSaving(false);
      setSaveName("");
      toast(`Saved ${name} to your profiles.`);
    } catch (err) {
      toast(`Couldn't save ${name}. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingNow(false);
    }
  }

  // The board: kept capabilities and grants, starting from the current pick.
  const [edited, setEdited] = createSignal<{ remove: Removable[]; grant: Grantable[] } | null>(null);
  const caps = () => edited() ?? { remove: current()?.remove ?? [], grant: current()?.grant ?? [] };
  const origin = createMemo(() => {
    const all = allProfiles(listing());
    const c = current();
    if (c?.custom) return all.find((p) => c.label === `${p.label}, edited`) ?? all.find((p) => p.source === "sova" && p.id === DEFAULT_PROFILE_ID);
    const key = c ? keyOf(c) : `sova:${DEFAULT_PROFILE_ID}`;
    return all.find((p) => p.key === key);
  });
  const changed = () => {
    const o = origin();
    const c = caps();
    return !!o && (o.remove.join() !== c.remove.join() || o.grant.join() !== c.grant.join());
  };
  const flip = (cap: Removable | Grantable, on: boolean) => {
    const c = caps();
    const isGrant = (GRANTABLE as readonly string[]).includes(cap);
    let remove = [...c.remove] as string[];
    let grant = [...c.grant] as string[];
    if (isGrant) grant = on ? [...grant, cap] : grant.filter((g) => g !== cap && !(cap === "sessions.read" && (g === "sessions.message" || g === "sessions.all")));
    else if (!on) remove = [...remove, cap];
    else {
      remove = remove.filter((r) => r !== cap);
      // Workers went with the last other removal (§chat.profiles/enforcement), so they come back with it.
      if (cap !== "workers" && remove.length === 1 && remove[0] === "workers") remove = [];
    }
    const next = normalizeCaps(remove, grant);
    setEdited(next);
    const o = origin();
    void apply({ ...next, ...(o && !(o.source === "sova" && o.id === DEFAULT_PROFILE_ID) ? { from: pickRef(o) } : {}) }, "your changes");
  };

  return (
    <section class="profile-picker" aria-label="Profile">
      <ProfileGrid
        path={props.path}
        groups={lists()}
        checked={current()?.custom ? PROFILE_GRID_CUSTOM : currentKey()}
        subagents={listing()?.subagents ?? []}
        running={(p) => !!runningElsewhere(p)}
        unusable={(p) => cardUnusable(listing(), p)}
        onPick={choose}
        onCustom={() => setBoard(true)}
      />
      <Show when={problems()}>
        <p class="profile-muted">
          {problems()} profile file{problems() === 1 ? " has" : "s have"} mistakes. See Manage Profiles.
        </p>
      </Show>
      <div class="profile-actions">
        <button type="button" class="button button-sm button-ghost" onClick={() => openSettings("profiles")}>
          Manage Profiles
        </button>
        <button type="button" class="button button-sm button-ghost" aria-expanded={saving()} onClick={() => setSaving(!saving())}>
          Save Current As Profile
        </button>
        <Show when={pending()}>
          <span class="profile-applying" role="status">
            <span class="live-dot" /> Applying {pending()}…
          </span>
        </Show>
      </div>
      <Show when={saving()}>
        <form
          class="profile-save"
          aria-label="Save current as profile"
          onSubmit={(e) => {
            e.preventDefault();
            void saveCurrent();
          }}
        >
          <label class="field profile-save-field">
            <span class="field-label">Name</span>
            <input class="input" type="text" maxLength={60} required value={saveName()} onInput={(e) => setSaveName(e.currentTarget.value)} ref={(el) => queueMicrotask(() => el.focus())} />
            <span class="field-hint">Saves this session's model, effort and subagent profile to Yours. Nothing else changes.</span>
          </label>
          <div class="profile-alert-actions">
            <button type="submit" class="button button-sm button-primary" disabled={!saveName().trim() || savingNow()}>
              Save Profile
            </button>
            <button type="button" class="button button-sm button-ghost" onClick={() => setSaving(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Show>

      <Show when={alert() ?? props.race}>
        {(a) => (
          <Banner
            tone="warn"
            title={alert() ? singletonRunningText(a().label) : `${a().label} started in another session. Nothing was sent. Open it or pick another profile.`}
            action={
              <div class="profile-alert-actions">
                <a class="button button-sm button-primary" href={`#/sid/${encodeURIComponent(a().running.id)}`}>
                  Open the Running {titleCase(a().label)}
                </a>
                <button type="button" class="button button-sm" onClick={() => setAlert(null)}>
                  Pick Another Profile
                </button>
              </div>
            }
          />
        )}
      </Show>

      <Show when={asking()}>
        {(p) => (
          <Banner
            tone="warn"
            title={`${p().label} comes from ${p().projectName ?? "this project"}'s files and can ${powersText(p())}. Approve it to use it.`}
            action={
              <div class="profile-alert-actions">
                <button type="button" class="button button-sm button-primary" onClick={() => void approveAndPick(p())}>
                  Approve
                </button>
                <button type="button" class="button button-sm" onClick={() => setAsking(null)}>
                  Pick Another Profile
                </button>
              </div>
            }
          />
        )}
      </Show>

      <Show when={props.info.by === "overseer" && current()}>{(p) => <p class="profile-muted">Started by the Overseer with {p().label}.</p>}</Show>

      <Show
        when={current()}
        fallback={<p class="profile-muted">Everything a new session has today: {props.info.tools.length} tools, no session powers.</p>}
      >
        {(p) => (
          <>
            <Show when={p().description}>
              <p class="profile-description">{p().description}</p>
            </Show>
            <div class="profile-changes" aria-label="What changes compared with Default">
              <p class="profile-changes-head">
                <span class="text-eyebrow">What changes</span>
                <span class="profile-muted">vs Default</span>
                <Show when={p().singleton}>
                  <span class="chip" title="Only 1 live session can use this profile at a time">
                    One at a time
                  </span>
                </Show>
              </p>
              <ul class="profile-change-list">
                <For each={rows()}>
                  {(r) => (
                    <li classList={{ "profile-change": true, "profile-change-add": r.sign === "+" }}>
                      <span class="profile-change-sign" aria-hidden="true">
                        {r.sign}
                      </span>
                      <span class="profile-change-name">
                        {r.label}
                        <span class="visually-hidden">{r.sign === "+" ? ", added" : ", removed"}</span>
                      </span>
                      <span class="profile-change-detail">{r.detail}</span>
                    </li>
                  )}
                </For>
              </ul>
              <p class="profile-same">
                Same as Default: {same().length} tools.{" "}
                <button type="button" class="button-link" aria-expanded={showAll()} onClick={() => setShowAll(!showAll())}>
                  {showAll() ? "Hide" : "Show All"}
                </button>
              </p>
              <Show when={showAll()}>
                <p class="profile-tool-names text-mono">{same().join(", ")}</p>
              </Show>
            </div>
            <Show when={note()}>{(n) => <Banner tone="info" title={n()} />}</Show>
            <Show when={p().playbook}>
              {(id) => (
                <ProfilePlaybookCard
                  cwd={props.cwd}
                  playbook={id()}
                  source={p().custom ? undefined : sourceOf(p())}
                  blocked={props.blocked ?? null}
                  onRun={(pb) => props.onRunPlaybook?.(pb) ?? false}
                />
              )}
            </Show>
          </>
        )}
      </Show>

      <Show when={board()}>
        <div class="profile-board" role="group" aria-label="Capabilities">
          <p class="profile-board-head">
            <span>{changed() ? `${origin()?.label ?? "Default"}, edited` : (origin()?.label ?? "Default")}</span>
            <Show when={changed()}>
              <button
                type="button"
                class="button button-sm"
                onClick={() => {
                  setEdited(null);
                  const o = origin();
                  void apply(o && !(o.source === "sova" && o.id === DEFAULT_PROFILE_ID) ? pickRef(o) : null, o?.label ?? "Default", o);
                }}
              >
                Reset
              </button>
            </Show>
          </p>
          <div class="profile-board-grid">
            <For each={[...REMOVABLE]}>
              {(cap) => {
                const why = () => lockedReason(cap, caps().remove);
                return (
                  <label class="toggle toggle-switch profile-toggle" title={why() ?? undefined}>
                    <span>{CAPABILITY_LABEL[cap]}</span>
                    <input type="checkbox" checked={!caps().remove.includes(cap)} disabled={!!pending() || !!why()} onChange={(e) => flip(cap, e.currentTarget.checked)} />
                    <span class="toggle-box" />
                  </label>
                );
              }}
            </For>
            <For each={[...GRANTABLE]}>
              {(cap) => (
                <label class="toggle toggle-switch profile-toggle profile-toggle-grant">
                  <span>{CAPABILITY_LABEL[cap]}</span>
                  <input type="checkbox" checked={caps().grant.includes(cap)} disabled={!!pending()} onChange={(e) => flip(cap, e.currentTarget.checked)} />
                  <span class="toggle-box" />
                </label>
              )}
            </For>
          </div>
        </div>
      </Show>

      <p class="profile-muted">Fixed once you send your first message.</p>

    </section>
  );
}
