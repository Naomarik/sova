# The interview

Goal: everything `brand.json` needs (fields in `brand.md`), in a conversation the user
enjoys. Four rounds, each **2–4 questions**, each question with your recommended answer and
why. Skip any question the project already answered; say what you found instead ("Your
`package.json` says MIT; keeping that."). Wait for the answer before the next round.

Talk about the brand, never about JSON. The user never has to see a field name.

## Round 1 — what it is, for whom

- **What does it do, in one sentence?** Offer your own draft from the README. Push for a verb
  and an object ("reads your logs in a browser") over a category ("a log tool").
- **Who is it for?** What do they already use, what do they know, and what do they need to be
  told? "Developers" is not an answer; "someone who runs services locally and greps their logs"
  is.
- **What should nobody mistake it for?** The things a reader might assume: hosted, for teams,
  a replacement for X. These become `notThis`.

Then draft the one paragraph (what it is, how it works, where it runs, its main limit, 40–120
words) and show it. Edit it together until they'd sign it.

## Round 2 — how it talks

- **Three to five words for how it should feel to read.** Turn their words into pillars, each
  with what it means in prose and the failure it prevents. Propose the set and let them edit.
  Calm, concrete, warm and candid work for most developer tools. Offer them as a starting point,
  not a default to accept.
- **Words to use and words to avoid.** Propose both from the project's own nouns and the
  category's clichés ("seamless", "powerful", "platform"). A word can't be on both lists.
- **Language and spelling.** `en-GB` or `en-US` (or another locale). Recommend the one the
  README already uses.
- **The name in a sentence, and the wordmark.** Same letters; is the lockup lowercase, as
  written, or all caps?

## Round 3 — how it looks

Ask about intent; decide the values yourself.

- **Color.** Dark, light, or following the system by default? One accent or none? Any color
  they already use or want to avoid? Then choose `bg`, `ink`, `muted`, `accent` and the ink that
  sits on the accent (`accentInk`) for both themes. Compute the contrast of ink, muted and
  accent on bg, and of accentInk on accent, and keep each at 4.5:1 or more (the generator warns
  if not; the site check fails). Show them as swatches, or as a table with the ratios if you
  can't render.
- **Type.** A text face and a code face. If the project ships font files, use them. Otherwise
  recommend open-licensed faces and ask whether to add the files to the project (fonts are
  never loaded from a CDN), or use system fonts for now. Record the weights the system allows
  and the wordmark's weight and tracking if the project states them; if it doesn't, say the
  wordmark will use the defaults (640, `-0.03em`) rather than presenting them as a choice.
- **Existing design system.** If the project has tokens or a CSS design system, note its path,
  and copy every palette value from it: the generator fails on a hex the tokens file doesn't
  contain. Note any other design-system documents too (a skill, a deviations list).
- **A mark.** Keep an existing one where it is, with any fixed-color copies it already has (for
  a README or a marketplace), or leave it for the **Design the logo** playbook. Don't draw one
  now.

## Round 4 — the facts

Mostly confirmations of what you mined; ask only what you couldn't find.

- **Install and run.** The exact commands from a fresh clone, run from the project root, and
  the URL the running demo opens at. If it takes two processes, that is two run commands, not
  one joined with `&`. What else a demo needs: seed data, an env var, a login.
  Offer to run them now to check. A command you ran beats a command you read.
- **Where people will hear about it.** Which platforms (Bluesky, Mastodon, X, LinkedIn, Hacker
  News, Reddit), and who reads there. "Not decided" is a valid answer: record no platforms,
  and the announcement playbook asks later. Don't pick one for them.
- **License, repository, hosting.** The SPDX license id, the public repo URL (or none), where
  the site will live (or "Not decided"), and its URL if it has one. The URL's path becomes the
  site's base path.

## Closing the interview

Summarise the brand in 8–10 lines: the one line, who it's for, what it isn't, the pillars, the
colors with their ratios, the faces, the commands. Mark every value you chose rather than the
user, and ask for a final yes or edits. Then return to step 3 of `PLAYBOOK.md`.

If the user wants to stop early, write what you have only if it validates. Otherwise, tell them
which fields are still open (by their plain-language question, not their JSON path), and
write nothing.
