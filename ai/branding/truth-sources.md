# Truth sources

> Part of [Sova branding](overview.md). Read before claiming that Sova does something.

Sova has more documents than most projects its size: a UX spec, a design skill, extension
READMEs, a wishlist, research notes, and this folder. They are not equally true. Some describe
code that runs. Some describe code that is planned, half-built, or was removed. A writer who treats
them all as fact will ship a README that lies.

## The ladder

From strongest to weakest evidence that a feature exists:

1. **Code at a named revision.** A route in `server/index.ts`, a component in `src/components/`,
   a message type in `shared/protocol.ts`, all as of a commit you can name. This is proof.
2. **A test that exercises it**, at that revision. Strong, and it tells you the intended edges.
3. **The README at that revision.** Usually right, because it's maintained, but it has described
   working-tree features before they were committed. Check it against 1.
4. **`spec/*.md`.** A design contract. Written before the code, and sometimes for code that never
   came. A spec section is *what it should be*, not *what it is*. Treat it as a plan until 1 confirms.
5. **`pi-config/extensions/*/README.md`.** Accurate for the extension itself, but the extension
   running in the TUI doesn't mean Sova surfaces it.
6. **`WISHLIST.md`, `docs/`, `notes/`, `CODEFOLD-PROPOSALS.md`.** Ideas and research. Never cite
   as shipped.
7. **This folder.** Describes how to talk, not what runs. Cites the above; proves nothing.

"Spec alone is not proof" cuts both ways. Don't assume a specced feature is unshipped either.
Most of the spec is implemented. Go and look.

## How to verify

Pick the revision you're writing against and say it. Then check the code, not the prose.

```sh
git rev-parse --short HEAD                     # the revision you'll cite
git show HEAD:server/index.ts | grep -oE 'app\.(get|post|put|delete|patch)\("[^"]+' | sort -u
git show HEAD:shared/protocol.ts | grep -oE 'type: "[a-z_:-]+"' | sort -u
git ls-files src/components | sort           # what's committed, not what's on disk
git status --short                             # what's on disk but not committed
```

The last line matters in this repo. Several agents edit the tree at once, and untracked files are
routinely a feature that exists in the working tree and not at HEAD. On 2026-09-22 at `d3a6963`,
for example, `src/lib/typography.ts` and `server/fork.ts` were on disk and untracked: the font
picker and session forking were real in the tree and absent from the commit. Cite the commit,
or say "in the working tree on <date>" and mean it.

Then, for anything the user can see, open it. `pnpm run dev:server` and `pnpm run dev:web` from
`README.md`, or the app already running, and look at the screen. A route that exists and a
screen that renders are two different facts.

## Writing a verified claim

State the fact, the revision, and where you looked. Keep the revision out of the sentence a
reader skims and put it in a note, a table column, or a footer.

> The session list groups rows by folder and shows the sessions open in a TUI at the top.
> *(verified 2026-09-22 at `d3a6963`: `server/sessions-index.ts`, `src/components/Sidebar.tsx`)*

For something in the spec you haven't confirmed in code:

> The spec describes a Timeline tab (`spec/13-timeline.md`). Not verified in code for this note.

Never write "supports", "includes", or "lets you" about the second kind.

## What counts as shipped

A feature is shipped when, at the revision you name, the server route or socket message exists,
the frontend renders it, and it works against a real `~/.pi/agent`. Two of three is "in progress".
One of three is "specced". Zero is "wished".

## Where the surfaces are

For orientation, not as a feature list. Each row names where to look, at whatever revision you
are on.

| Surface | Look in |
|---|---|
| REST routes | `server/index.ts` |
| Socket messages, both directions | `shared/protocol.ts`, `server/ws.ts` |
| What the sidebar shows | `server/sessions-index.ts`, `src/components/Sidebar.tsx` |
| Transcript rendering | `server/transcript.ts`, `src/components/Thread.tsx` |
| Chat in web-owned sessions | `server/chat-manager.ts`, `src/components/ChatView.tsx` |
| Live watch of TUI sessions | `server/watch.ts`, `server/live.ts`, `src/components/WatchView.tsx` |
| Themes and typography | `shared/theme.ts`, `server/themes.ts`, `themes/*.json`, `src/lib/theme.ts` |
| Groups, workspaces, fanout | `server/session-groups.ts`, `server/fanout.ts`, `src/components/GroupView.tsx` |
| Insights, usage, agents | `server/insights.ts`, `src/components/InsightsPage.tsx` |
| Settings and model policy | `server/web-settings.ts`, `server/model-policy.ts`, `src/components/SettingsDialog.tsx` |
| Remote targets | `server/targets.ts`, `pi-config/extensions/remote/` |
| Extensions Sova depends on | `pi-config/extensions/*/README.md` |

Don't turn this into a feature matrix. A table of every feature with a tick goes stale the week
it's written, and a stale tick is worse than no table.
