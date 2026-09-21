# 01 · App shell
> Part of the pi-web design spec · [overview](overview.md)

```
unfolded (≥768)                                  folded (<768)
┌──────────────┬───────────────────────────┐     ┌──────────────────┐
│ sidebar-head │ session-head              │     │ list  OR  session│
│ search       ├───────────────────────────┤     │ (data-view)      │
│ session list │ [error banner, sticky]    │     │                  │
│  (pane)      │ transcript (pane)         │     │                  │
│              ├───────────────────────────┤     │                  │
│              │ composer                  │     │                  │
└──────────────┴───────────────────────────┘     └──────────────────┘
```

```html
<a class="button skip-link" href="#transcript">Skip to Transcript</a>
<div class="app" data-view="list|session">
  <aside class="app-sidebar" aria-label="Sessions">…§2…</aside>
  <main class="app-main">…§3 head, transcript, composer…</main>
  <!-- ≥768 only; CSS hides it folded -->
  <div class="pane-resizer" role="separator" aria-orientation="vertical"
       aria-label="Resize the sessions pane" title="Drag to resize · Double-click to reset"></div>
</div>
<!-- Portals (render at the body, never inside a .pane): scrim + modal, .toast-stack, live region -->
```

- **Columns.** `.app` is `height: 100dvh`. At 768px and up the grid is `--sidebar-width` (320px)
  plus `1fr`, with a border between the columns. Below 768px it's one column, and `data-view`
  decides which one shows: `list` when no session is selected, `session` when one is. The shell
  is window chrome, so it uses `@media` rather than a container query, the same reasoning the
  skill gives for `.toast-stack`.
- **Scrolling.** The session list and the transcript each carry `.pane`, so each is an
  independent scroll region. The page itself never scrolls.
- **Routing.** Keep the selected session in the URL, e.g. `#/s/<encodeURIComponent(path)>`. That
  way reload and back work, and the folded back button is `history.back()` or a link to `#/`.
- **No rail and no bottom bar.** pi-web has one destination, so there's no nav to place. This is
  a deliberate departure from the skill's three-pane desktop shell: the ≥1120 `desktop` band adds
  nothing here.
- **Dialogs** follow the skill's modal pattern and become a bottom sheet under 768px
  automatically (`.modal` restyles itself).
- **Toasts** go in one `.toast-stack` portal. Use them only for "Copied path." / "Copied output."
  A toast is never the only record of a fact, so errors go in banners. One exception is the
  remote extension's connection notices (below): the chips hold the fact, so the toast is just the
  event.

## Remote session chips

A session on a remote target (spec/02 "Remote sessions") carries three facts, each shown in the
session head and in Session detail: **what it is** (the always-on remote chip), **where its files
are** (the mount state indicator), and **whether the host still answers** (the connection chip).
Each has its own word and its own section below; none borrows another's.

### The always-on remote chip

The identity of a remote session, and the one chip that does not wait for a report: it is built
from `SessionSummary.target`/`remoteCwd` (else a `cwd` under the placeholder), so it exists the
moment the session does — before any status arrives, and for a watched or TUI-owned session with
no chat socket at all. A local session has none.

- **What it says.** a `terminal` icon, the target's `label` from `GET /api/targets` (the name when
  that fails or the list hasn't loaded), `·`, then the path. A mount-mode session
  (`SessionSummary.mounted`) shows its own local mount cwd — where its files really are; every
  other remote session shows `remoteCwd`, the folder on the target. The target's `$HOME` isn't
  ours, so the path is never run through `~`.
- **It is identity, not liveness.** No state dot and no pulse — that is the connection chip's job,
  and the chips sit side by side so neither reads as the other. In the **session head** it is a
  plain `.chip`; in **Session detail** a `.chip.chip-count`. Either truncates the path rather than
  pushing the chip wide, and `title` carries the full `name (host):/remote/path`, the local mount
  location for a mount-mode session, and the mount state when one is known.

### The mount state indicator

