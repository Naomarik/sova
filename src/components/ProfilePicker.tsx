import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import {
  CAPABILITY_LABEL,
  DEFAULT_PROFILE_ID,
  GRANTABLE,
  lockedReason,
  normalizeCaps,
  REMOVABLE,
  singletonRunningText,
  titleCase,
  type Grantable,
  type Profile,
  type Removable,
} from "../../shared/profiles";
import type { ChatProfileInfo } from "../../shared/protocol";
import { fetchProfiles, pickProfile, saveNewProfile } from "../lib/api";
import { changeRows, defaultTools, guardrailNote, pickerProfiles, profileIconName } from "../lib/profiles";
import { openSettings } from "../lib/settings-nav";
import { toast } from "../lib/ui-state";
import { Banner, Icon, trapFocus } from "./ui";

/** Sessions whose Custom board is open, by path (module state: see `board`). */
const boardsOpen = new Set<string>();

/**
 * The empty screen's Profile select and what it changes (§chat.profiles/picker). A pick is written
 * to the session at once and its runtime reopens (§chat.profiles/applying); the socket's next
 * `profile` message is what this shows, so it never keeps its own idea of the tools.
 */
export function ProfilePicker(props: {
  path: string;
  info: ChatProfileInfo;
  /** The mode and model the session is on (Save as Profile starts with them). */
  mode?: string;
  model?: string | null;
  /** A One at a time race at Send: the session that has it. */
  race?: { label: string; running: { id: string; path: string; title: string } } | null;
  /** Put a profile's first message in an empty composer. */
  onFirstMessage?: (text: string) => void;
}) {
  const [listing, { refetch }] = createResource(() => fetchProfiles().catch(() => undefined));
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [pending, setPending] = createSignal<string | null>(null);
  const [alert, setAlert] = createSignal<{ label: string; running: { id: string; path: string; title: string } } | null>(null);
  // Each flip reopens the runtime and remounts this picker: the board stays open across that.
  const [board, setBoardOpen] = createSignal(boardsOpen.has(props.path));
  const setBoard = (on: boolean) => {
    if (on) boardsOpen.add(props.path);
    else boardsOpen.delete(props.path);
    setBoardOpen(on);
  };
  const [saving, setSaving] = createSignal(false);
  const [showAll, setShowAll] = createSignal(false);

  const current = () => props.info.profile;
  const label = () => current()?.label ?? "Default";
  const lists = createMemo(() => pickerProfiles(listing()));
  const matches = (p: Profile) => !query().trim() || p.label.toLowerCase().includes(query().trim().toLowerCase());
  const runningElsewhere = (p: Profile) => {
    const r = listing()?.running[p.id];
    return r && r.path !== props.path ? r : null;
  };
  const base = createMemo(() => defaultTools(props.info));
  const rows = createMemo(() => (current() ? changeRows(current()!, base()) : []));
  const same = createMemo(() => base().filter((t) => !props.info.removed.includes(t)));
  const note = createMemo(() => guardrailNote(current()?.remove ?? []));

  async function apply(choice: string | { remove: string[]; grant: string[]; from?: string } | null, what: string, profile?: Profile) {
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
  const choose = (p: Profile) => {
    setOpen(false);
    setQuery("");
    const r = runningElsewhere(p);
    if (p.singleton && r) {
      setAlert({ label: p.label, running: r });
      return;
    }
    setBoard(false);
    void apply(p.id === DEFAULT_PROFILE_ID ? null : p.id, p.label, p);
  };

  // The board: kept capabilities and grants, starting from the current pick.
  const [edited, setEdited] = createSignal<{ remove: Removable[]; grant: Grantable[] } | null>(null);
  const caps = () => edited() ?? { remove: current()?.remove ?? [], grant: current()?.grant ?? [] };
  const origin = createMemo(() => {
    const id = current()?.custom ? (listing()?.builtins ?? []).concat(listing()?.profiles ?? []).find((p) => current()!.label.startsWith(p.label))?.id : current()?.id;
    return (listing()?.builtins ?? []).concat(listing()?.profiles ?? []).find((p) => p.id === (id ?? DEFAULT_PROFILE_ID));
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
    void apply({ ...next, ...(origin()?.id && origin()!.id !== DEFAULT_PROFILE_ID ? { from: origin()!.id } : {}) }, "your changes");
  };

  return (
    <section class="profile-picker" aria-label="Profile">
      <div class="profile-select-row">
        <span class="field-label" id="profile-label">
          Profile
        </span>
        <div class="profile-select">
          <button
            type="button"
            class="button profile-select-button"
            aria-haspopup="listbox"
            aria-expanded={open()}
            aria-labelledby="profile-label profile-current"
            onClick={() => setOpen(!open())}
          >
            <Icon name={profileIconName(current()?.icon ?? "grid")} small />
            <span id="profile-current">{label()}</span>
            <Icon name="chevron-down" small />
          </button>
          <Show when={open()}>
            <div class="profile-menu" role="dialog" aria-label="Pick a profile" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
              <input
                class="input"
                type="search"
                placeholder="Find a profile"
                aria-label="Find a profile"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                ref={(el) => queueMicrotask(() => el.focus())}
              />
              <ul class="profile-options" role="listbox" aria-label="Profiles">
                <For each={lists().builtins.filter(matches)}>{(p) => <Option p={p} yours={false} running={!!runningElsewhere(p)} selected={(current()?.id ?? DEFAULT_PROFILE_ID) === p.id} onPick={() => choose(p)} />}</For>
                <Show when={lists().yours.filter(matches).length}>
                  <li class="profile-options-group" role="presentation">
                    Yours
                  </li>
                  <For each={lists().yours.filter(matches)}>{(p) => <Option p={p} yours running={!!runningElsewhere(p)} selected={current()?.id === p.id} onPick={() => choose(p)} />}</For>
                </Show>
                <li role="option" aria-selected={!!current()?.custom} class="profile-option" tabIndex={0} onClick={() => (setOpen(false), setBoard(true))} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(false), setBoard(true))}>
                  <Icon name="wrench" small />
                  <span class="profile-option-name">Custom…</span>
                  <span class="profile-option-meta">Adjust this one</span>
                </li>
              </ul>
              <button type="button" class="button button-sm button-ghost" onClick={() => (setOpen(false), openSettings("profiles"))}>
                Manage Profiles
              </button>
            </div>
          </Show>
        </div>
        <Show when={pending()}>
          <span class="profile-applying" role="status">
            <span class="live-dot" /> Applying {pending()}…
          </span>
        </Show>
      </div>

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
                <button type="button" class="button button-sm" onClick={() => (setAlert(null), setOpen(true))}>
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
          </>
        )}
      </Show>

      <Show when={board()}>
        <div class="profile-board" role="group" aria-label="Capabilities">
          <p class="profile-board-head">
            <span>{changed() ? `${origin()?.label ?? "Default"}, edited` : (origin()?.label ?? "Default")}</span>
            <Show when={changed()}>
              <button type="button" class="button button-sm button-primary" onClick={() => setSaving(true)}>
                Save as Profile
              </button>
              <button
                type="button"
                class="button button-sm"
                onClick={() => {
                  setEdited(null);
                  const o = origin();
                  void apply(o && o.id !== DEFAULT_PROFILE_ID ? o.id : null, o?.label ?? "Default", o);
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

      <Show when={saving()}>
        <SaveProfileSheet
          caps={caps()}
          mode={props.mode}
          model={props.model ?? undefined}
          onCancel={() => setSaving(false)}
          onSaved={(p) => {
            setSaving(false);
            setBoard(false);
            setEdited(null);
            toast(`Saved ${p.label}. New sessions can use it.`);
            void apply(p.id, p.label, p);
          }}
        />
      </Show>
    </section>
  );
}

