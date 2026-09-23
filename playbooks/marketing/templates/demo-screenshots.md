---
title: Capture {{name}} screenshots
description: Agrees with you which screens, states, widths and themes to show, then drives the real running project in a browser to capture them, with a manifest naming what each one shows.
promptHint: The screens or moments you want shown, and any widths, theme or data the shots need (a seeded account, a long list, an error state).
---

# Capture {{name}} screenshots

Screenshots of the real project, running, at a named revision. They are never mockups and
never edited. A screenshot is a claim too: it shows the app doing something, so the app must do
it at the revision in the manifest.

Paths are relative to the project root (see `.sova/marketing/TOOLS.md`). Beside this playbook:
`plan.example.json` (the plan format) and `capture.mjs` (carries out a plan). Read
`.sova/marketing/TOOLS.md` before the first browser step.

## 1. Align first — capture nothing yet

Read `.sova/marketing/BRAND.md` and, if it exists, `.sova/marketing/claims.md`: a screenshot
should show a shipped claim. Then work out what to shoot **with the user**, a few questions at
a time, and wait for answers:

1. **Which screens, and why.** Propose 3–6 shots, each tied to a reason to use the project (a
   `claims.md` row, or the one line). For each: the screen, and what the reader should notice.
2. **Which states.** Empty, typical or busy? A real-looking dataset beats an empty list. If the
   demo needs seed data or a login, that's in `project.demoNotes`; ask what's missing.
3. **Which widths.** Recommend one desktop width (1280×800) and one narrow (475×900) for any
   screen that changes layout. Name them per shot.
4. **Which theme.** Each shot is `light` or `dark`. If the project has both, recommend the hero in
   its default theme plus one in the other.
5. **Where they'll be used.** README (one or two), the site's home (one hero), social (the
   platforms crop differently; see **Write {{name}} announcement posts**).

Write the agreed list into `.sova/marketing/assets/screenshots/plan.json`, show it to the user
and get a yes before you capture.

### The plan

Same shape as `plan.example.json` beside this playbook. Every field is required; unknown fields
are rejected.

| Field | Meaning |
|---|---|
| `baseUrl` | The URL of the app **you** started, on the port you checked was free (step 2). `null` means `project.demoUrl` from `brand.json`; use it only when that port was free before you started the app. |
| `shots[].file` | Output name: lowercase, `.png`, no folders. Say what and how: `session-list-1280-dark.png`. |
| `shots[].path` | Path (and query) under `baseUrl` to open. |
| `shots[].width`, `height` | Viewport in CSS pixels. |
| `shots[].colorScheme` | `light` or `dark`, emulated as the system setting. If the app keeps its own theme choice (a toggle, `localStorage`), set it in `prepare` instead, then reload. |
| `shots[].prepare` | `null`, or the body of an async function given `page` (Playwright): click to the state the shot needs. Prefer `getByRole(…, { name, exact: true })`. Put an explicit `{ timeout }` on every wait. A locator that matches nothing otherwise hangs for 30 seconds. |
| `shots[].shows` | One sentence: what the reader sees. It becomes the caption. |
| `shots[].alt` | Alt text: what is on screen, for someone who can't see it. Not the caption again. |
| `shots[].hero` | `true` for at most one shot, the one the site's home and the README lead with. |
| `shots[].fullPage` | `true` to capture the whole scroll height, else just the viewport. |

## 2. Run the real project

```sh
git rev-parse --short HEAD && git status --short
```

Note the revision. If the tree is dirty, the manifest records `dirtyTree: true`. Tell the user
the shots show uncommitted work.

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
you are on the wrong port:** stop, and capture nothing from it.

Use only data you created or seeded for the demo, and that is safe to publish: no real names,
tokens, hostnames or personal paths on screen.

## 3. Try the path by hand first

Start your own browser (TOOLS.md). Walk each shot's path with `pw.sh`: `navigate`, then `resize`,
then `eval "innerWidth"`, then `snapshot` to find the names you'll use in `prepare`. This is
where a `prepare` gets written. Guessing selectors inside `capture.mjs` costs a 30-second
timeout per miss.

## 4. Capture

```sh
PW_PORT=<your port> node .sova/marketing/playbooks/demo-screenshots/capture.mjs
```

For each shot it opens a fresh tab, emulates the theme, navigates, sets the viewport **after**
the navigation and reads `innerWidth` back, runs `prepare`, and sets and reads the width again,
because `prepare` may navigate. Then it waits for fonts and captures. A page error or a width
that didn't take fails that shot and the rest continue. It writes
`.sova/marketing/assets/screenshots/manifest.json` listing each captured shot with its `shows`,
`alt`, final URL, size, theme and revision. Exit 1 means at least one shot failed; the message
names it.

## 5. Look at every one

Open each PNG and check that it shows what `shows` says it shows, at the width it says, in the
theme it says, with no half-loaded content, no spinner, no toast left over, no private data,
and no scrollbar cutting through a layout. Retake any that don't. Checking that the file exists
proves nothing about what's in it.

## 6. Hand off

Stop your browser and every process you started. Report each file with its `shows`, size,
theme and the revision from the manifest, which shot is the hero, and anything the user asked
for that you couldn't show and why. The site picks the shots up on its next build (`sync-brand.mjs`); the README
links them by path.
