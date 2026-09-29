# §app/claude-logins — Several Claude logins, with failover
> Part of the Sova design spec · [overview](../design/overview.md)

A host can hold more than one Claude subscription login, so that a session or a worker that hits
a usage limit, or whose sign-in stops working, moves on to another login instead of stopping.
The unit is a **login**: one Claude Code config directory with its own `.credentials.json`, that
is, one refresh chain. Several logins may belong to the same Claude account (the same
`accountUuid`); they are kept, and listed together under that account. Claude Code stays the only
program that signs in, refreshes and signs out: Sova runs `claude` in the login's directory and
never reads or writes a token itself.

Claude Code's own directory (`~/.claude`, or `$CLAUDE_CONFIG_DIR` when the server has one) is
the implicit login `default`. A `$CLAUDE_CONFIG_DIR` that names an added login's directory (anything
under `claude-accounts/` of the agent dir or of pi's default `~/.pi/agent`, followed through links)
is not: that is what every `claude` Sova runs on an added login passes down to its tools, so a
process started under one (a pi, a Sova) takes `~/.claude` for `default`. It is always present, never moved, never in the pool
(§app.claude-logins/pool), never written by any of this, and always the device's last resort. With no other login added, everything behaves as before: every `claude` process runs on
`default`; a Claude Code chat's first turn records that it runs on `default` in a hidden entry,
which nothing shows.

The login registry, per-spawn selection and failover live in the claude-code extension
(`pi-config/extensions/claude-code/accounts.ts`, node built-ins only); the server reads and
writes the registry through that file, like Settings → Teams does `team-defaults.json`.

## §app.claude-logins/registry — The registry and a login's directory

The registry is `<agent dir>/claude-accounts.json` (`{version: 1, logins, devices}`), written
atomically (temporary file, then rename). A malformed file lists no added login, is never
overwritten, and every spawn uses `default`.

Each login has an `id` (`l-` and 8 hex digits), an optional `label`, `addedAt`, `enabled`, the
`device` it is assigned to, and its `identity`: `accountUuid`, `email`, `orgUuid`, `orgName`,
`plan` and `rateLimitTier`, copied from `oauthAccount` in the directory's `.claude.json` (which
Claude Code writes at sign-in), or from `claude auth status --json` when that is missing. The plan
is the subscription (`subscriptionType`, else the organization type without its `claude_` prefix,
such as `max`), never the billing type (`stripe_subscription`); every surface shows it as people
say it, from the rate-limit tier when it names one ("Max 20x"), else from the plan ("Max",
"Pro"), and shows no plan for anything else. The identity names no token. `default`'s identity is read the same way from Claude Code's own
`.claude.json` (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that directory is
`default`'s), and never stored.

A login's directory is `<agent dir>/claude-accounts/<id>/`, mode 0700, derived from the id and
never stored. Inside it, `projects/`, `settings.json`, `CLAUDE.md`, `agents/`, `commands/`,
`skills/` and `plugins/` are symlinks to the same names in `default`'s directory (each one only
when it exists there; `projects/` always, created there if missing). So every login writes its
Claude session records into the one shared `projects/`: `--resume` after a switch finds the
session, and every transcript and usage reader keeps reading one place. The links are repaired
whenever a login is used: a repair replaces a link that points elsewhere (the link itself, never
what it pointed to), leaves a real file or directory alone, never makes a link whose target lies
inside the login's own directory, and refuses a `default` directory that is itself under
`claude-accounts/`, before writing anything.

**Devices.** A login is assigned to at most one device (`device`): the device that holds it. While
the mesh is on, `null` means this host keeps it free for lending (§app.claude-logins/keeper) and
never runs it; with the mesh off, a login kept here is used like one assigned here. Each device has
its own ordered list of logins (`devices[<device id>].order`, which may include `default`, and
`defaultEnabled`). This host's device id is `SOVA_DEVICE_ID` when set, else its mesh id (`self.id`
in `<agent dir>/sova/peers.json`) when it has one, else `local`; a login assigned to `local`
belongs to this host, and a device entry kept under `local` moves to the mesh id at the next change. Only logins
assigned to this host are ever used here. A login this host has no order entry for comes after the
ordered ones, in the order they were added; `default` always comes last, wherever the order places
it: Claude Code's own login is the last resort.

