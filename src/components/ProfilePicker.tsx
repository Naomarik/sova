import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
  titleCase,
  type Grantable,
  type ListedProfile,
  type Removable,
} from "../../shared/profiles";
import type { ChatProfileInfo, ChatProfileState } from "../../shared/protocol";
import { approveProfile, fetchProfiles, pickProfile, saveCurrentProfile, type ProfilePickRef } from "../lib/api";
import { allProfiles, cardUnusable, changeRows, defaultTools, flippedRemove, guardrailNote, isDefaultCard, isLibraryCard, isMySettings, joinedPickerProfiles, mySettingsCaption, OFF_LABEL, pickRef, profileSettingsLine, type JoinedCard, type MySettingsState } from "../lib/profiles";
import { newChatLine } from "../lib/profile-switch";
import { KEEPS_OWN_MODEL } from "../../shared/profiles";
import { openProfiles } from "../lib/settings-nav";
import { toast } from "../lib/ui-state";
import { PROFILE_GRID_CUSTOM, ProfileGrid } from "./ProfileGrid";
import { Banner, Icon } from "./ui";
import { TextField, Toggle } from "./form";
import { problemOf } from "../../shared/form-rules";
import { PROFILE_LABEL_RULE } from "../../shared/profile-limits";

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
  /** The session's mode, minor modes, model and effort now: what Off keeps while no profile is picked. */
  live?: MySettingsState | null;
  /** Which joined profile the chat is on (its `chat_profile` message): checks a library-only card. */
  chatProfile?: ChatProfileState | null;
  /** A One at a time race at Send: the session that has it. */
  race?: { label: string; running: { id: string; path: string; title: string } } | null;
  /** Put a profile's first message in an empty composer. */
  onFirstMessage?: (text: string) => void;
  /** A pick went through: what reads the chat's setup can read again, ahead of its socket. */
  onApplied?: () => void;
}) {
  const [listing, { refetch, mutate }] = createResource(() => fetchProfiles(props.cwd).catch(() => undefined));
  // Save Current As Profile's form.
  const [saving, setSaving] = createSignal(false);
  const [saveName, setSaveName] = createSignal("");
  const [savingNow, setSavingNow] = createSignal(false);
  /** Why the last save was refused, under the name field until the name changes. */
  const [saveError, setSaveError] = createSignal<string | null>(null);
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
  const lists = createMemo(() => joinedPickerProfiles(listing()));
  const runningElsewhere = (p: ListedProfile) => {
    const r = listing()?.running[p.key];
    return r && r.path !== props.path ? r : null;
  };
  // Off's caption, and what it keeps: the session as it is with no profile, else what picking it puts back.
  const mineKeeps = () => mySettingsCaption(current() ? (props.info.mine ?? null) : props.live);
  // A One at a time profile stopped elsewhere turns back into a card that picks: read the listing
  // again whenever the window regains focus.
  const onFocus = () => void refetch();
  onMount(() => window.addEventListener("focus", onFocus));
  onCleanup(() => window.removeEventListener("focus", onFocus));
  const currentKey = () => {
    const c = current();
    if (c) return !c.custom ? keyOf(c) : null;
    // No session profile: Off, or a library profile picked as Off with its helpers.
    const on = props.chatProfile?.current;
    const lib = on && on.id !== "off" ? lists().yours.find((p) => isLibraryCard(p) && ((p as JoinedCard).joined?.id === on.id || p.key === on.key)) : undefined;
    return lib?.key ?? `sova:${DEFAULT_PROFILE_ID}`;
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
      props.onApplied?.();
      void refetch();
    } catch (err) {
      const body = (err as { body?: { running?: { id: string; path: string; title: string } } }).body;
      if (body?.running && profile) setAlert({ label: profile.label, running: body.running });
      else toast(`Couldn't apply ${what}. ${err instanceof Error ? err.message : String(err)}`);
      setPending(null);
    }
  }
  /** A library profile no session profile links to: picked as Off with its helpers (§chat.profiles/applying). */
  const libraryPick = (p: ListedProfile): ProfilePickRef => ({ source: "library", id: (p as JoinedCard).joined?.libraryId ?? p.id });
  // A One at a time profile live elsewhere is a link, never a pick (ProfileGrid); one that started
  // elsewhere since the listing was read is refused by the server, and `apply` shows its alert.
  const choose = (p: ListedProfile) => {
    setAsking(null);
    if (p.approval === "needed") {
      setAlert(null);
      setAsking(p);
      return;
    }
    setBoard(false);
    void apply(isMySettings(p) ? null : isLibraryCard(p) ? libraryPick(p) : pickRef(p), p.label, p);
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
    setSaveError(null);
    try {
      mutate(await saveCurrentProfile(props.path, name, props.cwd));
      setSaving(false);
      setSaveName("");
      toast(`Saved ${name} to your profiles.`);
    } catch (err) {
      setSaveError(`Couldn't save ${name}. ${err instanceof Error ? err.message : String(err)}`);
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
  /** The board's head: where it started, Off by its own name. */
  const originLabel = () => {
    const o = origin();
    return !o || isMySettings(o) ? OFF_LABEL : o.label;
  };
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
    else remove = flippedRemove(remove, cap as Removable, on);
    const next = normalizeCaps(remove, grant);
    setEdited(next);
    const o = origin();
    void apply({ ...next, ...(o && !isMySettings(o) ? { from: pickRef(o) } : {}) }, "your changes");
  };

  return (
    <section class="profile-picker" aria-label="Profile">
      <Show when={listing()?.defaultProfile}>
        <p class="profile-muted">{newChatLine(listing()?.project.state === "ok" ? listing()?.project.name : null)}</p>
      </Show>
      <ProfileGrid
        path={props.path}
        groups={lists()}
        checked={current()?.custom ? PROFILE_GRID_CUSTOM : currentKey()}
        subagents={listing()?.subagents ?? []}
        mineCaption={{ kind: "words", text: KEEPS_OWN_MODEL }}
        mineKeeps={mineKeeps()}
        isDefault={(p) => isDefaultCard(listing(), p)}
        holder={runningElsewhere}
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
        <button type="button" class="button button-sm button-ghost" onClick={() => openProfiles({ path: props.path })}>
          Manage Profiles
        </button>
        <button type="button" class="button button-sm button-ghost" aria-expanded={saving()} onClick={() => (setSaving(!saving()), setSaveError(null))}>
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
          <TextField
            class="profile-save-field"
            label="Name"
            hint="Saves this session's model and effort, with a copy of its helpers, to Yours. Nothing else changes."
            rule={PROFILE_LABEL_RULE}
            error={saveError()}
            value={saveName()}
            onInput={(raw) => (setSaveName(raw), setSaveError(null))}
            ref={(el: HTMLInputElement) => queueMicrotask(() => el.focus())}
          />
          <div class="profile-alert-actions">
            <button type="submit" class="button button-sm button-primary" disabled={!!problemOf(PROFILE_LABEL_RULE, saveName()) || savingNow()}>
              Save Profile
            </button>
            <button
              type="button"
              class="button button-sm button-ghost"
              onClick={() => {
                setSaving(false);
                setSaveError(null);
              }}
            >
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
        fallback={<p class="profile-muted">No profile: the settings you chose, {props.info.tools.length} tools, no session powers.</p>}
      >
        {(p) => (
          <>
            {/* What the card's glyphs draw, in full words (§chat.profiles/picker). */}
            <Show when={profileSettingsLine(p(), listing()?.subagents ?? [])}>
              {(line) => <p class="profile-settings-line">{line()}</p>}
            </Show>
            <Show when={p().description}>
              <p class="profile-description">{p().description}</p>
            </Show>
            <div class="profile-changes" aria-label="What changes compared with Off">
              <p class="profile-changes-head">
                <span class="text-eyebrow">What changes</span>
                <span class="profile-muted">vs Off</span>
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
                Same as Off: {same().length} tools.{" "}
                <button type="button" class="button-link" aria-expanded={showAll()} onClick={() => setShowAll(!showAll())}>
                  {showAll() ? "Hide" : "Show All"}
                </button>
              </p>
              <Show when={showAll()}>
                <p class="profile-tool-names text-mono">{same().join(", ")}</p>
              </Show>
            </div>
            <Show when={note()}>{(n) => <Banner tone="info" title={n()} />}</Show>
          </>
        )}
      </Show>

      <Show when={board()}>
        <div class="profile-board" role="group" aria-label="Capabilities">
          <p class="profile-board-head">
            <span>{changed() ? `${originLabel()}, edited` : originLabel()}</span>
            <Show when={changed()}>
              <button
                type="button"
                class="button button-sm"
                onClick={() => {
                  setEdited(null);
                  const o = origin();
                  void apply(o && !isMySettings(o) ? pickRef(o) : null, originLabel(), o);
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
                  <span title={why() ?? undefined}>
                    <Toggle switch class="profile-toggle" label={CAPABILITY_LABEL[cap]} checked={!caps().remove.includes(cap)} disabled={!!pending() || !!why()} onChange={(v) => flip(cap, v)} />
                  </span>
                );
              }}
            </For>
            <For each={[...GRANTABLE]}>
              {(cap) => (
                <Toggle switch class="profile-toggle profile-toggle-grant" label={CAPABILITY_LABEL[cap]} checked={caps().grant.includes(cap)} disabled={!!pending()} onChange={(v) => flip(cap, v)} />
              )}
            </For>
          </div>
        </div>
      </Show>

      <p class="profile-muted">Fixed once you send your first message.</p>

    </section>
  );
}