Present for a mount-mode session no matter what, and for any other remote session only once the
target's live state says the mount is **up**: the server's `TargetInfo.mounted` (a bounded check,
refreshed by the mount toggle), else the extension's `status.mounted` for a chat here. The word is
the honest state: `mounted` only when that check says so, `not mounted` when a mount-mode
session's check says down, `mount` while nothing has been checked. Mounted is a **state**, not
health — neutral tone always: a mount whose reads fail must not read healthy, and a hung mount
can't be told from a slow one. In Session detail it also names the live mount point the extension
reported (`mounted · /home/user/.pi/agent/mounts/box`); in the head it is a plain `.chip` (it must
survive the narrow-head `.chip-count` rule, like the other two remote chips), with the mount point
and the session's mount location in `title`. It is never inferred from `mountPoint`'s presence,
which only means the target declares a mount, up or down.

### The mount toggle

In Session detail's controls row, beside **Check now** and **Reconnect**: it turns the target's
sshfs mount on and off. It is shown only when the target declares a mount — `TargetInfo.mounted`
is present (`true` up, `false` configured but down); absent means no mount config, no toggle. It
reads **Mount** or **Unmount** by that value, becomes **Mounting…** / **Unmounting…** while the
request is in flight, and disables then. It is a REST call
(`POST /api/targets/:name/mount {on}`), not a chat command, so it works for a watched or
TUI-owned session with no runtime here and one path serves the whole pane; the response is the
updated `TargetInfo`, which is what moves the indicator. A failure is a caption under the row
(`.text-caption.text-error`), never a toast-only: the fact stays on screen. The remote
extension's `/remote mount` / `/remote unmount` commands still exist as the TUI surface; pi-web
does not ride them.

### The connection chip

The connection chip is fed by the remote extension's `setStatus("remote-status", <JSON>)`, which
the chat socket delivers as a fire-and-forget `ui_request`
(`{state:"online"|"unreachable"|"unknown", host?, latencyMs?, pinned, channelState?, lastOkAt, runningMs?, error?, mounted, mountPoint?, at}`;
its plain `remote` status is TUI footer text and is ignored). `src/lib/remote-status.ts` parses it
(any other shape is ignored, never guessed at) and `src/components/RemoteStatus.tsx` renders it.
It says liveness only, never identity or mount state:

- **Only what the extension knows.** `connected` (success tone) means a real round trip
  succeeded **within the last 2 minutes**; an older success reads `last ok · 12m ago` with a
  neutral dot, so a stale reading is visibly old. A failure reads `unreachable` (error tone) with
  the failure's first line. Before the first report it reads `checking…` (neutral, never green),
  and after 30 s with no report at all, `no status`. While a command runs it reads `running 12s`
  (ticking locally between reports); it never says "hung" or "stuck", because a hung command and a
  slow one look the same from here. Ages are measured on the reporter's clock (`at`) plus the
  time since the report arrived, so a browser whose clock is off can't freshen them.
- **A rate-limited channel is not a lost host.** `channelState: "rate-limited"` means the host
  refused the fast channel's fresh ssh login (acme-prod allows about 6 per 30 s per source IP)
  while per-call ssh over the existing master still works. The word and the dot stay driven by
  `lastOkAt` (`connected` if recent), never red. The channel gets its own line:
  `rate-limited (ssh refused) · retry in 12s`, counted down on the 1 s clock from
  `channelRetryAt` (on the reporter's clock, like the ages), then `retry on next call` once it has
  passed or when no time was given. The pane shows it as a muted caption under the chip
  (`Fast channel rate-limited (ssh refused) · retry in 12s`); the head chip's `title` carries the
  same line.
- **In the session head**, after the always-on remote chip and the mount state indicator, a `.chip`
  button just before the `TUI` chip: state word, `·`, host (`user@hostname` once the extension's
  preflight answered; the host keeps its case inside the uppercase chip). Compact: no age, except
  on `last ok 12m ago`, where the age is the point. `title` carries latency, whether the fast
  channel is pinned and its state, and the last success's age and time. Clicking it opens Session
  detail on the Session tab, where the controls are. It is a plain uppercase chip, not
  `.chip-count`, so the narrow head's `.chip-count` rule never hides it. **Absent for local
  sessions**, and for a remote session not open for chat here (a watched or TUI-owned one): pi-web
  only hears the status over its own chat socket, and a chip it can't feed would be a claim. (The
  always-on remote chip above has no such limit — it needs no report.)
