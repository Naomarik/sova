import { createMemo, createResource, createSignal, For, Show, type JSX } from "solid-js";
import { keyOf, type ListedProfile } from "../../shared/profiles";
import type { SessionSummary } from "../../shared/protocol";
import { fetchProfiles } from "../lib/api";
import { runProfile } from "../lib/profile-start";
import { allProfiles, profileIconName } from "../lib/profiles";
import { Icon } from "./ui";

/** A shelf sub-group: one profile in use, its live sessions newest started first. */
interface ShelfGroup {
  key: string;
  label: string;
  icon: string;
  singleton: boolean;
  /** A project profile's project name, shown on the head. */
  projectName?: string;
  profile?: ListedProfile;
  rows: SessionSummary[];
}

/** A One at a time profile run before, with no live session: its slot. */
interface ShelfSlot {
  profile: ListedProfile;
  /** Where Start makes the session: the project's root for a project profile. */
  cwd?: string;
}

/**
 * The shelf's groups and One at a time slots (§app.session-list/profile-shelf), keyed by profile
 * identity (§chat.profiles/projects), so the same id in two projects is two groups. `profiles`:
 * every profile the listings know (a slot needs its profile to still exist). Pure.
 */
export function shelfGroups(sessions: readonly SessionSummary[], profiles: readonly ListedProfile[], everRun: readonly string[]): { groups: ShelfGroup[]; slots: ShelfSlot[] } {
  const by = new Map<string, ShelfGroup>();
  for (const s of sessions) {
    const p = s.profile;
    if (!p || s.archived) continue;
    const key = p.custom ? `custom:${p.label}` : keyOf(p);
    const g =
      by.get(key) ??
      {
        key,
        label: p.label,
        icon: p.icon,
        singleton: !!p.singleton,
        ...(p.projectName ? { projectName: p.projectName } : {}),
        profile: p.custom ? undefined : profiles.find((x) => x.key === key),
        rows: [],
      };
    g.rows.push(s);
    by.set(key, g);
  }
  const groups = [...by.values()];
  for (const g of groups) g.rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  groups.sort((a, b) => b.rows[0]!.createdAt.localeCompare(a.rows[0]!.createdAt));
  const seen = new Set<string>();
  const slots: ShelfSlot[] = [];
  for (const p of profiles) {
    if (!p.singleton || seen.has(p.key) || !everRun.includes(p.key) || by.has(p.key)) continue;
    seen.add(p.key);
    slots.push({ profile: p, ...(p.project ? { cwd: p.project } : {}) });
  }
  return { groups, slots };
}

/**
 * The Profiles region (§app.session-list/profile-shelf): a shortcut above Needs you. `row` draws a
 * session row the way the rest of the list does; `cwd` is the open session's folder.
 */
export function ProfileShelf(props: { sessions: readonly SessionSummary[] | undefined; searching: boolean; cwd: string | null; row: (s: SessionSummary) => JSX.Element }) {
  // The folders whose profiles the shelf needs: the open one, and each folder a profile session ran
  // in (a project profile exists only in its own project's listing). Re-read when that set changes.
  const folders = createMemo(() => {
    const set = new Set<string>();
    if (props.cwd) set.add(props.cwd);
    for (const s of props.sessions ?? []) if (s.profile && !s.profile.custom && (!s.archived || s.profile.singleton)) set.add(s.profile.project ?? s.cwd);
    return [...set].sort().join("\n");
  });
  // And whenever the set of live profile sessions changes (a start, a stop), not on every poll.
  const live = createMemo(() => (props.sessions ?? []).filter((s) => s.profile && !s.archived).map((s) => s.id).join(","));
  const [listings] = createResource(
    () => `${folders()}|${live()}`,
    async () => Promise.all((folders() ? folders().split("\n") : [undefined]).map((c) => fetchProfiles(c).catch(() => undefined))),
  );
  const [open, setOpen] = createSignal(true);
  const shelf = createMemo(() => {
    const ls = (listings() ?? []).filter((l) => !!l);
    const profiles = ls.flatMap((l) => allProfiles(l));
    const everRun = [...new Set(ls.flatMap((l) => l!.everRun))];
    return shelfGroups(props.sessions ?? [], profiles, everRun);
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
                <Show when={g.projectName}>
                  <span class="profile-shelf-project">· {g.projectName}</span>
                </Show>
                <span class="text-muted">{g.singleton ? "One at a time" : `${g.rows.length} live`}</span>
                <Show when={g.profile && !g.singleton}>
                  <button type="button" class="button button-sm button-ghost profile-shelf-run" aria-label={`Run ${g.label}`} onClick={() => void runProfile(g.profile!, g.rows[0]?.cwd)}>
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
          {(slot) => (
            <p class="profile-shelf-slot">
              <Icon name={profileIconName(slot.profile.icon)} small />
              <span class="profile-shelf-name">{slot.profile.label}</span>
              <Show when={slot.profile.projectName}>
                <span class="profile-shelf-project">· {slot.profile.projectName}</span>
              </Show>
              <span class="text-muted">· Not running</span>
              <button type="button" class="button button-sm profile-shelf-run" aria-label={`Start ${slot.profile.label}`} onClick={() => void runProfile(slot.profile, slot.cwd ?? props.cwd)}>
                Start
              </button>
            </p>
          )}
        </For>
      </details>
    </Show>
  );
}
