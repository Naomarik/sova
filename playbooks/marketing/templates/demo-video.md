---
title: Record a {{name}} demo video
description: Agrees with you what the video shows, proves a recording path works on this machine, then records the real running project and verifies the file plays before calling it done.
promptHint: What the video should show from start to finish, how long it should run, and where it will be posted (which sets size and length).
---

# Record a {{name}} demo video

A short screen recording of the real project, running, at a named revision: no mockups, no
edits that change what the app did. The rule for this playbook: **a video does not exist until
you have reported its path, its duration, and how you checked it plays.** A file on disk is not
evidence. It may be empty, frozen or undecodable.

Paths are relative to the project root (see `.sova/marketing/TOOLS.md`). Beside this playbook:
`plan.example.json` (the plan format), `record.mjs` (records one plan, two ways) and
`verify-video.mjs` (proves a file plays). Read `.sova/marketing/TOOLS.md` before the first
browser step.

## 1. Align first — record nothing yet

Read `.sova/marketing/BRAND.md` and, if it exists, `.sova/marketing/claims.md`: the video should
show a shipped claim happening. Then agree with the user, a few questions at a time, and wait
for answers:

1. **The story.** One task from start to finish, in 3–6 beats: "open an item, rename it, see
   the list show the new name." One video, one idea. Write the beats back to them.
2. **Length.** Recommend 15–45 seconds. Every pause is part of the length; a viewer needs about
   a second to read each change.
3. **Where it goes.** README and site (any length, `.webm` works), social (see the limits in
   **Write {{name}} announcement posts**; some platforms want `.mp4`), a release note.
4. **Size and theme.** Recommend 1280×720 in the project's default theme. Sizes must be even.
5. **State and data.** What must exist before recording starts: seed data, a login, an open
   file (`project.demoNotes`). Nothing private on screen.

Write the agreed plan to `.sova/marketing/assets/video/plan.json` (same shape as
`plan.example.json`; every field required) and get a yes before recording.

| Field | Meaning |
|---|---|
| `baseUrl` | The URL of the app **you** started, on the port you checked was free (step 2). `null` means `project.demoUrl` from `brand.json`; use it only when that port was free before you started the app. |
| `path` | Where the video starts, under `baseUrl`. |
| `width`, `height` | Viewport and video size, even numbers. |
| `colorScheme` | `light` or `dark`. |
| `file` | Output name: lowercase, ending `.webm`. |
| `shows` | One sentence: what happens in the video. It becomes the caption and the alt text's start. |
| `script` | The body of an async function given `page` (Playwright). The beats, with `await page.waitForTimeout(ms)` between them so a viewer can follow. Put an explicit `{ timeout }` on every wait. |

## 2. Run the project and walk the beats by hand

Note the revision (`git rev-parse --short HEAD`, `git status --short`).

**The port must be free before you start and yours afterwards** (the rule in
`.sova/marketing/TOOLS.md`). Choose the port, then check it:
`curl -s -o /dev/null -w '%{http_code}\n' <url>` must print `000`. Anything else means another
process (another dev server, another agent, a live app) already answers there. An app started on
a taken port usually exits with `EADDRINUSE` while the other process keeps answering, and every
later check then passes against the wrong app. Prefer a scratch port over the framework's
default, start the app on it (`project.demoNotes` or the project's scripts say how it takes a
port), and put that URL in the plan's `baseUrl`. If the app can't be moved off a taken port, ask
the user.

Then start the app with `project.run` from `brand.json`, following `project.demoNotes`:

- **A line** is one process. Start it in the background and keep its output.
- **A list** is one process per entry. Start each as its own background process, in the order
  listed, and never join them with `&` into one command: you need each one's exit and output
  separately. `project.demoNotes` says which process listens on which port and what each needs
  (a second port, a scratch data folder, an environment variable pointing one at the other).
  **Every** process's port must pass the free-port check above, not only the one in `baseUrl`:
  a back end that fails on a taken port leaves your front end talking to someone else's, with
  their data. Wait for each to answer on its port before starting the next.

Once the URL answers, confirm it is **yours**: every process you started is still running, and
the page shows something only this project shows (its title, a known string). A URL that
answers proves only that something is listening. **If the page loads data you did not create,
you are on the wrong port:** stop, and record nothing from it.

