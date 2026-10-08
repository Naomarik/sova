# Screens and video

The landing page's product screenshots and its session video are real Sova, run on demo data. All
of that data, and every scripted model reply, is in one plain-JSON file: [`story.json`](story.json).
Everything else is generated from it on each run, in a throwaway directory, and never committed.

| File | What it is |
| --- | --- |
| `story.json` | The demo project, the sessions and their messages, the workers, the Overseer's turn, the shots, the video's beats. **The only file to edit.** |
| `story/files/` | Optional: demo-repo file bodies too long to read well inline (`{ "file": "story/files/x.ts" }`). |
| `story.schema.json` | Its schema. Editors that read `$schema` (VS Code and most others) give completion, hover docs and inline errors. |
| `check.mjs` | `pnpm run screens:check`: validates the story. |
| `capture.mjs` | `pnpm run screens`: the screenshots. |
| `record.mjs` | `pnpm run screens:video`: the video. |
| `verify.mjs` | `pnpm run screens:verify`: outputs against the story, build, budgets, sideways scroll. |
| `director.mjs` | The scripted model: an OpenAI-compatible endpoint that answers with the story's replies. |
| `seed.mjs`, `harness.mjs`, `hashes.mjs`, `load-story.mjs`, `story-check.mjs`, `json-pos.mjs` | What the commands share. |

## Editing the story

Plain JSON, with three conveniences:

- **Text is a string or an array of lines.** Every text field (`user`, `say`, file bodies, an edit's
  `old` and `new`, a worker's `task`) takes either; an array is joined with line breaks.
- **`"note"`** on any object is a comment. Nothing reads it, and changing one retakes nothing.
- **`pnpm run screens:check`** names every problem as `story.json:LINE:COL /pointer: message`:
  a syntax error, a duplicate key (which `JSON.parse` would silently drop), an unknown key (with a
  did-you-mean), a reference to a session, worker, hold or shot that doesn't exist, an edit whose
  `old` text isn't in the file at that point (with the closest line), a change no `show_changes`
  step covers, an alignment the align tool itself would refuse, and anything private (below).
  `--format` prints the story in its canonical layout; the check never rewrites the file.

A session has `messages` (finished: written to disk before Sova starts, for the sidebar) or a
`script` (played live). A script is steps with exactly one action each: `user`, `say`, `read`,
`edit`, `write`, `bash`, `align`, `decide`, `worktree`, `spawn`, `wait`, `show_changes`, `tool`
(any other tool, such as the Overseer's), and `hold`. Every tool step becomes a real tool call that
Sova's own tools execute against the demo repository, so align cards, worktrees, worker
manifests and the changes viewer are the real thing. A `hold` before a reply keeps that reply
waiting mid-turn (live dots, a working worker, the Steer composer); before a user step it marks the
turn's end. Shots name the hold they're taken at, or `end`, or `start` for a static session and
the Access page.

The director recognizes a live session by its first message and a worker by its task, so those
must differ. Workers are started with `wake: false`, and Delegate's routes all point at the story's
models on the pi backend.

## Running

```sh
cd site
pnpm run screens:check                 # a second; no server, browser or model
pnpm run screens                       # shots whose inputs changed; --all for every one
pnpm run screens -- --shot hero-desk   # one shot
pnpm run screens:video                 # the video, if its inputs changed; --force to re-record
pnpm run screens:verify                # before committing
```

They need the repository's root install and build (`pnpm install && pnpm run build` at the root):
the server, the pi workers and the align check come from there. The browser is the playwright
skill's (`.claude/skills/playwright/scripts`, its `node_modules` installed inside this worktree;
a link to another checkout is refused). The video needs `ffmpeg` on `PATH`. Nothing is added to
either `package.json`'s dependencies.

Each run makes a fresh `mktemp -d` root outside the repository: `HOME` is `<root>/home` (so paths
read `~/code/demo-app`), the agent dir is `<root>/agent`, built by `scripts/hermetic-agent-dir.mjs`,
and nothing is read from or written to the real `~/.pi`. No auth is copied in and no model is
called. The server and director use free ports. Everything started is stopped at the end, and the
root is removed unless `--keep`. `--no-browser` plays the live sessions over the REST API only and
checks every scripted tool call, for a machine where no browser starts. A failed shot leaves the
page as it was in `.agent/screens/debug/` (ignored by git).

Outputs, committed with the story: `site/src/assets/screens/*.webp` (lossless masters, dark theme
only; the site shows them in both of its themes), `site/src/assets/screens/manifest.json` (alt
text, sizes, slots, input and content hashes; generated, never edited), and
`site/public/video/session-desk.mp4`. The pages read alt text and sizes from the manifest, so an
image and its words can't drift apart; `screens:verify` fails when the manifest, the files and the
story disagree.

## Privacy

The repository is public, so:

- The story is checked for absolute paths, email addresses outside `example.com`, IP addresses,
  `.ts.net` names, and this machine's user name, host name and home directory (read at run time,
  never stored).
- Before every screenshot and at every beat of the video, the leak gate reads the page's text,
  titles, labels, links and form values, and refuses the real home directory, user name, host
  name, any `.ts.net` name other than `example.ts.net`, any 100.64.0.0/10 address, and the tailnet
  name `tailscale status` reports when it runs.
- The Access page's pairing response is mocked (`sova.example.ts.net`): the real one names this
  machine's tailnet.
