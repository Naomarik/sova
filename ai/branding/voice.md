# Voice

> Part of [Sova branding](overview.md). The product's UI copy is governed by the design skill's
> Voice section and by [`.sova/spec/claims/design/copy-deck.md`](../../.sova/spec/claims/design/copy-deck.md). This page is about prose
> written *about* Sova: README, notes, release notes, a website.

**Superseded in part.** The pillars, the use/avoid words, and the shape rules now live in
`.sova/marketing/brand.json` and are rendered into
[`.sova/marketing/BRAND.md`](../../.sova/marketing/BRAND.md), which is what the marketing playbooks
read. Where the two disagree, `brand.json` is the maintained copy. This page keeps what a rendered
brand book has no room for: the reasoning, and the before/after examples that teach a rule by
showing it broken first.

## The four pillars, applied to prose

The skill's pillars are calm, concrete, warm, and candid, all at once. In UI copy they are
short. In prose they have room, and the failure modes change.

| Pillar | In prose it means | The failure it prevents |
|---|---|---|
| Calm | No superlatives, no urgency, no exclamation marks. | "Blazing fast", "finally", "you need this". |
| Concrete | Name the file, the port, the count, the command. | "Seamless integration with your workflow." |
| Warm | Written by a person to a person who runs the same tool. | Marketing voice; the passive voice; "users". |
| Candid | State the limit next to the feature. Say what it doesn't do. | A feature list with no edges. |

## The reader

Another pi user, on their own machine, deciding whether to run this. Address them as "you". Refer
to the project as "Sova" or "it"; "we" is fine when it means the people who wrote it, and the
README already uses it that way. Never "our users", "customers", or "teams".

Write the wordmark lowercase only when you are quoting the lockup (`sova`); in a sentence, the
name is **Sova**.

## Words

**Use:** session, transcript, TUI, live, watch, chat, worker, subagent, target, theme, mode,
model, extension, the agent directory (`~/.pi/agent`), local, on this machine.

**Avoid:** platform, solution, seamless, powerful, leverage, enterprise, cloud, seat, plan, tier,
onboarding, workspace when you mean the machine (it is a specific feature; see
[naming.md](naming.md)), AI-powered (everything here is), revolutionary.

**Say what it isn't when the reader might assume it is.** "It is for one local user." "The server
has no authentication." "A session open in a TUI is read-only here." These sentences are the brand.
A page that only lists what works reads like a pitch, and this is not a pitch.

## Shape

- Lead with what the thing does, then how, then the limits. One idea per sentence.
- Sentence case for headings. Title Case only for a button you are quoting.
- Digits, always: "18 themes", "port 4800", "2 seconds".
- Machine facts in code spans: paths, ports, ids, commands, file names.
- Relative dates only inside the app. In prose, write the date: "verified 2026-09-22 at `d3a6963`".
- Tables for facts that line up. Prose for anything with a "because".
- No emoji, no exclamation marks, no rhetorical questions.

## Two examples

Before: *Sova is a powerful web interface that seamlessly connects to your pi sessions and
lets you chat from anywhere!*

After: *Sova lists every pi session on this machine and opens any transcript in a browser. A
session that Sova started can be continued from the page, including from a phone on the same
network. A session open in a TUI is shown live and read-only.*

Before: *Our advanced theme engine supports unlimited customization.*

After: *A theme is one JSON file. 18 ship with the app; yours go in `~/.pi/agent/sova/themes/`
and appear in the picker within 2 seconds of saving.*

## Claims

Every claim of a capability goes through [truth-sources.md](truth-sources.md). A sentence in
the spec, this folder, or an older README is not evidence that it runs.
