# §mesh/sync — Sync between hosts
> Part of the Sova design spec · [overview](../design/overview.md)

While the mesh is on, hosts share settings, themes, extensions and logins, each category behind its
own toggle. Sessions never sync. Device-bound keys (Tailscale, ssh) never sync. The subagent
profile library merges profile by profile (§mesh.sync/profile-library), and a host keeps the
settings it had whenever another host's copy replaces them (§mesh.sync/kept-copies).

## §mesh.sync/categories — Settings, themes, extensions

A change to a synced category on one host reaches every up peer that has that category on. Each
file is one document (the subagent profile library merges profile by profile instead,
§mesh.sync/profile-library); the most recently changed version wins, a deletion travels like a change,
and a received document is written only if the program that reads it accepts it, atomically and
under that program's own lock where it has one. A file that is a link into a git checkout is never
written. **Settings** are Sova's and pi's host-wide preferences (Sova's experimental switches, new-session
defaults, model favorites, model policy, request limits, mode defaults, the legacy Delegate and
Spec settings, the `subagent-profiles.json` library, and your session profiles, Yours
(`sova/session-profiles.json`, §chat.profiles/projects, validated with its own strict parser)), not
anything a session's own host keeps for it (titles, groups, drafts, archive), and not paths that
only make sense on one machine. The library contains `{version, profiles}` only and is validated
with its own strict parser. `subagent-profiles-default.json` never syncs: each device chooses its
own default; a chat's hidden ID pick stays with its own session (§chat.subagent-profiles/file).
**Themes** are the user theme files; which theme is chosen stays with
the browser. **Extensions**: each host shares the entries of its own installed-extensions list, and never
writes another host's list into it. A host lists its own extensions plus peers' extensions it
lacks. Its own entry always wins, and removing an extension on the host that shared it removes it
everywhere. A peer's extension is only listed here ("not installed on this host"): nothing is
ever served, probed or forwarded for it, even if the same files exist on this host. To use it here,
the user adds it to this host's own list, and that entry wins.

A document's version is dated by when its host first saw that content: a change by the moment the
host noticed it, and a file that first appears there — at the host's first sync run, or later
while it runs — by the file's own modification time (never later than now; after a deletion the
host recorded, just after that deletion), never by the moment it was noticed. So a file made
moments ago by copying or seeding never outvotes an edit made elsewhere before it.

What each peer exchanges is also this host's grant to it (§mesh.peers/grants). A category the peer isn't
granted is neither offered to it, taken from it, pulled from it nor merged, in either direction, and its
extensions aren't listed here. Every other host still exchanges with that peer under its own grants, so a
category this host denies a peer can still reach it through a third host. Your session profiles
(`sova/session-profiles.json`) also need the sessions grant: a profile's first message runs as a
session's opening prompt here, so a peer granted settings but not sessions exchanges every other
settings document but never this one, in either direction. It still reaches that peer through a
third host that grants it both.

## §mesh.sync/profile-library — The subagent profile library merges per profile

The subagent profile library (`subagent-profiles.json`, §chat.subagent-profiles/file) syncs profile
by profile, not as one file. Each host keeps in its own sync state (`<state dir>/doc-sync.json`;
never in the library, whose shape stays what every reader parses) one date per profile id: when
this host first saw that profile's content, and on which host it was made. Hosts exchange those
dates with the library, and each merges what it receives into its own:

- **Only what a host has.** A profile only one side has is kept. A host adds or changes only the
  profiles it has, and never erases one it lacks.
- **Newest edit wins per profile.** Two versions of one profile (one id): the newer edit wins, for
  that profile only; every other profile is untouched.
- **Deletions are recorded.** A profile that leaves a library that still exists is a deletion,
  dated like an edit and kept in the sync state, so it travels to every host and a host that still
  has the profile drops it, unless that host edited it after the deletion. A library file that
  disappears, or a library that first appears (seeded, copied in), deletes nothing.
- **A starter yields.** A seeded library is dated as old (§chat.subagent-profiles/file). While a
  host's library is still only its untouched starter, merging with a library that holds any profile
  edited anywhere takes that library and drops the starter's profile (nothing is recorded as
  deleted). A host alone keeps its starter, and two hosts with only starters keep one.
- **Names stay unique.** When a merge leaves two profiles with one name (ignoring case), the newer
  edit keeps it and the other is renamed with " (2)" (" (3)", …), as a new edit.
- **Checked like any document.** The merged library is checked with its own strict parser before
  it is written, and written as every other document is (§mesh.sync/categories).
- **Older hosts.** A host on an older build exchanges the whole file. What it sends is merged by
  union, each of its profiles dated by its whole file's date, and nothing it lacks is deleted. A
  merge that adds to what it sent is dated as a new edit, so that host takes the union back whole.

## §mesh.sync/kept-copies — A replaced settings document is kept

When sync replaces, changes or removes a settings document on a host with another host's version,
that host first keeps the version it had: under `<state dir>/sync-kept/`, one folder per document,
each kept copy with when it was replaced, which host's copy replaced it, and for the subagent
profile library which profiles were added, changed and removed (by name). Each document keeps its
newest 10; the 11th removes the oldest. Kept copies never sync, and a host's own edits keep nothing.
Settings → Subagents offers the newest kept library back (§chat.subagent-profiles/replaced).

## §mesh.sync/logins — Logins

Logins (pi `auth.json`: OAuth and API keys) merge per provider: the most recent
login wins, and within one login the entry with the newest expiry wins, dead or failed entries never win, a login whose access has merely expired (its refresh still works, e.g. a host that slept) gives way only to the same login or a newer one, never to a different older login, a logout is a tombstone with its own
login time so a later refresh can't resurrect it, and the host that refreshed last refreshes early.
A host is never sent a login, secret or logout for a store it doesn't keep. Claude Code's own
store (`~/.claude`) is not synced: each device keeps its own login there as its last resort, and
added Claude logins move one device at a time through the pool (§app.claude-logins/pool), never
through this sync.
Every local write takes the owning program's own lock and replaces the file atomically at mode 0600. Claude Code's credentials name no account, so a new entry that
replaces one with more than 10 minutes left is a login (a re-login or another account), not a refresh. Known gap:
a Claude Code re-login made in the last 10 minutes of a pre-sync login's access token is taken for a
refresh of it, so a logout of the old login made on another host at about the same time also removes
the new one everywhere; the user logs in once more, and that login survives.

Two hosts that already held different logins for the same provider before they first synced (not
the same account or key, and not the same lineage: a login first seen before sync that a host then
refreshes keeps naming the entry it started from, so a peer's copy from before that refresh takes
the refreshed one) are a conflict, never a silent overwrite: each keeps its own and nothing
for that provider syncs until the user picks one. The Mesh page lists each login with its state and
names the hosts in conflict; **Keep this host's login** makes this host's login win everywhere. The
list never shows a secret, and it and its action exist only while the mesh is on.

Logins move only to and from peers whose grant includes them, and only the logins that grant lists
(§mesh.peers/grants), with their logouts likewise.

## §mesh.sync/api-keys-only — A host that syncs API keys only

A host can sync API keys only: set in Settings → Mesh, or pinned by the host's environment
(`SOVA_SYNC_LOGIN_KINDS`; any value but `all` pins API keys only, so a typo fails closed). Such a
host never offers, takes, stores or refreshes a subscription (OAuth) login through sync, and its
peers send it none; API keys still move both ways. Subscription logins already on it stay there,
unshared and untouched by peers, and logging one out there stays local, also after the host is
switched back to syncing everything. While the mode is pinned, Settings shows it locked with the
reason and a request to change it is refused.
