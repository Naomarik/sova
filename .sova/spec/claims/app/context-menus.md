# §app/context-menus — Shared declarations, one menu mechanism

This is a new claim for Sova's context menus, not a rewrite: before this draft, the
implementation's `§app/context-menus` citations had no current claim in the repository.

Sova's context menus use one declaration-and-body mechanism. The surfaces that offer one and the
places an extension may declare are specified separately; this claim governs the shared body.

- **One declaration, one body.** Each menu declares its accessible name and its ordered table
  of sections and rows. Its pointer doors (§app.context-menus/doors) draw that same declaration
  into one page-level panel, mounted once, rather than a hidden panel for every row.
- **Sections and reasons.** Sections keep their declared order and an empty section draws nothing.
  A row that cannot run stays visible with its reason carried by the row before it is pressed; a
  disabled row is never a silent grey-out. Menu rows use the shared menu-row primitive
  (§design/menu-rows).
- **Built-ins first, extensions last.** Sova's own features and extensions use the same menu
  places, following the reply-place pattern. Sova's built-in rows come first in their sections;
  extension rows follow every built-in row in their own titled groups. Extension content is data
  Sova draws as ordinary rows, never extension markup.

## §app.context-menus/doors — Pointer doors, no button or keyboard gesture

These menus have exactly 2 doors: a right-click with a mouse on the place, and a finger or pen's
stationary 500ms hold (§app.context-menus/touch). Both doors draw the same declaration. No `⋯`
button or other visible trigger offers these menus.

Sova has no keyboard context-menu gesture. Shift+F10 and the Menu key never open any of these
menus, and Sova does not intercept their browser behavior or dispatch a substitute context-menu
event to the focused element.

A transcript message itself has no Sova context menu on either pointer door. Pointer input on its
words is left to the browser. Its own action buttons keep Copy and Share, Rewind on your messages,
and Regenerate and Fork on replies (§chat.transcript/message-actions).

## §app.context-menus/touch — A stationary finger or pen hold

On a row, title or pane that has one of these menus, a finger or pen press held without moving for
500ms opens the same menu as a right-click. On a draggable row, if that held press then moves, it
becomes the row's drag instead and does not also open the menu. A session row uses its existing
lift and drop overlay (§app.session-list/drop-overlay): releasing its stationary hold opens the
row's actions, while moving the lifted row drags it.

When the pressed row or title is itself a link, this hold opens Sova's menu rather than the
browser's link menu, and does not follow the link. A text field, an open popover or a live text
selection keeps the browser's own menu; Sova's hold does not replace it. A hold on a transcript
message's words is likewise left to the browser's ordinary text selection, with no Sova menu.

This promises Sova's response to finger and pen input, not an identical native link callout or
selection presentation in every phone browser.

## §app.context-menus/places — The four extension menu places

A menu place is exactly one of `session`, `group`, `pane` or `worktree`. An extension declares an
entry for one with `"menu": "<place>"` on a command in its manifest. The served contract is
`ext-contract-v1.22`; it admits these 4 values and no others. Each place has one declaration
joining its built-in table to its extension lane, and the shared body draws both.

A menu row that invokes a catalogue-backed server action names that command and its parameters,
so it uses the command's existing catalogue entry and route with the surface's own follow-ups. A
menu never grows a parallel request for an action the surface already has. Browser-only acts and
a reply's existing local acts stay local.

## §app.context-menus/pane — Membership without Archive

A workspace pane's menu offers no Archive row, whatever the member's origin or state. Taking the
member out of the workspace is the separate Remove From Group action: it removes the session from
the group and leaves the user in the workspace, without archiving or deleting the session.

## §app.context-menus/refusals — One blocked action, one sentence

The same action refused for the same blocking condition explains itself with the same one-sentence
wording on every surface. In particular, the session menu and Archive drag/drop surface do not
word an archive refusal differently. A disabled menu row carries that sentence before the press.

## §app.context-menus/worktree-removal — Removal asks inside the menu

A coding-worktree row's Remove Worktree… opens its removal flow inside the same menu, replacing
the menu's rows rather than opening a question under the row. The ordinary question keeps Remove
Worktree and Cancel.

The flow keeps the existing dry run and leftovers warning. When what the worktree holds keeps it,
the menu offers Remove Anyway; that step shows the same exact listing inside the menu and keeps
Delete and Remove Worktree as its destructive choice, with Back. The confirmed-listing and removal
rules remain §app.project-overseer/coding-worktrees and §chat.worktrees/leftovers's, unchanged.