## §app.claude-logins/add-remove — Adding and removing a login

Settings → Accounts → **Add login** starts `claude auth login --claudeai` for a new login
directory, with no terminal: its standard input is a pipe, `BROWSER` does nothing, and the
variables that would override a login (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`) are removed. The dialog shows the authorize URL Claude Code prints
(to open in any browser, on any device) and a field for the code the page shows afterwards. The
code is written to the process as one line; a code Claude Code refuses as malformed ("Invalid
code") keeps the flow waiting for another. Once Claude Code exits successfully and the directory
holds `.credentials.json`, the login is added to the registry, assigned to this host,
appended to its order, enabled, and shown with its email, organization and plan; while the mesh is
on it joins the pool, held by this device. **Sign In Again** on a login of the pool runs the same
flow for that login's id (`POST /api/claude/accounts/flow` `{login}`) in a fresh directory, moves the
new credentials into the login's directory here on success, and makes this device its holder
(§app.claude-logins/stuck). A flow that
fails, is cancelled, or is left alone for 10 minutes kills the process and deletes the new
directory; nothing is added. At most one flow runs at a time.

A login whose account (`accountUuid`) is already present is still added; the panel says it
shares that account's usage limits, so it only helps when the other login's sign-in fails.

**Remove** asks first, then runs `claude auth logout` in the login's directory (bounded; its
failure does not stop the removal), deletes the directory, and drops the login from the registry
and from every device's order. While the mesh is on it also removes the login from the pool; when
another device holds it, that device stops every process on it and deletes its copy as plain files,
without signing out. `default` cannot be removed.

## §app.claude-logins/device-order — This device's order, and which logins it may use

With the mesh off, Settings → Accounts lists this host's logins in its order, `default` (always
last) included, each with its
label or email, organization and plan; a login that shares its account with another row says so,
and that the two share usage limits. Each row can move up or down, be switched off or on (**Use**,
`enabled`; off = never chosen automatically), and be removed (not `default`). A row shows the
login's standing on this host as a chip: **Ready**, **Off**, **Limited until** a time (`resetsAt`),
**Sign in again**, or **Not signed in** (its directory holds no credentials). A limited or
sign-in-again row has **Clear**, which forgets that standing. Every change is saved at once.

## §app.claude-logins/spawn-selection — Every `claude` process runs on one login

Every `claude` process Sova or its extensions start runs on exactly one login, by setting
`CLAUDE_CONFIG_DIR` to that login's directory (or, for `default`, leaving the environment as it
was, less an inherited `CLAUDE_CONFIG_DIR` that names an added login's directory): the Claude Code chat provider's child for a session, claude-code workers (including a
worker's detached host), model discovery (the extension's and the server's), the server's
`claude --version` check, and the topic-outline summarizer.

The login is **this host's first usable login in its order**: enabled, assigned here, neither
limited nor needing sign-in, and not leaving this device (§app.claude-logins/drain). While the mesh
is on, a chat's child or a worker that would otherwise start on `default` (nothing else usable here)
first asks this host's Sova to borrow a login (§app.claude-logins/borrow-return) and waits for it, up
to 30 seconds and only while that Sova's pool agent runs. A chat session records the login its child runs on in a hidden
`claude-login` custom entry (`{v: 1, login, label?, from?, fromLabel?, reason?, resetsAt?, text?}`),
written when the session's child first starts on a login (`default` included: a session with no
entry records the login it starts on) and whenever the login then differs from the session's last
one. When the session's child
starts again — after a restart, a model change, a rewind — it keeps its current (or newest
recorded) login while that login is still usable, else it takes the first usable one. When no
login is usable, it keeps that login, else the order's first: that is how it behaved before, and
the failure it meets is the one it would have met.

## §app.claude-logins/failover — Moving to the next login on a limit or a failed sign-in

The claude-code transport recognises two account failures in a turn's stream: a **limit** (a
`rate_limit_event` whose status is `rejected`, then an error result; or an assistant error
`rate_limit` or `billing_error`; or a result reading "usage limit reached" or "hit your limit")
and an **auth** failure (an assistant error `authentication_failed`, `oauth_org_not_allowed` or
`account_on_hold`; a second `api_retry` for `authentication_failed` or a 401, decided then rather
than after the CLI's minutes of retries; or a result reading "Not logged in", "Please run /login",
"Invalid API key", "OAuth token expired/revoked", "401"). A rejection followed by an allowed status
(extra usage) and a successful result is not one, and an aborted turn never is. A limit carries
`resetsAt` and its window (`five_hour`, `seven_day`, …) when the stream gave them. The synthetic
assistant message that carries the failure never reaches the chat as an answer.

Each failure is recorded for the host in `<agent dir>/claude-accounts-state.json`. A limit puts
the login, **and every login here that shares its account**, out until `resetsAt` (15 minutes
when unknown). An auth failure puts the login out until its `.credentials.json` changes (Claude
Code re-signed it in or refreshed it) or the user clears it. Sova never runs a login that is out
to see whether it has recovered.

On a failure, a chat turn or a claude-code worker moves to the next usable login in this host's
order, skipping, for a limit, every login of the same account (an auth failure may move to another
login of the same account). While the mesh is on, the failed login also goes back to the keeper
with its standing (§app.claude-logins/borrow-return), and when no other added login is usable here
the next one is borrowed first (not of the same account on a limit); `default` comes only after
that:

- **Chat session.** If the provider has not yet streamed anything for the turn, the session's
  child is restarted on the new login the way a model change restarts it (the history folded into
  one message), the turn is sent again, and the answer arrives in the same turn. The session gets
  a `claude-login` entry with the switch, and the chat shows it as a note row: `Claude: switched
  {from} → {to} ({5h limit, resets 15:00 | sign-in failed})`; a TUI shows the same text as a
  notification. If something had already streamed, the turn ends with its error as before, and the
  next turn starts a fresh child on the next usable login.
- **Worker.** The worker's `claude` is stopped and started again on the new login with `--resume`
  of its own Claude session (the same session id), and the interrupted message is sent again
  (prefixed with a note that it was interrupted, when the worker had already used a tool). Its
  transcript gets the same note line, and no completion is announced for the failed attempt. The
  worker's id, record and usage carry on; a worker that was running under a detached host
  continues without one, and a worker re-adopted from its detached host after a restart does not
  fail over.

With no usable login left, the failure ends the turn or the task exactly as before: the error,
and the team usage pause. A turn fails over at most once per login.

**Development switch.** With `SOVA_CLAUDE_ACCOUNTS_DEV=1` in the environment,
`<agent dir>/claude-accounts-dev.json` (`{"forceLimit": [ids], "forceAuth": [ids]}`) makes those
logins answer every message with a synthetic limit (resetting in an hour) or auth failure instead
of sending it to Claude, so failover can be driven end to end without spending a login. Without
the variable the file is never read.

## §app.claude-logins/active-login — Which login a chat is on

A chat's Claude login is its newest `claude-login` entry (§app.claude-logins/spawn-selection),
which the provider writes when the chat's child first starts and at every switch; a chat that has
none yet (it never ran a Claude turn here) is shown the login this device would start it on now:
its first usable login in the device's order.

- **Composer foot.** On a chat whose model is a Claude Code model (`claude-code-cli/…`), on a
  device with more than one login in its order, a quiet `.composer-login` sits right after the
  model indicator: the login's email (else its label or id), in caption size and muted ink,
  ellipsized at 26 characters; on a phone width only the part before the `@`, at most 12. It is
  not a control. Its `title` says
  "This chat runs on this Claude login: {label ·} {email} · {plan}. Order and standing: Settings →
  Accounts." — or, before the chat recorded one, "This chat starts on this Claude login (first
  ready on this device): …"; its `aria-label` is "Claude login: {email}". With a single login, or
  on another provider's model, nothing is shown.
- **Wire.** `/ws/chat` sends `{type: "claude_login", login}` (`ChatClaudeLogin`: `id`, `name`,
  `email?`, `planLabel?`, `recorded`, `several`, or `null` when the registry can't name one) after
  every hello, only on a device with several logins (a hello clears the last one), and whenever a
  `claude-login` entry is appended, so a failover moves the indicator in the same turn. A switch
  still shows its note row.
- **TUI.** The usage-status footer shows the Claude usage of the session's login: its newest
  `claude-login` entry, else — before the session's first Claude turn — the login this device
  would start it on now (its first usable login, as above; Claude Code's own only when the
  registry can't be read). An added login's reading is its own entry in `claudeAccounts`;
  `default`'s is the cache's `claude`.
- **Usage readouts.** The sidebar foot's usage glance and the Usage page's summary lead read the
  same login for the chat on screen (§app.insights/sidebar-foot). Its `/usage` screen lists Claude Code's own login and then each added one, each titled
  "Claude · {email}" with its plan.

## §app.claude-logins/accounts-tab — Settings → Accounts

A tab in Settings, **Accounts**, between Models and Modes. Its **Claude Logins** section says that
every Claude process on this device (its mesh name, or "This device") runs on the first ready
login in the order, then lists the logins (§app.claude-logins/device-order); Remove asks inline
what goes away and what stays. Under the list, **Add a login** (§app.claude-logins/add-remove) is
a panel with four states: starting ("Starting Claude Code's sign-in…"); waiting for the code (the
URL as a link with **Copy Link**, a **Code** field, **Finish Sign-In** and **Cancel**, and the
reason when Claude Code refused a code); done (**Added**, the new login's email, organization and
plan, whether it shares an account already here, and **Done**); failed (the reason, "Nothing was
added.", **Close** and **Try Again**). Closing Settings cancels a flow still waiting for its code.
No token or credential is ever shown or sent to the browser.

**While the mesh is on** the section is the pool (§app.claude-logins/pool): an intro that every
device shares these logins, one at a time, borrowed from the keeper and given back after a limit,
on request or after 30 minutes idle, with Claude Code's own login as each device's last resort; a
**Keeper** select (every device, this one marked, an offline one marked; a hint that says what the
keeper does, or that nobody can borrow while it is offline); then ONE list of every login in the
pool's order, each row with its email (or label), organization and plan, the shared-account note,
its usage when its holder published one, a move under way ("Leaving this device (hit its limit):
waiting for its Claude processes to finish", "Returning after the current turn", …), a holder chip
(**This device**, the holding device's name, **Free**, or **Stuck on** a device) and its standing
chip, and the controls: a pin select (**No pin** / **Pin to** each device), **Return** (a held login
not already leaving), **Sign In Again** (stuck, or needing sign-in), Up / Down (the pool's order),
**Use**, **Clear** and **Remove** (which says it leaves the pool on every device). Under it,
**This device's own login** lists `default` with its standing and **Use**. **Add a login** says the
new login starts on this device and joins the pool. The Mesh page names, on each host's line, the
login it holds ("Claude: {email}", "+N" for more) or "No Claude login", as a link that opens this
tab.

REST, reachable like the other settings routes: `GET /api/claude/accounts`,
`POST /api/claude/accounts/flow` (start), `POST /api/claude/accounts/flow/code` `{code}`,
`DELETE /api/claude/accounts/flow`, `PUT /api/claude/accounts/order` `{order}`,
`PATCH /api/claude/accounts/:id` `{enabled?, label?}`, `POST /api/claude/accounts/:id/clear` and
`DELETE /api/claude/accounts/:id`; while the mesh is on, also `PUT /api/claude/pool/keeper`
`{device}`, `PUT /api/claude/pool/order` `{order}`, `PATCH /api/claude/pool/:id` `{pin}` and
`POST /api/claude/pool/:id/return` (409 while the mesh is off), and `GET /api/claude/accounts`
carries the pool (`pool`). A malformed registry answers 409 to every change.

## §app.claude-logins/pool — One pool of logins across the mesh

While the mesh is on (§mesh.peers/off), the added Claude logins of every device form **one pool**.
A login (one refresh chain) is on exactly one device at a time: never copied to a second device
while it can run there. The pool is a document every device keeps and syncs over the peer
listener: each login's identity (email, account, organization, plan; never a token), label,
**Use**, pin, standing (limited until a time, or needs sign-in, as its last holder reported it),
the holder's latest usage reading, and its **holder**: the device that has its credentials and
whether that device uses it (**held**) or keeps it for lending (**free**). It also records the
pool's order and which device is the **keeper**. Each field merges on its own, the newest edit
winning, so edits made on two devices to different fields or logins both survive; the holder
merges by a counter that only the device that has the credentials advances, so every device
converges on the true holder. A login can be added from any device; it starts held by that device.

## §app.claude-logins/keeper — The keeper

One device, the **keeper**, stores the credentials of every free login and never runs `claude` on
them. The user chooses it in Settings → Accounts; by default it is the device that already had
logins when the pool was first formed (the desktop that runs Sova), else the first device that adds
one. When the keeper changes, the old keeper hands each free login it keeps to the new one, the same
way a login is returned. While the keeper is offline no device can borrow; devices that hold a login
keep working on it.

## §app.claude-logins/borrow-return — Borrowing and returning, safe across crashes

A device that needs Claude and holds no usable login **borrows** a free one from the keeper, with no
per-device setup: the keeper offers the first free login in the pool's order that is enabled, not
pinned to another device, not limited (its account's limit not yet reset) and not needing sign-in —
a login pinned to the asking device first — and the credentials travel host to host over the peer
listener only, never through a browser. The move is two-phase: the borrower stores the offered
credentials aside, unused, and only after the keeper confirms, having dropped and deleted its own
copy, does the borrower start using them. A device **returns** its login with its current
(possibly refreshed) credentials on a usage limit or a failed sign-in, when the user asks (after
the current turn), when it is pinned to another device, or when it has been idle for 30 minutes.
Before a login leaves a device, no new `claude` process there may take it and every running one
must stop (§app.claude-logins/drain); the device then sends it to the keeper and, once the keeper
has stored it, deletes its own copy as plain files — never `claude auth logout`. Each device keeps
a journal of every step it has started, so a crash or a lost reply at any step is finished or undone
when it restarts or the other device comes back: at no point can two devices run the same login,
and at no point is a login lost. A return the keeper cannot take yet (offline) waits, with the
login unused, and is retried when the keeper comes back.

## §app.claude-logins/drain — Every process on a login stops before it leaves

Every process that runs `claude` on an added login — a chat's child (in Sova or in a TUI), a
claude-code worker, model discovery, the topic summarizer — is tracked per login, with whether it
is in the middle of a turn. On Linux, a `claude` process that keeps no such record (one started
before this version, or by hand with `CLAUDE_CONFIG_DIR` set to the login's directory) is found by
that variable and counts as busy: its login is not lent, not returned for idleness, and at a cut it
is stopped too. When a login starts leaving a device, a chat's idle child on it is
stopped (its next turn starts on the device's next login, as after a model change), an idle worker
restarts on the next login with `--resume` of its own session, and a busy one does the same as soon
as its turn or task ends. A login leaves once none of them runs on it. If some still do after a
bound (2 minutes after a limit, a failed sign-in or idleness; 15 minutes when the user asked or a
pin moved it), their `claude` processes are stopped and each continues on the next login.
What a process that has exited left behind holds nothing: its record counts only while its owner
still renews it (at least once a minute) or, on Linux, through a `claude` process that still runs
on that login's directory — a process id since reused by anything else is neither counted nor
stopped.

## §app.claude-logins/idle-pin — Idle return and pinning

A held login that no `claude` process on its device has used for 30 minutes goes back to the
keeper. **Pin** ("always give this login to device X") is the only per-device setting: the keeper
lends a pinned login only to its device, that device takes it as soon as it is free and ready, a
device holding a login pinned elsewhere returns it after the current turn, and a pinned login is
never returned for idleness (a limit still returns it; its device takes it back after the reset).

## §app.claude-logins/stuck — A holder that went away

A login held by a device that is offline is shown **Stuck on** that device. Nobody reclaims it: it
becomes free again when that device comes back (and returns it), or when the user signs that login
in again on another device, which then holds it; the offline device, once back, deletes its old copy
(after stopping every process on it) instead of returning it.

## §app.claude-logins/migration — Forming the pool from existing logins

When the mesh is on and the pool first forms, every login already on a device stays there, held by
that device, in its order, and that device becomes the keeper if none is chosen. Nothing is signed
out, moved or deleted by forming the pool. With the mesh off there is no pool: the device is its own
keeper and holder, and every login on it is used as before (§app.claude-logins/spawn-selection).
