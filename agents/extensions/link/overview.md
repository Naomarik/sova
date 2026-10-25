---
watches: ["pi-config/extensions/link/**", "server/mesh/links.ts"]
alsoUpdate: ["pi-config/extensions/link/README.md"]
---
# link

The tools of a session Sova has linked with sessions on other mesh hosts (`link_members`, `link_send`, `link_inbox`,
and the file tools). Sova makes and ends links; this extension only lets a linked session use one. Every call goes
to the session's own Sova host.

## What lives here

- [`README.md`](../../../pi-config/extensions/link/README.md) (how a session gets the tools, the flags, the message
  format). Requirement: §mesh.links/tools.
- Tests: `cd pi-config/extensions/link && node --test client.test.ts && node tests/run.mjs`.

## What Sova relies on

- The link extension imports nothing from the server. It asks the server's `Symbol.for("sova:link-live")` hook,
  `(sessionId) => boolean`, whether a hosted session has joined a link, and turns the link tools on at its next
  request. `server/app.ts` installs the hook from `MeshLinks.inLiveLink` (`server/mesh/links.ts`): a live link this
  host keeps, not one still being made; false with the mesh off. Unset, as in the TUI or a worker, it never turns
  them on.
- The runtime flags Sova sets: `sova-link` (its own origin, on every runtime it hosts) and `sova-link-tools`
  (`member` for a link member the Overseer creates; `legacy` otherwise).

## When you change it, also update

- The flags, the hook's meaning or the message format: the README, and the server side in `server/mesh/links.ts`
  and `server/harness/pi/open.ts` in the same branch.
