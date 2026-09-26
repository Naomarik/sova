# link

The tools of a session **linked** with sessions on other Sova mesh hosts: a remote team whose
members message each other. Sova makes and ends links (its Overseer's `sova_link` /
`sova_unlink`); this extension only lets a linked session use one.

| Tool | Params | Does |
| --- | --- | --- |
| `link_members` | `{}` | The links this session is in; per partner its host, session id, title, cwd, model and backend, whether its host is up, and whether it is working or idle |
| `link_send` | `{text, to?, link?}` | Deliver a message. `to`: a partner by host label, session id or title, a list, or `"all"`; optional with one partner. `link`: only when the session is in more than one link. Per partner: `started`, `delivered`, held for an offline host, or `refused` with the reason |
| `link_inbox` | `{limit?}` | This session's link messages, both directions, newest last |

## How it works

- **Always registered, fixed schema.** The three tools load in every session, linked or not, so a
  claude-code session (which reaches them as `mcp__sova__link_*`) never sees its tool set change
  mid-conversation. Each refuses with a sentence when the session is in no link.
- **Enabled by Sova only.** Sova sets the `sova-link` flag to its own origin on every runtime it
  hosts. Without it (a TUI, a subagent worker) the tools refuse and nothing is fetched.
- **Talks only to its own host.** Every call goes to that origin's `/api/mesh/links/*` routes
  (`client.ts`), naming the session by id. The host checks that it holds the session and that the
  session is a member, and does every peer hop, the outbox for offline hosts and delivery. The
  extension knows nothing about the mesh.
- **A partner's message** arrives as a user message whose first line is
  `[link_msg <link id> <message id>] from <title> (<host>/<session id>)`. Sova hides it from the
  main transcript and shows it in the Agents tab.
- **The prompt section** (`mesh-link`) is added to each run while the session is linked. It names
  the link ids and each partner's title, host label and session id, and no live state (up/down,
  working/idle). It is rebuilt only when the set of live link ids changes, so it changes only when
  a link is made or ended: a changed system prompt restarts a claude-code session's CLI. The links
  are read from the host at each run start without peer hops (`brief=1`). A run start the host
  doesn't answer keeps the previous section. Any answer from the host (no links, no link routes)
  drops it.

Files: `index.ts` (flag, tools, section), `client.ts` (builtins only: the HTTP client, the
structural copies of the route bodies, and the pure rendering the model reads).

## Verify

```sh
cd pi-config/extensions/link
node --test client.test.ts   # client, errors, rendering, section stability
node tests/run.mjs           # index.ts against a fake pi and a fake host
```

Neither makes a model request or starts a server. `tests/run.mjs` resolves the globally installed
pi package (override with `PI_PACKAGE_DIR`).
