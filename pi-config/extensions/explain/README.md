# /explain for Pi

`/explain <topic>` researches a topic in **one forked subagent** and leaves a
self-contained HTML page behind. The parent conversation pays nothing for the
research: the child works in a copy of the session, and the parent only records
the result.

```text
/explain how our worker hosting survives a reload
→ Explaining "…" in a subagent (forked, web search on). It lands in
  ~/.pi/agent/explanations/how-our-worker-hosting-survives-a-relo-mfq2p1/ and is announced here.
…
→ ~/.pi/agent/explanations/how-our-worker-hosting-survives-a-relo-mfq2p1/index.html — viewable in Sova.
```

Installed globally through this symlink:

```text
~/.pi/agent/extensions/explain -> ~/pi-config/extensions/explain
```

`install.sh` links every `extensions/*/` directory, so nothing extension-specific
is needed. Run `/reload` to pick up changes. The command works in the TUI and in
Sova's embedded runtimes (extension commands appear in the web composer's slash
menu on their own).

**Nothing here ever opens a browser.** The page is read in Sova — a thread row,
the per-session strip, the gallery — or by opening the file yourself. A background
worker throwing a window at you is exactly what this avoids.

## What the child is told

`prompt.ts` adapts the audience, structure, and style rules of the Claude Code
`/explain` command: written for someone with 15 years of shipping software and no
CS degree, no 101, mechanism over definition, diagrams that draw the actual flow,
tables for comparisons, the tradeoff named out loud, and length that follows the
topic. Two things differ: the page goes to the store below instead of a temp file,
and the child is told never to open a browser.

The child gets `read`, `grep`, `find`, `ls`, `bash`, `write` and `edit`, plus web
search/fetch **only** when `pi-web-access` is already installed in
`~/.pi/agent/npm/node_modules` — "trivially available", never an install on the
critical path of a slash command. The only other extension it loads — first, on
top of `--no-extensions`, exactly like every subagents pi worker — is the subagents
worker marker, `../subagents/worker-mark.ts`: at its own session_start the child
writes one `subagents-worker-session` custom entry into its session, and Sova
keeps sessions carrying it out of its Recent list. Nothing else of the subagents
extension comes along, so it cannot spawn workers of its own.

## The store (kept forever)

```text
~/.pi/agent/explanations/<id>/index.html
~/.pi/agent/explanations/<id>/meta.json
```

`<id>` is `<topic slug>-<base36 timestamp>`, matches `[A-Za-z0-9_-]+`, and is the
directory name, so it is safe in a URL path segment. The root follows
`$PI_AGENT_DIR` / `$PI_CODING_AGENT_DIR` when they are set.

`index.html` is one self-contained file with **zero external requests**: no CDN,
no webfonts, no remote images. It ships
`<meta name="viewport" content="width=device-width, initial-scale=1">`, defaults
to `prefers-color-scheme` but honors `?theme=dark` / `?theme=light` through an
inline script that runs in `<head>` before first paint, keeps every `<svg>` on
`viewBox` + `max-width: 100%` + `height: auto`, and every `pre` on
`overflow-x: auto`. It is meant to be readable on a phone with nothing else
loaded.

Directly under the page's `<h1>` sits a small muted byline — `Explained by
zai/glm-5.3 · Sep 20, 2026`. The parent injects the model and the date into the
child's prompt as literals, so the child stamps them rather than guessing its own
model id. It lives in the header, not a footer, because that is where a reader of
the full page (desktop or phone) sees it — and the title block is kept inside the
first ~200px so it also lands high in Sova's scaled thumbnail, which conveys
layout rather than text. The model is delivered legibly by the gallery's own tile
caption, not by the byline inside the thumbnail.

The theme script is the **only** script on the page, and it may only override
colours. Sova's gallery renders the stored file in an `<iframe sandbox="">`,
which runs no JavaScript at all and may refuse external subresources outright, so
`@media (prefers-color-scheme: dark)` has to produce a correct page on its own and
nothing may depend on a script running. Images are inline `<svg>` or `data:` URIs.
The page also ships `<meta name="color-scheme" content="dark light">`, so an
embedder that declares a colour scheme gets matching scrollbars and controls with
no script involved — but `?theme=` itself cannot be honoured inside a fully
sandboxed iframe, where the page falls back to the viewer's colour scheme.

`meta.json`:

```json
{
  "id": "vector-clocks-mfq2p1",
  "topic": "vector clocks",
  "summary": "Three to five sentences: what the page covers and its sharpest takeaway.",
  "parentSessionId": "01JB…",
  "cwd": "/home/you/src/app",
  "createdAt": "2026-09-20T10:00:00.000Z",
  "model": "zai/glm-5.3"
}
```

Only `summary` is the child's: 3–5 sentences of plain prose, no markdown — it is
clamped to three lines in the gallery card, and the parent truncates at 1200
characters as a backstop, not as a design. Every
other field is the parent's and is rewritten by the parent after the run, so a
child that mistypes its own session id or model cannot poison the store.

## What the parent records

The **parent process** — not the child — appends two custom entries to the parent
session per run, with the same `id`. As soon as the child is spawned (a refused
spawn records nothing), a running entry, so the row is visible for the whole run:

```json
{ "type": "custom", "customType": "explain-doc",
  "data": { "id": "…", "topic": "…", "summary": "", "createdAt": "…", "parentSessionId": "…", "model": "…", "status": "running" } }
