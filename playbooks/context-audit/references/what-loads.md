# What a project loads into a chat, and when

The inventory follows Sova's own rules, the same ones the project's Settings (Context Files and Skills cards) and a chat's Context tab show. Chats on Claude Code inside Sova load the same files by the same rules.

| Item | Loads | Counted in "always loaded" |
|---|---|---|
| The instruction file at the project's top: per folder the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` | every message | yes |
| `.pi/SYSTEM.md` (replaces the system prompt), `.pi/APPEND_SYSTEM.md` (added to it) | every message | yes |
| An instruction file in a subfolder | once the agent reads, edits or writes in that folder | no |
| Each skill's listing: its name, description and location | every message | yes |
| A skill's entry page (`SKILL.md`) | when the skill is used | no |
| A skill's other pages | when the entry page sends the agent there | no |
| A manual-only skill (`disable-model-invocation: true`) | only when typed, never offered; sized by its whole text | no |
| Prompt commands (`.pi/prompts/`, the `prompts` array of `.pi/settings.json`) | when typed | no |
| Playbooks (`.sova/playbooks/<id>/`, `.sova/marketing/playbooks/<id>/`) and the pages their `playbook.json` names | when started | no |
| Project modes (`.sova/minor-modes/<id>/MODE.md`) | while the mode is on | no |
| A guide: a page an entry above points to, outside that entry's folder | when that entry sends the agent there | no |

Where skills come from: `.pi/skills`, `.agents/skills` and `.claude/skills` at the project's top, the `skills` array of `.pi/settings.json`, and `.agents/skills` and `.claude/skills` in a subfolder (offered once the agent works there). A folder holding `SKILL.md` is one skill; in `.pi/skills` a loose `.md` file is one too. Walks skip `node_modules` and hidden folders and stop at 5,000 folders.

What never loads, and the inventory says so:

- A skill or instruction file whose real place is outside the project (a link out of it).
- A skill with no description; pi also warns on a name over 64 characters or a description over 1,024.
- An item the user turned off on the Context Files or Skills card: listed off, not counted, never turned on by the audit.

Guides are followed one hop from an entry by default (`AGENTS.md` → an area's guide); `--depth 2` adds the pages those guides point to. Pages past the depth are counted, not read.

The user's own files (the card's switch): pi's settings folder's instruction file, its `skills` and `prompts`, `~/.agents/skills`, the Claude folder's skills, and the user's playbooks. They load in every project, so they can contradict this one; the audit reports them and never edits them.

Sizes are ≈ tokens, characters / 4, as the Context tab shows them, plus lines. Exact counts differ per model and would disagree with the Context tab.