Start your own browser (TOOLS.md) and walk each beat with `pw.sh` (`navigate`, `resize`,
`eval "innerWidth"`, `snapshot`) to find the accessible names the script will use.

## 3. Establish a working recording path — before the real take

Whether a recording path works depends on this machine's Playwright, browser and ffmpeg, so
**prove one with a throwaway take first**. `record.mjs` has two:

| `--via` | How | Needs |
|---|---|---|
| `context` | Playwright's `recordVideo` on a new browser context, created over the CDP connection to your browser. Playwright encodes a VP8 `.webm` itself. | Playwright's bundled ffmpeg (installed with its browsers). |
| `screencast` | The page's CDP screencast: every changed frame is saved with its timestamp, then the system `ffmpeg` builds a VP8 `.webm` at the frames' real timing. | `ffmpeg` in `local.json`. |

Try `context` first: it is Playwright's own recorder, and it includes the first paint. But
don't trust it because it produced a file. When this playbook was written (Playwright 1.54.1,
headless Chromium started by the Playwright skill), `context` recordings lost the bottom 142px
of the page after any navigation, while the size, the decoding and the frame count all passed.
Only the edge check below and looking at the stills caught it. `screencast` recorded the same
script correctly.

```sh
PW_PORT=<your port> node .sova/marketing/playbooks/demo-video/record.mjs --via context
```

It records, then runs `verify-video.mjs` on the result and prints what it measured. If it
throws, or the measurements show a problem (below), try `--via screencast`. If both fail, stop
and tell the user what each one printed. Don't hand over an unverified file.

**Say which path you used and why** (for example: "`context` worked on the first try" or
"`context` produced a file with 1 distinct frame, so I used `screencast`"). It goes in your
report and it is recorded as `via` in the manifest.

## 4. What "it plays" means

`verify-video.mjs` checks, and `record.mjs` records under `verified` in
`.sova/marketing/assets/video/manifest.json`:

- `ffprobe` reads the container and finds a video stream: codec, width, height.
- `ffmpeg` **decodes every frame** (a file that probes but can't be decoded fails here) and
  hashes each one. `framesDecoded` must be at least 2, and `distinctFrames` must be at least 2.
  A recording of a frozen or blank page decodes fine and has 1.
- Duration is at least 1 second, and the size is the plan's.
- **The picture is the page.** `record.mjs` holds the last state for 600ms and saves the page's
  own screenshot (`<name>.reference.png`); a frame from inside that hold is compared with it
  along the bottom and right edges (`edges`, mean difference out of 255; over 40 is a problem).
  A cropped or offset recording passes every check above and fails this one. The frame comes
  from before the screenshot because taking a screenshot repaints the page and would hide a
  crop from then on.
- Stills at 10%, 50% and 90% are written beside the video (`<name>.check-10.png`, …).

`problems: []` is necessary, not sufficient. **Open the three stills** and check that they show
the beats you expected at those points: the right screen, the right theme, nothing private,
nothing half-loaded. To re-check any file, including a converted one:

```sh
node .sova/marketing/playbooks/demo-video/verify-video.mjs .sova/marketing/assets/video/<file> --width 1280 --height 720 --reference .sova/marketing/assets/video/<name>.reference.png
```

## 5. The real take

Run `record.mjs` with the path that worked, as many times as it takes. Check the result as in
step 4 each time. If the user needs `.mp4` (some social platforms), convert and then verify the
converted file too:

```sh
ffmpeg -v error -i .sova/marketing/assets/video/<name>.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart .sova/marketing/assets/video/<name>.mp4
node .sova/marketing/playbooks/demo-video/verify-video.mjs .sova/marketing/assets/video/<name>.mp4
```

(`ffmpeg -encoders | grep libx264` first. Without libx264 there is no `.mp4`; say so.)

## 6. Hand off

Stop your browser and every process you started. Delete the `.check-*.png` stills and
`.reference.png` if the user doesn't want them kept. For each video, report:

- the path, the duration in seconds, the size and the codec, from `verified`;
- the recording path (`via`) and why;
- how it was verified: `framesDecoded`, `distinctFrames`, `edges`, and which stills you looked at;
- the revision, and whether the tree was dirty;
- anything in the plan you could not show, and why.

Never write "the video is ready" without those lines.
