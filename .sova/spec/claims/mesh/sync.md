# §mesh/sync — Sync between hosts
> Part of the Sova design spec · [overview](../design/overview.md)

While the mesh is on, hosts share settings, themes, extensions and logins, each category behind its
own toggle. Sessions never sync. Device-bound keys (Tailscale, ssh) never sync.

## §mesh.sync/categories — Settings, themes, extensions

A change to a synced category on one host reaches every up peer that has that category on. Each
file is one document; the most recently changed version wins, a deletion travels like a change,
and a received document is written only if the program that reads it accepts it, atomically and
under that program's own lock where it has one. A file that is a link into a git checkout is never
written. **Settings** are Sova's and pi's host-wide preferences (the Claude Code switch, new-session
defaults, model favorites, model policy, mode defaults and the Delegate and Spec settings), not
anything a session's own host keeps for it (titles, groups, drafts, archive), and not paths that
only make sense on one machine. **Themes** are the user theme files; which theme is chosen stays with
the browser. **Extensions**: each host shares the entries of its own installed-extensions list, and never
writes another host's list into it. A host lists its own extensions plus peers' extensions it
lacks. Its own entry always wins, and removing an extension on the host that shared it removes it
everywhere. A peer's extension is only listed here ("not installed on this host"): nothing is
ever served, probed or forwarded for it, even if the same files exist on this host. To use it here,
the user adds it to this host's own list, and that entry wins.

## §mesh.sync/logins — Logins

Logins (pi `auth.json`: OAuth and API keys; Claude Code credentials) merge per provider: the most recent
login wins, and within one login the entry with the newest expiry wins, dead or failed entries never win, a login whose access has merely expired (its refresh still works, e.g. a host that slept) gives way only to the same login or a newer one, never to a different older login, a logout is a tombstone with its own
login time so a later refresh can't resurrect it, and the host that refreshed last refreshes early.
Every local write takes the owning program's own lock and replaces the file atomically at mode 0600. Claude Code's credentials name no account, so a new entry that
replaces one with more than 10 minutes left is a login (a re-login or another account), not a refresh.

Two hosts that already held different logins for the same provider before they first synced (not
the same account or key) are a conflict, never a silent overwrite: each keeps its own and nothing
for that provider syncs until the user picks one. The Mesh page lists each login with its state and
names the hosts in conflict; **Keep this host's login** makes this host's login win everywhere. The
list never shows a secret, and it and its action exist only while the mesh is on.

## §mesh.sync/api-keys-only — A host that syncs API keys only

A host can sync API keys only: set in Settings → Mesh, or pinned by the host's environment
(`SOVA_SYNC_LOGIN_KINDS`; any value but `all` pins API keys only, so a typo fails closed). Such a
host never offers, takes, stores or refreshes a subscription (OAuth) login through sync, and its
peers send it none; API keys still move both ways. Subscription logins already on it stay there,
unshared and untouched by peers, and logging one out there stays local, also after the host is
switched back to syncing everything. While the mode is pinned, Settings shows it locked with the
reason and a request to change it is refused.
