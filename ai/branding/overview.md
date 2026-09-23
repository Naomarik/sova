# Sova branding

Working notes for how Sova presents itself: what it is, how it talks, which name it carries, and
what a reader can safely claim about it. Nothing here loads automatically and nothing in the app
reads it. It is for a person or an agent writing about Sova on purpose.

**The brand's machine-readable half is now `.sova/marketing/brand.json`**, rendered into
[`.sova/marketing/BRAND.md`](../../.sova/marketing/BRAND.md) by the Marketing playbook's generator
(`playbooks/marketing/`). That is what the marketing playbooks read, and where `brand.json` and a
page here disagree, `brand.json` is the one that is maintained. The pages below keep what a
rendered brand book cannot hold: the reasoning, the decision record, the rejected candidates, the
tables of where things live, and the before/after examples.

**Sova** is the name: Sessions, Orchestration, Viewing & Agents. The wordmark is set lowercase,
`sova`, matching the app's own brand element; running prose capitalizes it. The mark is Astra's
**Fold** (`logos/round-2/astra/sova-fold.svg`), shipped as `public/icons/sova-mark.svg`. The
decision, the rejected candidates, and the list of places a rename touches are in
[naming.md](naming.md); the exploratory sheets stay on disk as history.

The visual system is not here. It lives in the design skill at
`.claude/skills/fold-ai-dev-design/SKILL.md` and its product-specific deviations in
[`spec/07-deviations.md`](../../spec/07-deviations.md). These pages link to it and do not restate it.

| Read | When |
|---|---|
| [identity.md](identity.md) | You need to say what Sova is, for whom, in one paragraph or one line — the recorded reasoning behind the fields now in `brand.json`. |
| [voice.md](voice.md) | You are writing prose about it: a README section, a release note, a page — the reasoning and the before/after examples behind the voice rules in `brand.json`. |
| [truth-sources.md](truth-sources.md) | You are about to claim a feature exists. Read this first. |
| [naming.md](naming.md) | The name and the mark, decided, with the rename ledger. |
| [playbooks/readme-update.md](playbooks/readme-update.md) | Editing `README.md` after a change. |
| [playbooks/explain-feature.md](playbooks/explain-feature.md) | Writing up one feature for a reader who wasn't there. |
| [playbooks/derive-website.md](playbooks/derive-website.md) | Turning the README and spec into a small site. |
| [Selected mark](logos/selected/sova-fold.html) | The chosen lockup: Astra's **Fold**, shipped as `public/icons/sova-mark.svg`. |
| Logo concepts: [Astra](logos/astra/comparison.html), [Fable](logos/fable/comparison.html), [K3](logos/k3/comparison.html), [Astra round 2](logos/round-2/astra/comparison.html), [Fable round 2](logos/round-2/fable/comparison.html), [K3 round 2](logos/round-2/k3/comparison.html) | Exploration history: 12 candidate marks in round 1 and 12 round-2 monograms, 4 per model, with small-size previews in both themes. Kept as drawn; none of these are the decision except the selected Fold. |

Two rules hold across every page. The reader is another pi user running their own instance, not a
customer; there is no service, no team plan, no account. And a spec section is a plan, not a
receipt: say a feature is shipped only after checking the code at a named revision.

## A rename in progress

The name is Sova, and as of 2026-09-22 everything on disk has moved. These pages say which
`pi-web` strings survive and why, rather than assuming. At the revision this folder describes:

| Surface | State |
|---|---|
| Product name in the app's chrome | `sova` — the brand element in `src/components/Sidebar.tsx`, `<title>` and the PWA manifest in `index.html` and `public/manifest.webmanifest` |
| Package and repository | `sova` in `package.json`; GitHub [Naomarik/sova](https://github.com/Naomarik/sova) |
| State directory | `~/.pi/agent/sova/` — the server writes `web-sessions.json`, `session-groups.json`, `archived-sessions.json`, `drafts.json`, `defaults.json`, `attachments/`, `themes/`, `targets/` and `usage-last-known.json` there. **Done**: moved by atomic rename with a backup kept; reads use the new root only, while absolute `pi-web/` paths embedded in transcripts resolve through `unlegacyStatePath`. |
| Browser storage keys | `sova:*` (`sova:theme`, `sova:typography`, `sova:recent-count`, `sova:archive-*`, `sova:group-view-*`, `sova:folder-open-*`). **Done**: written new, with the legacy `pi-web:*` key read and mirrored so an open tab and a rollback both keep working. |
| Theme schema id | `sova-theme/v1`, with the legacy `pi-web-theme/v1` accepted (`shared/theme.ts`). The shipped `themes/*.json` still carry the old id — cosmetic; both load. |
| Session markers | `pi-web-rewind` and `pi-web-fanout-member` `custom` entries; renaming these would invalidate existing transcripts. |
| Earlier shipped mark | `public/icons/pi-web-mark.svg` (a stroked π), kept on disk; the app no longer uses it. |

The state keys and the directory are the costly ones: a rename that changes them without a
migration loses every user's theme choice, their dropped-in themes, and the archive. The plan is
to read the old key and directory first and write the new one; until that ships, the old names are
the true ones and these pages say `pi-web` wherever the code does.
