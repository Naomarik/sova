---
title: Marketing
description: Interviews you about your project and the brand you want, writes it down as one brand.json, and generates this project's README, site, screenshot, video, logo and social playbooks from it.
promptHint: What the project is and who it is for, anything you already have (a README, a logo, colors, a site), and whether you want a brand from scratch or to write down one that exists.
---

# Marketing — set up a project's marketing system

You are setting up the marketing system for **one project**: the README, the site and docs,
screenshots, a demo video, a logo and announcement posts. You don't write those now. You write
the brand they all come from, then generate one playbook per job. From then on they appear
in Sova's **+ → Playbooks** under **This project**.

Plain markdown for an agent to follow. **Don't load every file up front.** Read this file, then
read each file below only at the step that names it.

| File in this playbook's directory | Read it |
|---|---|
| `interview.md` | When you start asking questions (step 2). |
| `brand.md` | Before you write `brand.json` (step 3). It is the field contract. |
| `example.brand.json` | With `brand.md`, for the shape. Its words are a fictional project's. |
| `scripts/generate.mjs` | Never: you run it (step 4). |
| `templates/*` | Never: the generator renders them. |

## The output (fixed)

Everything goes under **`<project root>/.sova/marketing/`**:

```
.sova/marketing/
  brand.json        — THE brand. Written by you, with the user. The one hand-edited file.
  BRAND.md          — the brand as a readable book, rendered from brand.json.        [generated]
  TOOLS.md          — paths, the browser, re-running the generator.                  [generated]
  playbooks/<id>/   — readme, doc-site, demo-screenshots, demo-video, logos, social. [generated]
  lib/              — code the playbooks' scripts share.                             [generated]
  local.json        — this machine's paths (gitignored).                             [generated]
  manifest.json     — which files the generator owns.                                [generated]
```

The generator writes only under `.sova/marketing/`, only files it owns, and never a file it
didn't write. The six playbooks then write their own work (`claims.md`, `assets/`, `site/`,
`social/`) beside it, and the generator never touches those.

## Steps

### 1. Find the project, and what's already there

The project is the folder this session runs in, unless the user names another. Confirm it in
your first message. Then look before you ask, so the interview skips what the project already
says: the README, the package manifest (`package.json`, `pyproject.toml`, `Cargo.toml`, …),
`LICENSE`, any `docs/`, any existing logo or design tokens, the git remote
(`git remote get-url origin`), and how it runs (scripts, `Makefile`, `Procfile`).

If `.sova/marketing/brand.json` already exists, this is a revision, not a first run. Read
`.sova/marketing/BRAND.md`, ask what the user wants to change, edit only that, and go to step 4.

Greet the user with what you found in 3–5 lines. For example: "`kestrel`, MIT, a Vite app
started with `npm run dev`, 4 docs in `docs/`, no logo". Say what you'll produce, and that
it takes a short conversation, a few questions at a time.

### 2. Interview

Read `interview.md` now and follow it. The rule that matters most: **a few questions at a time,
each with your recommended answer, and wait**. Not a wall of questions. Hash it out. Keep a
running draft of the brand as you go, in your head or a scratch file outside the project, not
in `brand.json` yet.

### 3. Write `brand.json`

Read `brand.md` and `example.brand.json` now. Write `.sova/marketing/brand.json` from the
interview, then validate it without generating anything:

```sh
node <this playbook's directory>/scripts/generate.mjs --project <project root> --validate
```

It prints each problem with the field's path (`voice.pillars: must have at least 3 item(s)`).
Fix and re-run until it prints `is valid`. Then show the user the **decisions you made for
them** (hex values, pillars you named, words you chose) and get a yes on those, because the
user never saw them as questions.

### 4. Generate

```sh
node <this playbook's directory>/scripts/generate.mjs --project <project root>
```

It prints one line per file: `write`, `update`, `keep (unchanged)`, `skip` (a file it doesn't
own, left alone) or `remove` (a file it used to generate), then warnings, if any: contrast below
4.5:1, no Playwright, no ffmpeg. Exit 1 means `brand.json` is invalid and nothing was written.
Exit 3 means it skipped files it doesn't own. Tell the user which, and don't delete them to make
room: ask.

Run it twice the first time. The second run must report every file `keep (unchanged)`. If it
doesn't, something is wrong: stop and report it.

### 5. Hand off

Tell the user:

- where the brand is (`.sova/marketing/brand.json`, readable as `BRAND.md`), and that changing
  it means editing that file and re-running the generator (the command is in
  `.sova/marketing/TOOLS.md`);
- the six playbooks now listed under **This project** in **+ → Playbooks** (reopen the menu to
  refresh it), and the order that works best: **Rewrite the README** first (it produces the
  verified claims the others use), then **Capture screenshots**, **Design the logo**, **Build
  the site and docs**, **Record a demo video**, **Write announcement posts**;
- any warning the generator printed;
- whether to commit `.sova/marketing/`. Recommend committing everything except what it
  gitignores (`local.json`, and later the site's `node_modules/` and `_site/`).

Don't start any of the six yourself unless the user asks.

## Rules

- **Ask about the brand, decide the details.** The user says "calm, a bit warm, amber"; you
  choose the hex values, check contrast, and show them. Recommend a default with every question.
- **Mine before asking.** Anything the project already states is a proposal to confirm, not a
  question.
- **Nothing in `brand.json` claims a feature.** It describes the project and how to talk about
  it. Features come from the code at a named revision, later, in the README playbook.
- **One source.** Never copy brand content into a generated file by hand, and never edit a
  generated file: change `brand.json` and re-run.
