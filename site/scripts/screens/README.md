# Screens and videos

The landing page's product screenshots and its two videos are real Sova, run on demo data. All
of that data, and every scripted model reply, is in one plain-JSON file: [`story.json`](story.json).
Everything else is generated from it on each run, in a throwaway directory, and never committed.

| File | What it is |
| --- | --- |
| `story.json` | The demo project, the sessions and their messages, the workers, the Overseer's turn, the shots, the videos' beats and captions. **The only file to edit.** |
| `story/files/` | Optional: demo-repo file bodies too long to read well inline (`{ "file": "story/files/x.ts" }`). |
| `story.schema.json` | Its schema. Editors that read `$schema` (VS Code and most others) give completion, hover docs and inline errors. |
| `check.mjs` | `pnpm run screens:check`: validates the story. |
| `capture.mjs` | `pnpm run screens`: the screenshots. |
| `record.mjs` | `pnpm run screens:video`: the videos (`--video desk` or `--video phone` for one). |
| `video-compose.mjs` | Assembly: the pointer, ripples, captions and the "sped up" tag drawn at 30 fps, the loop's fade, the AV1 and H.264 encodes. |
| `video-check.mjs` | The checks a video must pass before it replaces the one on the page (record.mjs and verify.mjs both run them). |
| `verify.mjs` | `pnpm run screens:verify`: outputs against the story, the videos' checks, build, budgets, sideways scroll. |
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
`script` (played live). A static session may also have `then`: steps the director plays live after
its messages, once a video sends the first of them (the phone video answers Upload metrics' open
question this way). A script is steps with exactly one action each: `user`, `say`, `read`,
`edit`, `write`, `bash`, `align`, `decide`, `worktree`, `spawn`, `wait`, `show_changes`, `tool`
(any other tool, such as the Overseer's), and `hold`. Every tool step becomes a real tool call that
Sova's own tools execute against the demo repository, so align cards, worktrees, worker
manifests and the changes viewer are the real thing. A `hold` before a reply keeps that reply
waiting mid-turn (live dots, a working worker, the Steer composer); before a user step it marks the
turn's end; between a `say` and a tool step it falls inside that reply, which streams its text whole
and then waits before the tool call (the video holds on what the agent found). Shots name the hold they're taken at, or `end`, or `start` for a static session and
the Access page. Each shot also names one of the story's `viewports` (CSS width and height, device
pixel scale, and `mobile` for a touch device): `desktop`, `compact` for a feature image, `fold`
for an unfolded foldable held landscape (816x616 at 3x, 4:3) and `phone` for its folded cover
screen (416x658 at 3x, portrait). Sova shows its two panes from 768px wide, so `fold` has the
sidebar beside the chat and `phone` the chat alone. The site's device frames take each image's own
shape.

The director recognizes a live session by its first message (the first user message that names a
scene: the Overseer's chat opens with a memory index the app writes) and a worker by its task, so
those must differ. `$session:<id>` anywhere in an argument, or inside a reply's text (an Overseer's
`sova://s/$session:<id>` link), becomes that session's id at run time. Workers are started with `wake: false`, and Delegate's routes all point at the story's
models on the pi backend.

## The videos

`videos.desk` is the hero loop (about 55 s, 1920x1200, filmed at 2304x1440 from a 1152x720 viewport
so the interface reads larger than on a 1440 desktop). `videos.phone` is the phone section's clip
(about 14 s, 832x1316, the phone viewport). Each is a list of beats, played in order:

