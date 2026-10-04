# §app/claude-logins — Several Claude logins, with failover
> Part of the Sova design spec · [overview](../design/overview.md)

A host can hold more than one Claude subscription login, so that a session or a worker that hits
a usage limit, or whose sign-in stops working, moves on to another login instead of stopping.
The unit is a **login**: one Claude Code config directory with its own `.credentials.json`, that
is, one refresh chain. Several logins may belong to the same Claude account (the same
`accountUuid`); they are kept, and listed together under that account. Claude Code stays the only
program that signs in, refreshes and signs out: Sova runs `claude` in the login's directory and
never writes a token itself. It reads one only to launch a sandboxed Claude Code worker, and then
only the login's short-lived access token, never its refresh token (§chat.sandbox/claude-state).
On macOS, Claude Code keeps a login's credentials in the login keychain rather than in that file;
there a login is its directory plus its keychain item, and Sova reads the item wherever it would
read the file (§app.claude-logins/macos-keychain).

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

**Accounts, then logins.** Every order — a device's, and the pool's (§app.claude-logins/pool) —
keeps the logins of one account (the same `accountUuid`) together: each account sits where its
first login falls, and its logins follow in their order; a login with no known account is an
account of its own. An order saved or merged that splits an account is read that way, so every
reader (selection, failover, lending, both pages) sees one order: accounts first, then the logins
inside each. After a failed sign-in, the next login tried is therefore the same account's next one.

**Names.** A login's name is its `label`; without one it is "Login N", N being its place among
its account's logins by when they were added (the oldest is "Login 1"); `default` is "Claude
Code's own login". A label is at most 80 characters; an empty one is removed.

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

With the mesh off, Settings → Accounts lists this host's added logins in its order as **one block
per account** (§app.claude-logins/registry, **Accounts, then logins**): the block's head names the
account (its email, else "Unknown account"), its organization and plan, and, with more than one
login, "{n} logins share one quota"; its **Up** / **Down** move the whole account. Inside, each
login is a compact row: its name (§app.claude-logins/registry, **Names**) and "added {date}",
its standing chip, and its controls; with more than one login in the account, its own **Up** /
**Down** move it inside the account only. The name is renamed in place: **Rename** turns it into a
field with **Save Name** and **Cancel**; Enter or **Save Name** saves it as the login's `label`
(`PATCH /api/claude/accounts/:id` `{label}`), Escape or **Cancel** leaves it (and Settings stays
open), and an empty name goes back to "Login N". A login's controls are named with its account
("Rename Login 1 of a@example.com"), so two accounts' "Login 1" never share a name. A login can be
switched off or on (**Use**, `enabled`; off = never chosen automatically) and removed. Its standing on this host is a chip: **Ready**, **Off**, **Limited until** a time
(`resetsAt`), **Sign in again**, or **Not signed in** (its directory holds no credentials; on
macOS, neither a `.credentials.json` nor a keychain item, so a login whose sign-in Claude Code
keeps in the keychain reads as signed in, and a **Sign in again** clears once Claude Code rewrites
that item, §app.claude-logins/macos-keychain). A
limited or sign-in-again login has **Clear**, which forgets that standing. Under the blocks,
**This device's own login** lists `default` (always last) with its email, organization and plan,
its standing, **Use** and **Clear**, and, when its account is also one of the blocks, that it shares
that account's quota. Every change is saved at once.

## §app.claude-logins/spawn-selection — Every `claude` process runs on one login

