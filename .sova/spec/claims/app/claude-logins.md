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
the implicit login `default`. It is always present, never moved, and never written by any of
this. With no other login added, everything behaves as before: every `claude` process runs on
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
`.claude.json` (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`), and never stored.

A login's directory is `<agent dir>/claude-accounts/<id>/`, mode 0700, derived from the id and
never stored. Inside it, `projects/`, `settings.json`, `CLAUDE.md`, `agents/`, `commands/`,
`skills/` and `plugins/` are symlinks to the same names in `default`'s directory (each one only
when it exists there; `projects/` always, created there if missing). So every login writes its
Claude session records into the one shared `projects/`: `--resume` after a switch finds the
session, and every transcript and usage reader keeps reading one place. The links are repaired
whenever a login is used.

**Devices.** A login is assigned to at most one device (`device`), and each device has its own
ordered list of logins (`devices[<device id>].order`, which may include `default`, and
`defaultEnabled`). This host's device id is `SOVA_DEVICE_ID` when set, else its mesh id (`self.id`
in `<agent dir>/sova/peers.json`) when it has one, else `local`; a login assigned to `local`
belongs to this host, and a device entry kept under `local` moves to the mesh id at the next change. Only logins
assigned to this host are ever used here. A login this host has no order entry for comes after the
ordered ones, in the order they were added; `default` comes first unless the order places it.

## §app.claude-logins/add-remove — Adding and removing a login

Settings → Accounts → **Add login** starts `claude auth login --claudeai` for a new login
directory, with no terminal: its standard input is a pipe, `BROWSER` does nothing, and the
variables that would override a login (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`) are removed. The dialog shows the authorize URL Claude Code prints
(to open in any browser, on any device) and a field for the code the page shows afterwards. The
code is written to the process as one line; a code Claude Code refuses as malformed ("Invalid
code") keeps the flow waiting for another. Once Claude Code exits successfully and the directory
holds `.credentials.json`, the login is added to the registry, assigned to this host,
appended to its order, enabled, and shown with its email, organization and plan. A flow that
fails, is cancelled, or is left alone for 10 minutes kills the process and deletes the new
directory; nothing is added. At most one flow runs at a time.

A login whose account (`accountUuid`) is already present is still added; the panel says it
shares that account's usage limits, so it only helps when the other login's sign-in fails.

**Remove** asks first, then runs `claude auth logout` in the login's directory (bounded; its
failure does not stop the removal), deletes the directory, and drops the login from the registry
and from every device's order. `default` cannot be removed.

## §app.claude-logins/device-order — This device's order, and which logins it may use

Settings → Accounts lists this host's logins in its order, `default` included, each with its
label or email, organization and plan; a login that shares its account with another row says so,
and that the two share usage limits. Each row can move up or down, be switched off or on (**Use**,
`enabled`; off = never chosen automatically), and be removed (not `default`). A row shows the
login's standing on this host as a chip: **Ready**, **Off**, **Limited until** a time (`resetsAt`),
**Sign in again**, or **Not signed in** (its directory holds no credentials). A limited or
sign-in-again row has **Clear**, which forgets that standing. Every change is saved at once.

## §app.claude-logins/spawn-selection — Every `claude` process runs on one login

Every `claude` process Sova or its extensions start runs on exactly one login, by setting
`CLAUDE_CONFIG_DIR` to that login's directory (or leaving the environment as it was, for
`default`): the Claude Code chat provider's child for a session, claude-code workers (including a
worker's detached host), model discovery (the extension's and the server's), the server's
`claude --version` check, and the topic-outline summarizer.

The login is **this host's first usable login in its order**: enabled, assigned here, and neither
limited nor needing sign-in. A chat session records the login its child runs on in a hidden
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
login of the same account):

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
- **TUI.** The usage-status footer shows the Claude usage of the session's login (its newest
  `claude-login` entry): an added login's own reading from `claudeAccounts`, else Claude Code's
  own. Its `/usage` screen lists Claude Code's own login and then each added one, each titled
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

REST, reachable like the other settings routes: `GET /api/claude/accounts`,
`POST /api/claude/accounts/flow` (start), `POST /api/claude/accounts/flow/code` `{code}`,
`DELETE /api/claude/accounts/flow`, `PUT /api/claude/accounts/order` `{order}`,
`PATCH /api/claude/accounts/:id` `{enabled?, label?}`, `POST /api/claude/accounts/:id/clear` and
`DELETE /api/claude/accounts/:id`. A malformed registry answers 409 to every change.
