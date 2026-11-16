# what: what a playbook is, and the files in its folder

A playbook is a folder. Its id is the folder's name.

```
<id>/
  PLAYBOOK.md      the recipe: head lines, then the main chat's method
  playbook.json    optional: choices, cast, steps and how it runs
  roles/<role>.md  one prompt per helper, with {{choice}} slots
  phases/<step>.md read when a step begins
  references/      checklists, worked examples
  scripts/         programs the agent runs (Sova never runs them)
```

`PLAYBOOK.md` starts with `key: value` lines between `---` fences, one line each, not YAML: `title`, `description` and `promptHint` (the composer's hint). Keep its body short: the main chat reads it every run, so detail goes in `phases/` and `references/`.

Without `playbook.json`, picking the playbook sends its recipe into the chat as the person's message: nothing else changes. With one, `/<id>` or picking it in the Playbooks list opens its card instead.

There are three shelves: Sova's own, the person's (`<agent dir>/sova/playbooks/`, where an id replaces Sova's of the same name) and the project's (`.sova/playbooks/`).

## playbook.json

Parsed strictly: every key must be known and every value the right type, or the Playbooks list shows the exact error (the file and the key) instead of the card. Its keys:

| Key | What |
|---|---|
| `version` | `1` |
| `listed` | `false` hides it from the Playbooks list and the `/` rows, for a playbook only Sova's own chats start; default `true` |
| `run` | how it runs: `where` (`this-chat` or `new-chat`), `worktree` (`none` or `new`), `mode` (`normal` or `delegate`), `minorModes`, `permissions` (an automation file's shape; it always runs in a new chat), `needs` (`project`, `merge-queue`) |
| `inputs`, `facts` | the person's choices, and facts shown beside them (section `choices`) |
| `roles` | the cast (section `cast`) |
| `steps` or `machine` | the flow (section `steps`), never both |
| `commands` | the Sova commands that change things it uses (section `commands`) |

A small one, whole:

```json
{
  "version": 1,
  "inputs": [{ "id": "area", "label": "Which area", "type": "text", "required": true }],
  "roles": {
    "reviewer": { "label": "Reviewer", "prompt": "roles/reviewer.md", "kind": "planning",
                  "models": [{ "model": "claude-code/claude-opus-5-5", "effort": "high" }] }
  },
  "steps": [
    { "id": "review", "label": "Review the area", "roles": ["reviewer"] },
    { "id": "report", "label": "Report and ask", "roles": ["main"], "stop": "always" }
  ]
}
```
