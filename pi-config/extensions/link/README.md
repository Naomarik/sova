# link

The tools of a session **linked** with sessions on other Sova mesh hosts: a remote team whose
members message each other and hand each other files. Sova makes and ends links (its Overseer's
`sova_link` / `sova_unlink`); this extension only lets a linked session use one.

| Tool | Params | Does |
| --- | --- | --- |
| `link_members` | `{}` | The links this session is in; per partner its host, session id, title, cwd, model and backend, whether its host is up, and whether it is working or idle |
| `link_send` | `{text, to?, link?}` | Deliver a message. `to`: a partner as `link_members` names it (`host/session id`), or by host label, session id or title; a list, or `"all"`; optional with one partner. `link`: only when the session is in more than one link. Per partner: `started`, `delivered`, held for an offline host, or `refused` with the reason |
| `link_inbox` | `{limit?}` | This session's link messages, both directions, newest last |
| `link_offer` | `{paths, to?, dest?, exclude?, note?, link?}` | Offer files or directories. `paths` resolve against the session's cwd (`~/…` and absolute allowed); each travels under its own name, so two with the same name are refused. `dest` is a **directory** on the partner's host: each path lands at `dest/<its name>` (like `cp -r a b dest/`), parents are created, existing files are overwritten, nothing is renamed. Relative is under the partner's cwd, `~` its home; a string for every partner or an object by partner (keys as `to` names them). With `dest` the partner's host pulls at once with no turn and wakes its agent once when the files land; without it the partner's agent gets the offer as a link message and answers. No default excludes (`exclude`: a pattern without `/` matches any path component, with `/` from the offered name); symlinks travel as links; a git worktree's `.git` pointer is warned about. The result: what was listed (files, bytes) and each partner's answer (`accepted` into a resolved dest, `offered` to its agent, held for an offline host, or `refused`) |
| `link_accept` | `{offer, dest}` | Take an offer (`of_…`) into a directory on this host, same `dest` rule; the host pulls it and the session gets one message when it lands or fails |
| `link_decline` | `{offer, reason?}` | Turn an offer down; the sender is told |
| `link_offers` | `{}` | This session's offers, both directions, newest first: roots, files and bytes, note, warnings, and per recipient its state (offered, accepted, pulling with bytes so far, extracting, done, declined, failed, expired, cancelled, refused), dest and reason |

## How it works

- **Only in a link member session, fixed schema.** Sova's Overseer creates a session as a link
  member (`sova_create_session` with `link: true`); Sova then hands its runtime the
  `sova-link-tools` flag `member`, and the seven tools are registered at `session_start` (pi applies
  flag values only after every extension has loaded), so they are there from its first request.
  Every other session has none, so it pays nothing for them. The set never changes because a link
  is made or ended, so a claude-code session (which reaches them as `mcp__sova__link_*`) never sees
  its tool set change mid-conversation. Each refuses with a sentence when the session is in no link.
- **Sessions from before.** Every other session Sova hosts gets `legacy`: it registers the tools
  only when its transcript already declares them (a session an earlier build hosted, when every
  session had them), unchanged, and withdraws them at its next compaction, which rebuilds the
  prompt cache anyway (a claude-code CLI restarts after one). A compaction while the session is in
  a live link, or whose host doesn't answer, keeps them for a later one. Once withdrawn (re-registered
  `hidden`, the one way pi takes a tool back) they never come back.
- **Enabled by Sova only.** Sova sets the `sova-link` flag to its own origin on every runtime it
  hosts. Without it (a TUI, a subagent worker) no link tool is registered and nothing is fetched.
- **Talks only to its own host.** Every call goes to that origin's `/api/mesh/links/*` routes
  (`client.ts`), naming the session by id. The host checks that it holds the session and that the
  session is a member, and does every peer hop, the outbox for offline hosts and delivery. The
  extension knows nothing about the mesh, and no file bytes pass through it: the sender's host
  packs the paths once, each recipient's host pulls them (resumable) and extracts them, and the
  sender's session gets one message when every recipient is final or at the first failure. An
  offer without `dest` to a partner open in a TUI is refused; ending a link cancels its open
  offers; an unanswered offer expires after 24 h. With the sandbox on, the host refuses what the
  session's own tools could not read (sender) or write (receiver).
- **Offers and landings** arrive as ordinary link messages (the same first line), naming the
  offer id.
- **A partner's message** arrives as a user message whose first line is
  `[link_msg <link id> <message id>] from <title> (<host>/<session id>)`. Sova hides it from the
  main transcript and shows it in the Agents tab.
- **The prompt section** (`mesh-link`) is added to each run while the session is linked. It names
  the link ids and each partner's title, host label and session id, and no live state (up/down,
  working/idle), plus one fixed sentence about the file tools. It is rebuilt only when the set of
  live link ids changes, so it changes only when a link is made or ended: a changed system prompt restarts a claude-code session's CLI. The links
  are read from the host at each run start without peer hops (`brief=1`). A run start the host
  doesn't answer keeps the previous section. Any answer from the host (no links, no link routes)
  drops it.

Files: `index.ts` (flags, tools and when they are registered, section), `client.ts` (builtins only: the HTTP client, the
structural copies of the route bodies, and the pure rendering the model reads).

## Verify

```sh
cd pi-config/extensions/link
node --test client.test.ts   # client, errors, rendering (offers too), section stability
node tests/run.mjs           # index.ts against a fake pi and a fake host
```

Neither makes a model request or starts a server. `tests/run.mjs` resolves the globally installed
pi package (override with `PI_PACKAGE_DIR`).