function Option(props: { p: Profile; yours: boolean; running: boolean; selected: boolean; onPick: () => void }) {
  return (
    <li
      role="option"
      aria-selected={props.selected}
      class="profile-option"
      tabIndex={0}
      onClick={() => props.onPick()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onPick();
        }
      }}
    >
      <Icon name={profileIconName(props.p.icon)} small />
      <span class="profile-option-name">{props.p.label}</span>
      <span class="profile-option-meta">
        {props.yours ? "Yours" : "Built in"}
        {props.p.singleton ? " · One at a time" : ""}
      </span>
      <Show when={props.running}>
        <span class="chip">Running</span>
      </Show>
    </li>
  );
}

/** Save as Profile (§chat.profiles/picker): name, description, One at a time. */
export function SaveProfileSheet(props: {
  caps: { remove: string[]; grant: string[] };
  mode?: string;
  model?: string;
  onCancel: () => void;
  onSaved: (p: Profile) => void;
}) {
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [single, setSingle] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!name().trim()) return setError("Give it a name.");
    setBusy(true);
    try {
      const mode = props.mode === "normal" || props.mode === "delegate" ? props.mode : undefined;
      const p = await saveNewProfile({
        label: name().trim(),
        description: description().trim(),
        icon: "wrench",
        remove: props.caps.remove as Removable[],
        grant: props.caps.grant as Grantable[],
        singleton: single(),
        ...(mode ? { mode } : {}),
        ...(props.model ? { model: props.model } : {}),
      });
      props.onSaved(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <>
      <div class="scrim" onClick={() => !busy() && props.onCancel()} />
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sp-title" ref={(el) => trapFocus(el)} onKeyDown={(e) => e.key === "Escape" && !busy() && props.onCancel()}>
        <div class="modal-head">
          <h2 class="modal-title" id="sp-title">
            Save as profile
          </h2>
        </div>
        <form class="modal-body" id="sp-form" onSubmit={submit}>
          <label class="field">
            <span class="field-label">Name</span>
            <input class="input" value={name()} maxLength={60} onInput={(e) => (setName(e.currentTarget.value), setError(null))} ref={(el) => queueMicrotask(() => el.focus())} />
          </label>
          <label class="field">
            <span class="field-label">Description</span>
            <input class="input" value={description()} maxLength={200} placeholder="One line, shown under the name" onInput={(e) => setDescription(e.currentTarget.value)} />
          </label>
          <label class="toggle toggle-switch">
            <span>One at a time</span>
            <input type="checkbox" checked={single()} onChange={(e) => setSingle(e.currentTarget.checked)} />
            <span class="toggle-box" />
          </label>
          <p class="profile-muted">Starts with this session's mode and model.</p>
          <Show when={error()}>{(m) => <p class="field-error" role="alert">{m()}</p>}</Show>
        </form>
        <div class="modal-foot">
          <button type="button" class="button button-ghost" disabled={busy()} onClick={() => props.onCancel()}>
            Cancel
          </button>
          <button type="submit" form="sp-form" class="button button-primary" disabled={busy()}>
            Save Profile
          </button>
        </div>
      </div>
    </>
  );
}