```

When the child settles, it validates the store and appends the final entry, which
supersedes the running one:

```json
{ "type": "custom", "customType": "explain-doc",
  "data": { "id": "…", "topic": "…", "summary": "…", "createdAt": "…", "parentSessionId": "…", "model": "…" } }
```

`status` is exactly `"running"` or absent: a final entry never carries it (there
is no `"done"`), so every entry written before the field existed is already a
final one. The TUI renders a running entry as `[explaining] <topic> — working…`.

A run that went wrong carries exactly one of two extra fields, and they mean
different things to whoever renders the entry:

| Field | Meaning | Is there a page? |
| --- | --- | --- |
| `error` | Fatal: the child wrote no usable `index.html` | No — do not link or iframe it |
| `note` | Advisory: the page is complete, but the run errored or was aborted afterwards | Yes — it opens normally, treat it as possibly unfinished |

`model` is always present: the model that actually produced the page, the same
one stamped in its byline.

A clean run carries neither, and no run ever carries both. The failed topic stays
visible either way instead of silently missing. Single writer, on purpose:
the child owns a *copy* of the session, so only the parent can append to the real
one. This mirrors how the `mode` extension records its align docs.

A missing or empty `index.html` is the only fatal outcome, and in that case any
`meta.json` the child left behind is deleted: the web app lists an explanation on
the strength of its meta, so a meta with no page would surface a card that 404s.
The parent writes `meta.json` only after validating the page, and writes it
atomically (temp file + rename), so **meta present ⇒ the page is servable** holds
even against a torn write. A missing, corrupt or wrong `meta.json` is rewritten
from what the parent knows; contract slips that
are not fatal (external *subresources* — a citation `<a href>` fetches nothing
and is not flagged, no viewport tag, no `?theme=`
handling, no `prefers-color-scheme` fallback, more than one script, an `<svg>`
without `viewBox`) are reported as a notification and the explanation is still
recorded.

Then the parent agent is woken with a short `explain-complete` custom message and
told to answer in at most two sentences: the store path, and that it is viewable
in Sova.

That message is `display: false` deliberately. Its text is addressed to the agent
("reply in at most two sentences…"), and a displayed custom message renders as a
transcript row in pi and Sova alike — which put our own prompt plumbing on
screen between the explanation card and the agent's reply. Custom messages
participate in LLM context regardless of `display`, so the wake is unaffected,
and the user still sees the `explain-doc` entry and the answer.

## Limits

- At most 3 explanations run at once; each one is a whole pi process.
- A brand-new session has no conversation to fork: either no file on disk yet,
  or a file that is only pi's header line (its first input was `/explain`). The
  parent forks only a file holding at least one `"type":"message"` line;
  otherwise the child starts fresh and works from the topic and the working
  directory. Everything else is identical.
- Session shutdown or `/reload` stops live children and records no final entry,
  so the running entry is the last one for that id. Their store directories
  stay; an unfinished one simply has no page in it.

## Source

| File | What it owns |
| --- | --- |
| `store.ts` | The on-disk contract: ids, paths, `meta.json`, validation and repair, the session-entry shape |
| `prompt.ts` | The child's instructions |
| `worker.ts` | The forked child, hosted through `../subagents/runner.ts` |
| `explain.ts` | Run lifecycle: start, record running, settle, validate, record final, wake |
| `identity.ts` | Which session is the parent, and which file the child forks |
| `index.ts` | Pi wiring only: the command, the entry renderer, shutdown |

`worker.ts` imports the subagents extension's `SubagentRunner` **as a class**: it
already owns the exact argv this needs (`--fork`, `--no-extensions`, tool
restriction, `-e <worker marker>` then `-e <installed package>`), the RPC handshake, the settle/outcome
distinction, and the abort → SIGTERM → SIGKILL teardown. No manager, no registry,
no `agent_*` tools: these children never appear in `/agents`, and this extension
stops its own.

## Verification

Offline regression tests (no model requests, no real pi process):

```sh
node tests/run.mjs
```

Real pi extension loading, still without a model request:

```sh
node tests/smoke.mjs
```

Opt-in live test — **this one really does spend model calls**. It drives a whole
`/explain` from a throwaway persisted session in a temp directory (never an
existing session) and leaves the page in the real store:

```sh
node tests/live.mjs                                     # topic "exponential backoff"
node tests/live.mjs --model zai/glm-5.2 --topic "CRDTs"
node tests/live.mjs --keep-session                      # also copy the parent JSONL out of the temp dir
```

`--keep-session` copies the throwaway session file to
`~/explain-live-session-<id>.jsonl` before the temp directory is removed, so the
appended `explain-doc` entry can be inspected against a real session rather than
a fixture.

It seeds one tiny turn first, on purpose: a slash command persists nothing by
itself, so without history there is no session file to fork and the run would
silently exercise the unforked path instead.

The harness resolves the globally installed pi packages through jiti;
`PI_PACKAGE_DIR` overrides the installation it uses.
