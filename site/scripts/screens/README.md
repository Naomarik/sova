# Screens and videos

The landing page's product screenshots and its hero video are real Sova, run on demo data. All
of that data, and every scripted model reply, is in one plain-JSON file: [`story.json`](story.json).
Everything else is generated from it on each run, in a throwaway directory, and never committed.

| File | What it is |
| --- | --- |
| `story.json` | The demo project, the sessions and their messages, the workers, the Overseer's turn, the shots, the video's beats and captions. **The only file to edit.** |
| `story/files/` | Optional: demo-repo file bodies too long to read well inline (`{ "file": "story/files/x.ts" }`). |
| `story.schema.json` | Its schema. Editors that read `$schema` (VS Code and most others) give completion, hover docs and inline errors. |
| `check.mjs` | `pnpm run screens:check`: validates the story. |
| `capture.mjs` | `pnpm run screens`: the screenshots. |
| `record.mjs` | `pnpm run screens:video`: the story's `videos` (only `desk`, the hero, today; `--video <name>` for one). |
| `video-compose.mjs` | Assembly: the pointer and its ripples drawn at 30 fps, the loop's fade, the AV1 and H.264 encodes. Nothing else goes into the picture. |
| `video-check.mjs` | The checks a video must pass before it replaces the one on the page (record.mjs and verify.mjs both run them), and the page's caption cues (`cuesOf`, `cueProblems`). |
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
its messages, once a video (or the capture) sends the first of them. The hero session, Retry
backoff, is one: its history is on disk, 3 hours old, and the video carries on from its open
alignment card. A static session's file also carries its `modes` (the mode extension's own
markers), so turning them on for the run adds no switch to its Timeline; Upload metrics is in
align mode that way, so the phone still shows its card's answer row. A script is steps with exactly one action each: `user`,
`say`, `read`, `edit`, `write`, `bash`, `align`, `decide`, `worktree`, `spawn`, `wait`,
`show_changes`, `tool` (any other tool, such as the Overseer's), `hold`, and `summary`.

A `summary` step is the session's summary at that point (`now`, `overall`, and `topics`, each with
a `heading` and 1 to 3 bullets; `update: "t2"` replaces an earlier topic): what the Current goal
strip shows and the Timeline draws as chapters. In a static session's messages it is written into
the file as Sova's summarizer would have (a topic starts at the user step its `from` names). In a
live script or `then` it is what the director answers when Sova's summarizer next asks: the
story's `summarizer` model is the only one in the run's `topic-outline.json`, and the director
recognizes its request by the session's first message and gives each topic a share of the new
messages. A reply's ```` ```vis ```` drawing is parsed with the app's own parser
(`src/vis/parse.ts`, run by Bun) by `screens:check`, so a typo fails there. Every tool step becomes a real tool call that
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

Each model names its `provider` (`anthropic`, `zai`, `deepseek`, `openai`; the story's own
`provider`, the default for a model that names none, is `anthropic`): the run's
`models.json` registers every one at the director, so the real provider and model names show on
screen while nothing leaves the machine and no subscription is used. The page's footer says the
names are real, the replies are scripted, and Sova isn't affiliated with the model makers.
Only the story's models may show: today Claude Opus 5.5 (anthropic, `claude-opus-5-5`), zai
`glm-5.3`, openai `gpt-6.1-sol` and deepseek `deepseek-v4.1-flash`. The leak gate (below) refuses
any other model or provider name on the page, and each run prints the model names it saw.

## The videos

`videos.desk` is the hero loop, and the only video (about 60 s, 1920x1200, filmed at 2560x1600 from a 1280x800 viewport:
the interface reads larger than on a 1440 desktop, and 1280 is Sova's breakpoint from which the
session detail pane sits beside the chat instead of covering it). Its storyboard, one thread:

| At | Caption | On screen |
| --- | --- | --- |
| 0:00 | Ask the Overseer about past work | The Overseer page, its composer holding "Where was the session where we set up upload retries?"; Send. |
| 0:03 | It finds the session by what was said | A Search sessions step; the reply links Upload client with retries (12 days ago). |
| 0:07 | Then ask what's waiting on you | "What's waiting on me?" typed and sent. |
| 0:12 | Every waiting session, and why it waits | 3 linked sessions; Needs you reads 3. |
| 0:16 | Open one: a drawing shows the problem | Retry backoff opens; its last reply's chart: waits doubling to 64 s. |
| 0:22 | Agree on the plan before work starts | The alignment card from its title, naming the found session. |
| 0:27 | Your call, in one click | The recommended 30 s, then Send; Decided: 30 s. |
| 0:32 | Each worker runs on its own model | 3 workers; the Agents tab: zai glm-5.3, deepseek deepseek-v4.1-flash, openai gpt-6.1-sol. |
| 0:40 | Three models, one finished job | Sped up 3x: the workers finish, All 3 are back with 2 steps to review, the live summary lands. |
| 0:44 | Review every change as steps | Review Changes: the changes viewer, one numbered step per worker that changed code, each with its reason; step 1's diff (GLM-5.3: the 30 s cap and its test). |
| 0:50 | Each step with its reason | Step 2 clicked: DeepSeek's README line. The server check (GPT-6.1 Sol) changed no code, so it has no step; the reply before says so. |
| 0:57 | Its timeline and summary at a glance | The viewer closed, the Timeline tab: chapters, idle 3h, the decision, the workers; Current goal above the chat. |

The phone section shows stills only (the Access page and phone-question): its clip flickered
and was dropped. A video is a list of beats, played in order:

| `do` | What happens |
| --- | --- |
| `type` | The pointer goes to the composer, clicks it, and types a user step (`step`; `scene: "overseer"` for the video's Overseer opener). |
| `click`, `tap` | The pointer goes to a `target` and presses it: `send`, `composer`, `link` (a reply's link, by `text`), `session-row` (`text`), `align-option` (`q`, `option`), `go-with-recommendations`, `workers`, `worker`, `close-panel`, `review-changes`, `changes-step` (`n`), `close-changes` (the changes viewer's Close: it uncovers the page from before, so it brings nothing new and no settle time follows), `pane-tab` (a session detail tab, by `text`). A tap video (`pointer: "tap"`) draws a ring where the finger lands; an arrow video draws an arrow that travels. |
| `release` | The director plays on to a hold (`until`, `scene: "overseer"` for the opener's) or the scene's end, the pointer still. `speed: 3` plays that stretch 3 times faster and the page shows a "Sped up 3×" tag beside its caption. `summary: true` also waits until the session's next `summary` step shows in its Current goal strip. |
| `hold` | Still, while the viewer reads `read` (or for `for`). |
| `scroll` | The alignment card from its title (`align`), its answer row (`align-end`), the latest drawing (`vis`), or the end. |
| `home` | The last beat: the pointer goes back to where it started and the video fades into its first frame. |

`caption` on any beat starts a caption there (null ends it; the first beat has one). Captions are
page text, one line under the video, never drawn into the picture: the recorder writes each one's
start and end in the video's own seconds (and the sped-up stretches) to the manifest as the
video's `cues` and `tags`, and the page shows the one for the video's current time, so it follows
loops, pauses and seeking. `line` is the fixed line shown instead where the video doesn't play
(reduced motion, no JavaScript, a failed load): it describes the still. Captions and `line` are
left out of the video's input hash, so rewording one needs only `screens:video -- --cues`, which
rewrites the cue lists from the recorded beat times, with no filming. `start` names the first screen,
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
- A caption has at most 8 words and 48 characters, and stays on the page at least its reading
  time (the rule above), never under 2 s.

**How it is made.** record.mjs plays the beats in the page (the app's own animations on; scrollbars,
spell-check marks, toasts and the Jump to Latest pill hidden) and films it with the CDP screencast,
which sends a frame only when the page changes (the browser's tap highlight is off too: the drawn
ring is the tap). Nothing else repaints the page while it films: `--stills` saves the screencast's
own frames, because a `page.screenshot` mid-film reached the video as a frame flashing zoomed in or
out. Each frame is cropped to the viewport at the film's pixel scale, and a frame whose picture
disagrees with its metadata is dropped (record.mjs prints each one). It logs every event as an anchor; between anchors
the video runs at the beat's nominal time (a hold its length, a travel its duration...), so a busy
machine can't stretch it; only a reply arriving keeps its real length. video-compose.mjs then makes
a constant 30 fps picture from the frames, draws the pointer and its ripples, and fades the end
into the first frame, which is also the poster (`src/assets/screens/video-<name>.webp`). It encodes AV1 (`*.av1.mp4`, the first
`<source>`) and H.264 (`*.mp4`, the fallback), each at the best quality within its budget.

**Checks before a video is written** (video-check.mjs, again in `screens:verify`): every frame of
both files decodes; enough distinct frames and no still stretch longer than any hold (not frozen);
no flicker (15% or more of the picture changing for 1 or 2 frames, then returning);
the frame just before the fade matches the page's own screenshot along its bottom and right edges
(not cropped or offset); the shape, width, length and size are the story's; every hold met its
reading time, every travel its range, and the pointer its 1.5 s after new content; the leak gate
passed at the start and after every beat; the cue list holds the story's captions in order, from
0 to the end, each on the page at least its reading time. A video that fails leaves the old one in
place. `screens:verify` also fails when the manifest's cues aren't what the story's captions and
the recorded beat times give.

The Overseer's memory is turned off in the demo root (its summarizer would need a real login and
says so in a notice).

## Running

```sh
cd site
pnpm run screens:check                 # a second; no server, browser or model
pnpm run screens                       # shots whose inputs changed; --all for every one
pnpm run screens -- --shot hero-desk   # one shot
pnpm run screens:video                 # the video, if its inputs changed; --force to re-record
pnpm run screens:video -- --video desk --force --stills /tmp/x   # one video, the page after every beat (from the screencast)
pnpm run screens:video -- --cues       # a caption reworded: the cue lists again, no filming
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
page as it was in `.agent/screens/debug/` (ignored by git; `SCREENS_DEBUG_DIR` points it elsewhere).

Outputs, committed with the story: `site/src/assets/screens/*.webp` (lossless masters, dark theme
only; the site shows them in both of its themes), `site/src/assets/screens/manifest.json` (alt
text, sizes, slots, input and content hashes; generated, never edited), and
`site/public/video/session-desk.{av1.mp4,mp4}` with its poster
`src/assets/screens/video-desk.webp`, and the video's `line`, `cues` and `tags` in the
manifest (the page's captions, `src/components/screens/VideoCaption.astro`). The pages read alt text and sizes from the manifest, so an
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
  name `tailscale status` reports when it runs. It also refuses, in the text, titles and labels,
  any model or provider name (a known family's word: claude, gpt, glm, deepseek, gemini, qwen,
  openai, …) that isn't part of one of the story's models' ids, names or providers.
- The Access page's pairing response is mocked (`sova.example.ts.net`): the real one names this
  machine's tailnet.
