# what: what a playbook is, and the files in its folder

A playbook is a folder. Its id is the folder's name.

```
<id>/
  PLAYBOOK.md      the recipe: head lines, then the main chat's method
  playbook.json    optional: choices, cast, steps and how it runs
  phases/<step>.md read when a step begins
  references/      checklists, worked examples, and roles/<member>.md:
                   each team member's working notes
  scripts/         programs the agent runs (Sova never runs them)
  tests/           optional: tests of its own scripts, *.test.mjs
```

`PLAYBOOK.md` starts with `key: value` lines between `---` fences, one line each, not YAML: `title`, `description` and `promptHint` (the composer's hint). Its body is the main chat's method; keep it short: the main chat reads it every run, so detail goes in `phases/` and `references/`.

Without `playbook.json`, picking the playbook sends its recipe into the chat as the person's message: nothing else changes. With one, `/<id>` or picking it in the Playbooks list opens its card instead.

A playbook with scripts keeps their tests in `tests/`: plain `*.test.mjs` files on Node's `node:test`, importing only Node's built-ins and `../scripts/`, so they need nothing installed. Run them with `node --test <id>/tests/*.test.mjs` after every change to the playbook. They run outside any test runner, so each file protects itself before it starts a script: a fresh temp folder that is in no git repository, `HOME` and `PI_CODING_AGENT_DIR` pointed inside it, and `GIT_CEILING_DIRECTORIES` set to it. Sova's A/B cycle (`tests/scratch.mjs`) is the example to copy.

There are three shelves: Sova's own, the person's (`<agent dir>/sova/playbooks/`, where an id replaces Sova's of the same name) and the project's (`.sova/playbooks/`).

## playbook.json

Parsed strictly: every key must be known and every value the right type, or the Playbooks list shows the exact error (the file and the key) instead of the card. Its keys:

| Key | What |
|---|---|
| `version` | `1` |
| `listed` | `false` hides it from the Playbooks list and the `/` rows, for a playbook only Sova's own chats start; default `true` |
| `run` | how it runs: `where` (`this-chat` or `new-chat`), `worktree` (`none` or `new`), `mode` (`normal` or `delegate`), `minorModes`, `permissions` (an automation file's shape; it always runs in a new chat), `needs` (`project`, `merge-queue`) |
| `inputs`, `facts` | the person's choices, and facts shown beside them (section `choices`) |
| `teams` | who runs it: each team's goal and the members it must have (section `cast`) |
| `steps` or `machine` | the flow (section `steps`), never both |
| `commands` | the Sova commands that change things it uses (section `commands`) |

A small one, whole:

```json
{
  "version": 1,
  "inputs": [{ "id": "area", "label": "Which area", "type": "text", "required": true }],
  "teams": {
    "review": { "label": "Review", "goal": "Find what is risky in the area, and why",
                "members": { "reviewer": { "label": "Reviewer", "brief": "A careful reader who checks each claim in the code", "kind": "planning",
                                           "models": [{ "model": "claude-code/claude-opus-5-5", "effort": "high" }] } } }
  },
  "steps": [
    { "id": "review", "label": "Review the area", "teams": ["review"] },
    { "id": "report", "label": "Report and ask", "stop": "always" }
  ]
}
```
