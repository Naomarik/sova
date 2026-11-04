# tools: a new tool for the agent to call, and how it gets approved

Recommend a project tool first: it asks before it turns on, stops if its files change, and belongs to one project. Offer an add-on tool only when the person asks for a tool in every chat, and say first that it asks nothing and runs with full access. Don't offer an add-on kept in a project. If they name MCP, say it isn't supported yet and offer a project tool.

No tool or add-on you make restarts or updates Sova: that stays the person's, under Settings → General.

## Project tool

- Change: a program of the project that the agent can call by name, on in one chat at a time, from one project mode.
- Lives: in the project, in `<project>/.sova/minor-modes/<id>/`: `MODE.md` declares the tool, and the program sits beside it. A chat in a worktree sees the modes on its own branch.
- Approves: the person, with Approve and Turn On in that chat's mode menu, after reading each command line. The Overseer's turning a mode on also counts as approval of its tools. Every other caller is refused, you included: stop and name the click. Approval covers every file in the folder but `MODE.md`, and each checkout asks once for each version.
- By: Land. The folder is made on a branch. If a worker makes it, copy the rules paragraph and the whole example below into its brief, word for word: it sees nothing else of this entry. With no queue the person merges it, and with no Git the change is made by hand.
- Live: in the mode menu the next time it's opened in a chat on that checkout; the tool reaches the agent on its next run after the person turns the mode on. If a file in the folder changes, the tool stops until the person turns the mode off and on and approves again. Editing only the instructions in `MODE.md` doesn't ask again, and reaches the chat at that off and on.
- Check: you can't see the mode menu, and running the program by hand proves only the program, so don't say it's ready. When you tell the person to turn it on, add: "If its row reads Can't turn on, send me its words." Then fix the file from those words. Once on, the agent sees the tool as `<id with - as _>__<name>`; call it.

Limits to say before they agree: it refuses to run while the chat's sandbox is On. It has no project modes on a remote machine, in the Overseer's chat or in gathering chats. It runs with the chat's own reach, not walled off. A bare program name such as `node` is the computer's own and approval doesn't cover it. A worker gets it only with `workers: yes`.

The rules: an id is lowercase letters, digits and hyphens, at most 30, and can't be `align`, `spec`, `vis` or `memory`. A tool's name is lowercase words joined by single underscores, at most 32. `MODE.md` allows only `description`, `workers`, `tools`, `commands` and `hooks`, and needs instructions after the frontmatter. Its frontmatter is `key: value` lines, not YAML: when `tools` spans several lines, every line after the first must start with a space, the closing `]` included. A `]` at the start of a line stops the mode turning on. In `command`, every element with a `/` must be a `./` path to a file in the mode folder. `timeoutS` is 1 to 600, default 60. Arguments arrive as JSON on standard input, the program runs in the chat's folder, and its exit code, output and errors go back to the agent, each cut at 256 KB.

A complete example, `<project>/.sova/minor-modes/todo-count/MODE.md`:

```markdown
---
description: Count the TODO lines in a file
tools: [
  {
   "name": "count",
   "description": "Count the lines holding TODO in one file. Pass its path relative to the chat's folder.",
   "params": {
    "type": "object",
    "properties": { "file": { "type": "string", "description": "The file to read" } },
    "required": ["file"]
   },
   "command": ["node", "./count.mjs"],
   "timeoutS": 10
  }
 ]
---

When the person asks how many TODOs a file has, call todo_count__count with that file.
```

And `count.mjs` beside it:

```js
// The call's arguments arrive as JSON on standard input; the working folder is the chat's folder.
import { readFileSync } from "node:fs";
const { file } = JSON.parse(readFileSync(0, "utf8"));
const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.includes("TODO"));
console.log(`${file}: ${lines.length} TODO lines`);
```

## Add-on tool for all your chats

- Change: a tool in every ordinary chat on this computer, from a pi extension in the person's own folder. Offer it only when they ask for that reach.
- Lives: `<agent dir>/extensions/<name>.ts`, where the agent dir is `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. Check first that the path doesn't link into Sova's own folder.
- Approves: nobody. Sova never asks, and the person's OK on the file is all there is. Say before that OK: it runs inside each chat with the person's full access, the sandbox doesn't confine it, it can read prompts and credentials, and a profile can't take it away.
- By: OK.
- Live: new chat. This chat and every other open chat keep what they started with, so never promise the tool here.
- Check: start a new chat and look for the tool in the Tools group of its setup card, or ask that chat to call it.

Workers, the Overseer, Project Overseers, gathering chats and the Project Assistant don't get it. A sandboxed chat can't write this folder.

A complete example, `<agent dir>/extensions/count-lines.ts`:

```js
export default function (pi) {
  pi.registerTool({
    name: "count_lines",
    label: "Count lines",
    description: "Count the lines of a text the agent passes in.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_callId, params) {
      const count = params.text.split("\n").length;
      return { content: [{ type: "text", text: `${count} lines` }], details: { count } };
    },
  });
}
```

## One worker's tools

- Change: which tools one worker has, or which add-ons it loads, for that worker alone.
- Lives: in the worker's start request, as its `tools` and `extensions`. `tools` lists built-ins, and an empty list means none. `extensions` takes a path, `npm:name` or `git:...` that's already installed.
- Approves: the chat that starts the worker, and the person by asking for it. Model limits and the sandbox still hold.
- By: None. No screen or file sets this: the person says it in the chat, and you put it in that worker's start request.
- Live: that worker, from its start.
- Check: the worker's view in the Subagents pane.

## MCP servers

- Change: nothing yet. Sova doesn't support MCP servers, so they don't reach a chat.
- Lives: nowhere in Sova.
- Approves: nobody: there's no change to approve.
- By: None. Say MCP isn't supported yet. The nearest way is a project tool whose program calls the service. Don't suggest an add-on or a setting that tries to load MCP.
- Live: never, today.
- Check: there's nothing to check.

## Add-on kept in a project

- Change: nothing you offer. An add-on in a project's `.pi/extensions` would run in every chat in that folder with no approval, so Create doesn't make one.
- Lives: not offered.
- Approves: nobody would, which is why it isn't offered.
- By: None. Offer a project tool, or an add-on tool for all the person's chats.
- Live: not offered.
- Check: there's nothing to check.

## A tool that runs inside Sova's server

- Change: nothing. Sova's server tools come only from Sova's own code.
- Lives: Sova's own code, which you never change.
- Approves: nobody: there's no change to approve.
- By: None. The nearest way is a project tool.
- Live: never, today.
- Check: there's nothing to check.