- **In Session detail** (every tab), in the controls row under the pane's head, after the remote chip
  and the mount state indicator: the same chip as `.chip.chip-count` (host keeps its case) plus the
  age of the last success (`· 42s ago`, `· ok 5m ago`, `· never ok`) or the running time; the
  failure's first line under it in `.text-caption.text-error`; and the small ghost buttons. **Check
  now** (`/remote check`, one fresh round trip) and **Reconnect** (`/remote reconnect`, drop the
  fast channel and re-probe) are sent as ordinary prompts over the chat socket (the server runs
  extension commands at once, even mid-turn) with no "Ran" row, and are shown only while the
  runtime advertises the `remote` command; while one waits it reads `Checking…` / `Reconnecting…`
  and both disable, until the next report lands or 20 s pass. The **mount toggle** sits with them
  but is not a chat command (above): it works with no runtime here.
- **Connection notices.** A `notify` from the extension starting with `remote:` (first loss of a
  host, recovery) is a connection event: its first line becomes a normal non-modal toast, and the
  same text isn't repeated within a minute, so a flapping host never stacks toasts.
- **Lifetime.** The status lives while the chat is open in this tab and goes with it: nothing
  reports after the socket closes, so nothing is shown. setStatus isn't replayed on `hello`, and a
  runtime that outlived its last socket has no session start to report on, so after each `hello`
  the `commands` message that follows (if it lists `remote`) triggers one silent `/remote status`:
  the extension re-publishes its current status, with no ssh and no toast. Until it lands, the
  connection chip reads `checking…` (the always-on remote chip never waits).

## The open-failure banner

A webapp-owned chat the server refuses to open answers the chat socket with `error` code `config`
and closes it (4422): the stored working directory is gone, or its mount can't be read, and no
reconnect can fix that by itself. The banner is one `.banner.banner-error` in the transcript's
`.transcript-banner` slot (spec/03 "Anatomy"), and every word comes from
`src/lib/open-failure.ts` — a pure function of the session summary, the server's error text, and,
when a targets list is at hand, its labels (the error itself proves the target declares a mount).
It names the concrete thing that's wrong, never a bare "can't be opened":