| `do` | What happens |
| --- | --- |
| `type` | The pointer goes to the composer, clicks it, and types a user step (`step`; `scene: "overseer"` for the video's Overseer opener). |
| `click`, `tap` | The pointer goes to a `target` and presses it: `send`, `composer`, `link` (a reply's link, by `text`), `session-row` (`text`), `align-option` (`q`, `option`), `go-with-recommendations`, `workers`, `worker`, `close-panel`, `review-changes`, `changes-step` (`n`). A tap video (`pointer: "tap"`) draws a ring where the finger lands; an arrow video draws an arrow that travels. |
| `release` | The director plays on to a hold (`until`) or the scene's end, the pointer still. `speed: 3` plays that stretch 3 times faster and shows a "Sped up" tag. |
| `hold` | Still, while the viewer reads `read` (or for `for`). |
| `scroll` | The alignment card from its title (`align`), its answer row (`align-end`), or the end. |
| `home` | The last beat: the pointer goes back to where it started and the video fades into its first frame. |

`caption` on any beat starts a caption there (null ends it). `start` names the first screen,
`prefill` a user step already in its composer, `overseer` the video's own Overseer opener (on the
story's Overseer model), `slot` the still the page plays it over (same shape; its reduced-motion
picture), and `length` and `budget` what the finished files must meet.

**Pacing rules** (story-check.mjs `PACE`; `screens:check` lints the beats against them, and
`screens:verify` checks the recorded timeline):

- A reading hold lasts 1 s plus 0.3 s for each word of its `read` (the words that matter, not the
  fine print), at least 1.5 s and at most 5 s.
- The pointer never moves while a reply arrives, and anything new on screen (a page, a panel, a
  reply) gets at least 1.5 s before the pointer moves again.
- The pointer travels 0.5 to 0.9 s (by distance, eased), rests 0.3 s on its target, then a 0.35 s
  ripple, then 0.4 s still.
- Typing runs at about 30 characters a second; a typed prompt is at most 90 characters. Answers are
  clicked on screen; the story's user step is exactly the text that click sends
  (`src/lib/align-picks.ts`).
- A caption has at most 5 words and stays at least 2 s, fading in and out, low on the left, away
  from what the pointer presses.

**How it is made.** record.mjs plays the beats in the page (the app's own animations on; scrollbars,
spell-check marks, toasts and the Jump to Latest pill hidden) and films it with the CDP screencast,
which sends a frame only when the page changes. It logs every event as an anchor; between anchors
the video runs at the beat's nominal time (a hold its length, a travel its duration...), so a busy
machine can't stretch it; only a reply arriving keeps its real length. video-compose.mjs then makes
a constant 30 fps picture from the frames and draws the pointer, its ripples, the captions (in the
site's Inter, rendered by the browser) and the tag, and fades the end into the first frame, which
is also the poster (`src/assets/screens/video-<name>.webp`). It encodes AV1 (`*.av1.mp4`, the first
`<source>`) and H.264 (`*.mp4`, the fallback), each at the best quality within its budget.

**Checks before a video is written** (video-check.mjs, again in `screens:verify`): every frame of
both files decodes; enough distinct frames and no still stretch longer than any hold (not frozen);
the frame just before the fade matches the page's own screenshot along its bottom and right edges
(not cropped or offset); the shape, width, length and size are the story's; every hold met its
reading time, every caption its 2 s, every travel its range, and the pointer its 1.5 s after new
content; the leak gate passed at the start and after every beat. A video that fails leaves the old
one in place.

The Overseer's memory is turned off in the demo root (its summarizer would need a real login and
says so in a notice).

## Running

```sh
cd site
pnpm run screens:check                 # a second; no server, browser or model
pnpm run screens                       # shots whose inputs changed; --all for every one
pnpm run screens -- --shot hero-desk   # one shot
pnpm run screens:video                 # the videos, if their inputs changed; --force to re-record
pnpm run screens:video -- --video desk --force --stills /tmp/x   # one video, the page after every beat
pnpm run screens:verify                # before committing
```

They need the repository's root install and build (`pnpm install && pnpm run build` at the root):
the server, the pi workers and the align check come from there. The browser is the playwright
skill's (`.claude/skills/playwright/scripts`, its `node_modules` installed inside this worktree;
a link to another checkout is refused). Where its start-browser.sh can't run (it writes to `/tmp`,
which a sandbox may make read-only), the same Chromium is started directly with its profile in the
run's root; the videos always start their own, its window forced to 2x so the screencast films at
2x. The videos need `ffmpeg` on `PATH` with libsvtav1 and libx264. A sandbox with a long `TMPDIR`
can make the chat processes' socket paths too long (107 bytes): point `TMPDIR` at a short path
(such as `/dev/shm`) for the run. Nothing is added to
either `package.json`'s dependencies.

Each run makes a fresh `mktemp -d` root outside the repository: `HOME` is `<root>/home` (so paths
read `~/code/demo-app`), the agent dir is `<root>/home/.pi/agent` (the web app reads home from a
session file's path), built by `scripts/hermetic-agent-dir.mjs`,
and nothing is read from or written to the real `~/.pi`. No auth is copied in and no model is
called. The server and director use free ports. Everything started is stopped at the end, and the
root is removed unless `--keep`. `--no-browser` plays the live sessions over the REST API only and
checks every scripted tool call, for a machine where no browser starts. A failed shot leaves the
page as it was in `.agent/screens/debug/` (ignored by git).

Outputs, committed with the story: `site/src/assets/screens/*.webp` (lossless masters, dark theme
only; the site shows them in both of its themes), `site/src/assets/screens/manifest.json` (alt
text, sizes, slots, input and content hashes; generated, never edited), and
`site/public/video/session-{desk,phone}.{av1.mp4,mp4}` with their posters
`src/assets/screens/video-{desk,phone}.webp`. The pages read alt text and sizes from the manifest, so an
image and its words can't drift apart; `screens:verify` fails when the manifest, the files and the
story disagree.

## Privacy

The repository is public, so:

- The story is checked for absolute paths, email addresses outside `example.com`, IP addresses,
  `.ts.net` names, and this machine's user name, host name and home directory (read at run time,
  never stored).
- Before every screenshot and at every beat of the video, the leak gate reads the page's text,
  titles, labels, links and form values, and refuses the real home directory, user name, host
  name, the capture root's own path, any `.ts.net` name other than `example.ts.net`, any
  100.64.0.0/10 address, and the tailnet
  name `tailscale status` reports when it runs.
- The Access page's pairing response is mocked (`sova.example.ts.net`): the real one names this
  machine's tailnet.