Every `claude` process Sova or its extensions start runs on exactly one login, by setting
`CLAUDE_CONFIG_DIR` to that login's directory (or, for `default`, leaving the environment as it
was, less an inherited `CLAUDE_CONFIG_DIR` that names an added login's directory): the Claude Code chat provider's child for a session, claude-code workers (including a
worker's detached host), model discovery (the extension's and the server's), the server's
`claude --version` check, and the topic-outline summarizer. A sandboxed Claude Code worker
(§chat.sandbox/claude-state) is launched the same way, so its process as the host sees it
carries its login's directory, while the `claude` inside the sandbox runs on the worker's
private config directory with that login's access token.

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
  fail over. A worker confined by the sandbox (§chat.sandbox/claude-state) treats its first auth
  failure on a login differently: nothing is recorded, its transcript gets `Claude: {login}
  refused the worker's token; refreshing it and resuming on the same login`, and it resumes on
  that login with a refreshed token. Only a second auth failure there, with no successful task in
  between, fails over as above.

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
  device with more than one login to choose from (more than one in its order or, with the mesh
  on, any other login in the pool), a quiet `.composer-login` sits right after the
  model indicator: the login's email (else its label or id), in caption size and muted ink,
  ellipsized at 26 characters; on a phone width only the part before the `@`, at most 12. It is a
  button (`aria-haspopup="menu"`, `aria-expanded`) that opens the flyout's login panel
  (§app.claude-logins/switch-login); in a chat that can't be written it is `aria-disabled`, like
  the model indicator. Its `title` says
  "This chat runs on this Claude login: {label ·} {email} · {plan}. Order and standing: Settings →
  Accounts." — or, before the chat recorded one, "This chat starts on this Claude login (first
  ready on this device): …"; its `aria-label` is "Claude login: {email}". While a pick waits it
  shows that pick instead (§app.claude-logins/switch-queue). With a single login, or
  on another provider's model, nothing is shown.
- **Wire.** `/ws/chat` sends `{type: "claude_login", login}` (`ChatClaudeLogin`: `id`, `name`,
  `email?`, `planLabel?`, `recorded`, `several`, `pending?` — the waiting pick's `id` and `name` —
  or `null` when the registry can't name one) after
  every hello, only on a device with several logins (a hello clears the last one), and whenever a
  `claude-login` entry is appended or the waiting pick changes, so a failover moves the indicator in
  the same turn. A switch still shows its note row.
- **TUI.** The usage-status footer shows the Claude usage of the session's login: its newest
  `claude-login` entry, else — before the session's first Claude turn — the login this device
  would start it on now (its first usable login, as above; Claude Code's own only when the
  registry can't be read). An added login's reading is its own entry in `claudeAccounts`;
  `default`'s is the cache's `claude`.
- **Usage readouts.** The sidebar foot's usage glance and the Usage page's summary lead read the
  same login for the chat on screen (§app.insights/sidebar-foot). Its `/usage` screen lists Claude Code's own login and then each added one, each titled
  "Claude · {email}" with its plan.

## §app.claude-logins/switch-login — Switching a chat's login from the composer

In a web chat on a Claude Code model, the composer's login label (§app.claude-logins/active-login)
opens the **login** panel of the composer flyout (§chat.composer/composer-flyout), which moves the
chat to another Claude login at any time.

- **What it lists.** Every login this device knows of, one group per account as Settings →
  Accounts lists them (§app.claude-logins/device-order): the group's label is the account's email
  (else "Unknown account"), and each row is a `menuitemradio` named like the login
  (§app.claude-logins/registry, **Names**). This device's own login (`default`, "Claude Code's own
  login") comes last, in its own group "This device". The chat's login is checked. A row can be
  picked when its login is enabled and ready (not limited, not needing sign-in, signed in) and
  either held here (not leaving) or, with the mesh on, free at the keeper while the keeper is
  online; a free one's row says "Borrow". Every other row is `aria-disabled` and says why, in this
  order of precedence: "On {device}" (held by another device), "Stuck on {device}", "Pinned to
  {device}", "Keeper offline", "Leaving this device", "Off", "Not signed in", "Sign in again",
  "Limited until {time}".
- **A pick.** The chat moves to that login now: its idle Claude Code process stops, and its next
  turn starts one on the picked login the way a model change restarts it (the history folded into
  one message, so that turn has no prompt cache). The session gets a `claude-login` entry with
  `reason: "manual"`, `from`, `fromLabel` and the text `Claude: switched {from} → {to} (chosen by
  you)`; the chat shows it as a note row and the label moves at once. A chat that has no Claude
  process yet only records the pick, and its first turn starts there. Nothing pins the chat: from
  then on the usual rules hold. It keeps that login across restarts while the login is usable, and
  a limit or a failed sign-in moves it on in the device's order (§app.claude-logins/failover); it
  does not come back by itself. Picking the chat's own login changes nothing, and the flyout closes
  on a pick.
- **Borrowing.** With the mesh on, picking a free login asks this device's pool agent to borrow
  that login by name (`only` in the borrow request), and the keeper lends that one or none
  (§app.claude-logins/borrow-return). The label shows the pick as waiting until the login is held
  here, up to 30 seconds. If it can't be borrowed, the chat stays where it was and the transcript's
  banner says why. The login the chat left stays on this device until it is returned as usual
  (§app.claude-logins/idle-pin).
- **Workers.** A switch moves the chat only: its running workers keep their logins, and new ones
  start on the device's order as before.
- **Where.** The web only; a terminal session has no picker. `/ws/chat` takes `{type:
  "set_claude_login", login}` (`login`: a login id, or `null` to cancel a waiting pick), and the
  server calls the claude-code extension's `/claude-login` command handler directly, the way the web
  mode switch calls `/mode`. It is refused, with the reason in the banner, for a chat another
  writer has or that is open in a terminal, a chat not on a Claude Code model, and a runtime
  without the extension's command.

## §app.claude-logins/switch-queue — A pick while a reply runs

While the chat's reply runs (or a compaction), a pick waits for it. The login panel marks the
picked row with a live dot and "After this reply", and its first row reads "Switching to {name}
after this reply", followed by **Cancel switch**, which drops the pick. The composer's login label
shows the picked login's name after a live dot instead of the current one, and its `title` reads
"Switching to {name} after this reply. Open to cancel." Picking another login replaces the waiting
pick; picking the chat's current login cancels it. A message sent while the reply runs goes into
that reply as usual, on the login it runs on. When the reply ends, the pick is applied before the
next turn starts: anything still waiting in the chat's queue then waits until the switch has landed
(or failed), then goes as usual. A pick whose login can't be used by then is dropped and the banner
says why. The waiting pick is kept by the server, so every tab on the chat shows it and can cancel
it; a server restart drops it.

## §app.claude-logins/switch-cost — What a switch resends

Once the chat has a reply, the login panel ends with a muted note, "Switching resends ~{n} tokens
without cache": `n` is the chat's context fill as the head shows it (§chat.context-window/last-reply,
in §chat.context-window/format). Its `title` says "An estimate from the last reply's context. The
restart folds the history into one message, which the new login reads uncached." After a
compaction, until the next reply, the note reads "Switching resends this chat without cache", with
no number. A chat with no reply shows no note.

## §app.claude-logins/accounts-tab — Settings → Accounts

A tab in Settings, **Accounts**, between Models and Modes. Its **Claude Logins** section says that
every Claude process on this device (its mesh name, or "This device") runs on the first ready
login in the order, then lists the logins by account (§app.claude-logins/device-order); Remove asks inline
what goes away and what stays. Under the list, **Add a login** (§app.claude-logins/add-remove) is
a panel with four states: starting ("Starting Claude Code's sign-in…"); waiting for the code (the
URL as a link with **Copy Link**, a **Code** field, **Finish Sign-In** and **Cancel**, and the
reason when Claude Code refused a code); done (**Added**, the new login's email, organization and
plan, whether it shares an account already here, and **Done**); failed (the reason, "Nothing was
added.", **Close** and **Try Again**). Closing Settings cancels a flow still waiting for its code.
No token or credential is ever shown or sent to the browser.
Under the logins, one plain line says whether the Claude Code CLI was found
(§app.claude-logins/cli-status). On macOS a login counts as signed in when its keychain item
exists (§app.claude-logins/macos-keychain), so **Add a login** finishes there too; and when this
device's own login can be read neither from its file nor from the keychain, a muted line under
**This device's own login** says "On macOS, add your Claude login under Settings → Accounts."

**While the mesh is on** the section is the pool (§app.claude-logins/pool): an intro that every
device shares these logins, one at a time, borrowed from the keeper and given back after a limit,
on request or after 30 minutes idle, with Claude Code's own login as each device's last resort; a
**Keeper** select (every device, this one marked, an offline one marked; a hint that says what the
keeper does, or that nobody can borrow while it is offline); then every login of the pool in the
pool's order, as one block per account like the mesh-off list (§app.claude-logins/device-order):
the head with the account's email, organization, plan, "{n} logins share one quota" and the
account's latest published usage ("5h 42% · weekly 18%", its logins sharing one quota), and **Up**
/ **Down** for the whole account; each login a compact row with its name and "added {date}" (renamed
in place the same way; the label is the pool's, so every device shows it and the device holding the
login writes it into its registry), a move under way ("Leaving this device (hit its limit):
waiting for its Claude processes to finish", "Returning after the current turn", …), a holder chip
(**This device**, the holding device's name, **Free**, or **Stuck on** a device) and its standing
chip, and the controls: a pin select (**No pin** / **Pin to** each device), **Return** (a held login
not already leaving), **Sign In Again** (stuck, or needing sign-in), Up / Down inside its account
(with more than one login), **Use**, **Clear** and **Remove** (which says it leaves the pool on
every device). Under it,
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
The pool's order keeps each account's logins together (§app.claude-logins/registry). A device
follows the document for the logins it holds: their label, **Use** and order (the pool's order)
are written into its registry when they differ, so a rename, a switch or a move made on any device
reaches the spawns and the chats of the device that runs the login.

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
a login pinned to the asking device first; a borrow that names one login (a pick in the composer,
§app.claude-logins/switch-login) is offered that login or none — and the credentials travel host to host over the peer
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
(after stopping every process on it) instead of returning it. On macOS that sign-in runs in the
login's own directory, since Claude Code names the keychain item it writes by that directory, so
a cancelled or failed sign-in leaves the directory as it was (§app.claude-logins/macos-keychain).

## §app.claude-logins/migration — Forming the pool from existing logins

When the mesh is on and the pool first forms, every login already on a device stays there, held by
that device, in its order, and that device becomes the keeper if none is chosen. Nothing is signed
out, moved or deleted by forming the pool. With the mesh off there is no pool: the device is its own
keeper and holder, and every login on it is used as before (§app.claude-logins/spawn-selection).

## §app.claude-logins/cli-status — Is the Claude Code CLI here

Settings → Accounts ends with one muted status line about the Claude Code CLI, read when the tab
opens (`GET /api/settings/claude-status`: `claude --version` on this host's first usable login,
and how many `claude-code-cli` models the server's runtime holds). It says, first match wins:
"Checking for the Claude Code CLI…" while it asks; "Claude Code CLI: {reason}" when the CLI could
not be run (not installed, no answer within 5 s, a failed `--version`); "Claude Code CLI {version}
· {n} model(s) in the picker." when models are registered; else "Claude Code CLI {version} found,
but no models are registered yet — start a session, or restart the server." It is a line, not a
control: nothing to switch, and nothing else on the tab waits for it.

## §app.claude-logins/macos-keychain — Claude logins in the macOS keychain

On macOS, Claude Code keeps a login's credentials in the login keychain, not in its directory's
`.credentials.json`: a generic password under the user's name holding the same JSON
(`claudeAiOauth`). Its service is `Claude Code-credentials` for Claude Code's own `~/.claude` run
without `$CLAUDE_CONFIG_DIR`, and `Claude Code-credentials-<h>` for a directory Claude Code runs with
`$CLAUDE_CONFIG_DIR` (an added login's `claude-accounts/<id>/`, or `default`'s own
`$CLAUDE_CONFIG_DIR`), `<h>` being the first 8 hex digits of the SHA-256 of that exact path. So when
this host is macOS, `HOME` is the user's own home (a test's throwaway home never reaches the
user's keychain), `$CLAUDE_SECURESTORAGE_CONFIG_DIR` is unset (it renames every item), and a
login's directory holds no `.credentials.json`, Sova reads that login's item instead, for every
login on this device, `default` and added ones alike:

- **Whether it is signed in** — Settings → Accounts' **Not signed in**, the check that finishes
  **Add a login** or **Sign In Again**, a spawn's refusal of a login that isn't signed in, and
  whether a login needing sign-in has been signed in again since (its credentials changed) — comes
  from the item's modification time, read from its attributes only (`security
  find-generic-password -s <service> -a <user>`, without `-w`): the secret is never read for it,
  and it works while the keychain is locked. That answer is kept at most 2 seconds. Removing a
  login signs it out through Claude Code (`claude auth logout`) when either the file or the item exists.
- **Its usage and sign-in data** (§app.insights/usage-refresh): the usage fetch reads the item
  (`security find-generic-password … -w`) again for every fetch, so a token Claude Code renewed
  (it rewrites the item) is sent at once; the Usage page's sign-in numbers (expiry times, never a
  renewal time, since the item has no file time) come from one read kept at most 30 seconds per login.
- **A sandboxed worker's token** (§chat.sandbox/claude-state): the access token handed to a
  confined worker is read from the item at every launch, and the unconfined refresh run before it
  starts Claude Code's own login without `$CLAUDE_CONFIG_DIR`, so that it renews the same item.

A token read never prompts and gives up after 5 seconds; a failure of any kind (no item, a locked
keychain, as in an ssh session, a timeout, unparsable JSON) is quiet and leaves what a missing file
leaves: `nologin`, no `auth`, no token to hand over. The item's text lives only in memory for the
one read: it is never written to disk, logged or sent to the browser; only the access token is
used, and the sign-in data keeps only numbers. Sova never writes the item. A file present, even
unreadable, decides alone, as before. No other platform ever runs `security`: elsewhere everything
is as before, byte for byte.

When this host is macOS and `default`'s login can be read neither from the file nor from the
keychain, `GET /api/insights/usage` and `GET /api/claude/accounts` carry `claudeOwnLoginUnreadable:
true` (absent otherwise), and the Usage page (under its lead line) and Settings → Accounts (under
**This device's own login**) each show one muted hint: "On macOS, add your Claude login under
Settings → Accounts." On every other platform neither field nor hint ever appears.

**The pool can't move a keychain login.** The pool (§app.claude-logins/pool) moves a login between
devices as its credentials file and never reads or writes the keychain for it. So a login this Mac
holds whose credentials are only in its keychain (no file, an item) **stays on this Mac**: it is
never returned, lent or kept free — not after a limit or a failed sign-in, not after 30 minutes
idle, not when **Return** is asked or it is pinned to another device, not for a new keeper — and
a move already under way for it is called off, leaving it held and used here (its limit or sign-in
standing still keeps it unused until that clears). It is never deleted for having no file. While
the mesh is on, Settings → Accounts shows it on this Mac with "Stays on this Mac: its sign-in is in
the macOS keychain, which the pool can't move." in place of **Return** and the pin select. Other
devices are not told: the pool still shows it held by this Mac, and a **Return** asked there is
never carried out. Removing it from the pool, or another device signing it in again, still drops
it here as before.
