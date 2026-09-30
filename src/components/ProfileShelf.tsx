import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
import { singletonRunningText, titleCase, type Profile } from "../../shared/profiles";
import type { SessionSummary } from "../../shared/protocol";
import { fetchProfiles } from "../lib/api";
import { openProfileStart } from "../lib/profile-start";
import { pickerProfiles, profileIconName } from "../lib/profiles";
import { openSettings } from "../lib/settings-nav";
import { Banner, Icon } from "./ui";

/** A shelf sub-group: one profile in use, its live sessions newest started first. */
interface ShelfGroup {
  key: string;
  label: string;
  icon: string;
  singleton: boolean;
  profile?: Profile;
  rows: SessionSummary[];
}

/** The shelf's groups and One at a time slots (§app.session-list/profile-shelf). Pure. */
export function shelfGroups(sessions: readonly SessionSummary[], profiles: readonly Profile[], everRun: readonly string[]): { groups: ShelfGroup[]; slots: Profile[] } {
  const by = new Map<string, ShelfGroup>();
  for (const s of sessions) {
    const p = s.profile;
    if (!p || s.archived) continue;
    const key = p.custom ? `custom:${p.label}` : p.id;
    const g = by.get(key) ?? { key, label: p.label, icon: p.icon, singleton: !!p.singleton, profile: p.custom ? undefined : profiles.find((x) => x.id === p.id), rows: [] };
    g.rows.push(s);
    by.set(key, g);
  }
  const groups = [...by.values()];
  for (const g of groups) g.rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  groups.sort((a, b) => b.rows[0]!.createdAt.localeCompare(a.rows[0]!.createdAt));
  const slots = profiles.filter((p) => p.singleton && everRun.includes(p.id) && !by.has(p.id));
  return { groups, slots };
}

/**
 * The Profiles region (§app.session-list/profile-shelf): a shortcut above Needs you. `row` draws a
 * session row the way the rest of the list does.
 */
export function ProfileShelf(props: { sessions: readonly SessionSummary[] | undefined; searching: boolean; row: (s: SessionSummary) => JSX.Element }) {
  // Re-read whenever the set of profile sessions changes (a start, a stop), not on every poll.
  const key = createMemo(() => (props.sessions ?? []).filter((s) => s.profile && !s.archived).map((s) => s.id).join(","));
  const [listing] = createResource(key, () => fetchProfiles().catch(() => undefined));
  const [open, setOpen] = createSignal(true);
  const shelf = createMemo(() => {
    const l = listing();
    return shelfGroups(props.sessions ?? [], [...(l?.builtins ?? []), ...(l?.profiles ?? [])], l?.everRun ?? []);
  });
  const count = () => shelf().groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <Show when={!props.searching && (shelf().groups.length > 0 || shelf().slots.length > 0)}>
      <details class="sidebar-region sidebar-profiles" aria-labelledby="r-profiles" open={open()} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary class="sidebar-needs-you-summary">
          <h2 class="sidebar-region-head" id="r-profiles" title="Sessions that run with a profile. They are listed below too.">
            <Icon name="chevron-right" small class="icon-twist" />
            Profiles <span class="sidebar-region-count">· {count()}</span>
          </h2>
        </summary>
        <For each={shelf().groups}>
          {(g) => (
            <div class="profile-shelf-group">
              <p class="profile-shelf-head">
                <Icon name={profileIconName(g.icon)} small />
                <span class="profile-shelf-name">{g.label}</span>
                <span class="text-muted">{g.singleton ? "One at a time" : `${g.rows.length} live`}</span>
                <Show when={g.profile && !g.singleton}>
                  <button type="button" class="button button-sm button-ghost profile-shelf-run" aria-label={`Run ${g.label}`} onClick={() => openProfileStart(g.profile!, g.rows[0]?.cwd)}>
                    Run
                  </button>
                </Show>
              </p>
              <ul class="list">
                <For each={g.rows}>{(s) => props.row(s)}</For>
              </ul>
            </div>
          )}
        </For>
        <For each={shelf().slots}>
          {(p) => (
            <p class="profile-shelf-slot">
              <Icon name={profileIconName(p.icon)} small />
              <span class="profile-shelf-name">{p.label}</span>
              <span class="text-muted">· Not running</span>
              <button type="button" class="button button-sm profile-shelf-run" aria-label={`Start ${p.label}`} onClick={() => openProfileStart(p)}>
                Start
              </button>
            </p>
          )}
        </For>
      </details>
    </Show>
  );
}

/** New Session ▾ (§app.session-list/profile-shelf): the saved profiles, each opening the start sheet. */
export function NewSessionProfileMenu(props: { cwd?: string }) {
  const [open, setOpen] = createSignal(false);
  const [listing] = createResource(open, () => fetchProfiles().catch(() => undefined));
  const [alert, setAlert] = createSignal<{ p: Profile; running: { id: string } } | null>(null);
  const lists = () => pickerProfiles(listing());
  const items = () => [...lists().builtins.filter((p) => p.id !== "default"), ...lists().yours];
  const pick = (p: Profile) => {
    const r = listing()?.running[p.id];
    if (p.singleton && r) return setAlert({ p, running: r });
    setOpen(false);
    openProfileStart(p, props.cwd);
  };
  return (
    <span
      class="new-session-menu-wrap"
      onFocusOut={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to || !e.currentTarget.contains(to)) (setOpen(false), setAlert(null));
      }}
      onKeyDown={(e) => e.key === "Escape" && (setOpen(false), setAlert(null))}
    >
      <button type="button" class="button button-icon new-session-menu-trigger" aria-label="New Session with a profile" title="New Session with a profile" aria-haspopup="menu" aria-expanded={open()} onClick={() => (setOpen(!open()), setAlert(null))}>
        <Icon name="chevron-down" small />
      </button>
      <Show when={open()}>
        <div class="profile-popover new-session-menu" role="menu" aria-label="Start a session with a profile">
          <Show when={alert()}>
            {(a) => (
              <Banner
                tone="warn"
                title={singletonRunningText(a().p.label)}
                action={
                  <div class="profile-alert-actions">
                    <a class="button button-sm button-primary" href={`#/sid/${encodeURIComponent(a().running.id)}`} onClick={() => setOpen(false)}>
                      Open the Running {titleCase(a().p.label)}
                    </a>
                    <button type="button" class="button button-sm" onClick={() => setAlert(null)}>
                      Pick Another Profile
                    </button>
                  </div>
                }
              />
            )}
          </Show>
          <For each={items()}>
            {(p) => (
              <button type="button" role="menuitem" class="profile-option" onClick={() => pick(p)}>
                <Icon name={profileIconName(p.icon)} small />
                <span class="profile-option-name">{p.label}</span>
                <span class="profile-option-meta">{lists().yours.includes(p) ? "Yours" : "Saved profile"}{p.singleton ? " · One at a time" : ""}</span>
                <Show when={p.singleton && listing()?.running[p.id]}>
                  <span class="chip">Running</span>
                </Show>
              </button>
            )}
          </For>
          <button type="button" role="menuitem" class="button button-sm button-ghost" onClick={() => (setOpen(false), openSettings("profiles"))}>
            Manage Profiles
          </button>
        </div>
      </Show>
    </span>
  );
}