- **A declared mount that isn't up** — the cwd is inside a target's `mount.local` and the mount
  table has no entry there (the server's reason is `no mount at {point}`). Title "This session
  can't be opened: {label}'s mount is down." The body names the target, the remote folder, and
  the mount point, and says that mounting is what fixes it: "…mounting {label} again brings the
  folder back, and the session opens as it was."
- **A mount that can't be read** (hung, unreadable, the target no longer configured): the mount
  module's reason verbatim in the body. No Mount button — the mount is already up, and mounting
  again can't fix a read that fails.
- **A folder gone through an up mount** (the reason says `no such directory through the mount`):
  the mount is up, but the folder isn't there on the target anymore. No Mount button, for the
  same reason.
- **A stored folder that doesn't exist** — a plain local folder, or a remote session's local
  placeholder (named as a placeholder, with the target and its remote folder beside it). The
  same reassurance every time: nothing in the session file changed; restore the folder, then
  reconnect. A local session never mentions mounts at all.
- **Anything else**: the server's text verbatim under the same title.

The actions row is a `.cluster` in the banner's action slot, the first action solid and the rest
ghost:

- **Mount and reconnect** — only for the mount-down case. While the request
  (`POST /api/targets/:name/mount {on:true}`) is in flight it reads **Mounting…** and disables.
  On success it reconnects the chat socket: the server clears its memoized open failure as soon
  as the mount answers, so the session opens. On failure the banner stays, and the mount module's
  real reason ("Mount failed: acme-prod: ssh: connect to host … Connection refused") is a
  `.text-caption.text-error` caption beside the actions — the same rule as the mount toggle's
  caption: never a toast-only, the fact stays on screen.
- **Reconnect** — a plain retry, for the cases where the folder came back on its own.
- **Archive** — the Session pane's Archive gesture on the same endpoint
  (`POST /api/sessions/archive {path, archived:true}`), with the same toast and list refresh, then
  a route to the landing page (`#/`, the back link's href): the session on screen can't be opened,
  so the gesture leaves it. It moves the session to the Archive region — nothing is deleted, and
  unarchiving brings it back; the button's `title` says so. Absent when the summary says the
  session is already archived or wasn't started in pi-web, exactly like the pane's button.

## Resizing the sessions pane

The divider between the two columns is draggable. `.pane-resizer` is a child of `.app` (the
sidebar is `overflow: hidden` and would clip it), absolutely positioned — which is why `.app`
takes `position: relative` from 768px up — and it writes `--sidebar-width` on
`document.documentElement`.

- **An invisible 12px hit strip.** `left: var(--sidebar-width)` with `margin-left: -6px`, so it
  straddles `.app-sidebar`'s `border-right` evenly, top to bottom. **Nothing is drawn at rest**:
  the sidebar's own 1px border is already the divider, and a second mark for a control nobody is
  touching is clutter. On `:hover`, and for as long as `html.is-resizing` is set, a 1px
  `--color-accent` hairline lights up down the centre of the strip, over `--dur-fast`. 12px is
  under the 44px touch minimum on purpose: it is an edge, the edge has no other target within
  44px in either direction, and every pixel it grows is a pixel stolen from a list row's
  target.
- **Unfolded only.** `display: none` below 768px. Folded is a single full-width column with no
  divider and nothing to divide, so there is no handle to find.
- **The drag.** Pointer events with pointer capture, mouse and touch alike; `touch-action: none`
  on the strip keeps a touch drag from scrolling the page. While a drag is live the root carries
  `is-resizing`, and `html.is-resizing, html.is-resizing *` force `cursor: col-resize` and
  `user-select: none` — the pointer leaves the 12px strip on the first move, so the cursor and
  the selection guard have to hold across the transcript it runs over.
- **Clamp.** `240 … min(560, viewport − 440 − the Subagents pane)`. 440 is `--main-min`, the
  transcript's floor; the Subagents term is its real width **only while it is a static third
  column** (≥1280px), because below that it overlays the main pane and reserves nothing. The
  clamp is re-applied on `resize` and `orientationchange`, so shrinking the window pulls an
  over-wide pane back rather than squeezing the transcript out.
- **Default 320px on every load, and nothing is persisted.** This is a decision, not an
  omission: a width is a posture for the task in front of you, not a preference, and a
  remembered one is a setting you have to notice and undo. Double-clicking the handle resets to
  320 for the same reason — the way back is always one gesture.
- **One knob, three consumers.** `--sidebar-width` feeds the `.app` grid's first column, the
  Subagents pane's `width: min(--subagents-width, 100% − --sidebar-width − --space-8)`, and
  `--measure`'s `clamp(72ch, 100vw − --sidebar-width − …, 110ch)` (§3 "Column width"). So
  dragging the pane reflows the transcript's line length **live**, under the pointer, and the
  reading column is never quietly wrong about how much room it has.
- **No keyboard path, and that is an accepted gap.** The handle has no `tabindex`, so it is not
  reachable by Tab, and it carries no `aria-valuenow`/`valuemin`/`valuemax` — the `role="separator"`
  is there to name the thing, not to make it a slider. **A keyboard-only user cannot resize the
  sessions pane at all.** It is a layout preference with no content behind it: everything the
  pane holds is fully readable at the 320px default, every row truncates rather than hides, and
  no fact is reachable only by widening. Nothing is lost but the adjustment itself. The right
  fix, if this is revisited, is `tabindex="0"` plus arrow keys and the three `aria-value*`
  attributes; until then this is written down rather than unnoticed.

---

