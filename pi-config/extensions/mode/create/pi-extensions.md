# pi-extensions: add-ons that change what a chat can do, from a file or a package

An add-on is a pi extension: code that loads inside every ordinary chat on this computer. Say this before the person agrees: Sova asks nothing, it runs with their full access, the sandbox doesn't confine it, and it can read prompts and credentials. For a tool the agent calls, open `tools` first: a project tool is the recommended way. For something that runs after every reply in one project, open `modes` first: its reply hooks are the recommended way, and they only report, so an add-on is for what must block or change a chat. Offer add-ons only for the person's own folder, never in a project's `.pi/extensions`.

## Add-on from a file

- Change: event handlers, guards that block or rewrite a tool call, and other chat behaviour, in every ordinary chat on this computer.
- Lives: `<agent dir>/extensions/<name>.ts`, or `<agent dir>/extensions/<name>/index.ts`, where the agent dir is `$PI_CODING_AGENT_DIR`, else `~/.pi/agent`. Check first that the path doesn't link into Sova's own folder.
- Approves: nobody. The person's OK on the file is all there is.
- By: OK.
- Live: new chat. This chat and every other open chat keep what they started with, so never promise it here.
- Check: start a new chat and do the thing it changes.

Workers, Project Overseers, gathering chats and the Project Assistant don't load it, and the Overseer can't use its tools. A sandboxed chat can't write this folder.

What works in a Sova chat: tools, slash commands, events, and the dialogs `select`, `confirm`, `input` and `editor`, with `notify` and `setStatus`. Widgets, footers, headers, custom overlays and editor components do nothing in Sova.

A complete example, `<agent dir>/extensions/no-env-read.ts`, which stops the agent's `read` tool opening `.env` files. It doesn't stop `bash`, unless the add-on checks that too:

```js
export default function (pi) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "read" && String(event.input.path).endsWith(".env")) {
      return { block: true, reason: "This add-on keeps .env files out of chats." };
    }
  });
}
```

## Slash commands

- Change: a `/word` the person types in a chat.
- Lives: the same add-on file, through `pi.registerCommand`. For text that needs no code, offer a template or skill instead (`skills`).
- Approves: nobody.
- By: OK.
- Live: a new chat, in its composer menu.
- Check: type `/` in a new chat and find it. A command that opens a terminal overlay reads `needs the terminal UI` in Sova, so don't build on one.

A complete example, `<agent dir>/extensions/hello.ts`:

```js
export default function (pi) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

## Packages

- Change: a bundle of add-ons, skills, templates or themes from npm or git.
- Lives: `packages` in `<agent dir>/settings.json`. A package's own files stay in pi's package folder.
- Approves: nobody. A package runs code, so say that first and have the person review the source.
- By: Terminal. The person runs `pi install npm:<name>@<version>`, or `pi install git:<source>`, and `pi remove <source>` to take it out. If `pi` isn't on their PATH, it's in `node_modules/.bin` in the folder Sova is installed in. Never add a package to a project's `.pi/settings.json`.
- Live: new chat.
- Check: `pi list` shows it, and a new chat has what it adds.

## A model provider from code

- Change: a provider or models Sova doesn't list, kept in the person's own folder, which is the way when `models.json` links into Sova's folder.
- Lives: an add-on file calling `pi.registerProvider`. The key stays out of the file: use the name of an environment variable the person sets themselves.
- Approves: nobody. The person's OK on the file is all there is.
- By: OK.
- Live: restart. A new chat alone doesn't get it: until Sova restarts the model isn't listed, and picking it is refused as an unknown model. The person restarts Sova under Settings → General. Then it's in every chat.
- Check: after the restart, the model appears in the model picker and in Settings → Models.

A complete example, `<agent dir>/extensions/my-models.ts`, for a service that speaks the OpenAI API:

```js
export default function (pi) {
  pi.registerProvider("my-models", {
    baseUrl: "https://models.example.com/v1",
    apiKey: "$MY_MODELS_KEY",
    api: "openai-completions",
    models: [
      {
        id: "my-model",
        name: "My Model",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ],
  });
}
```

## Turning one off

- Change: stop an add-on loading.
- Lives: the same folder.
- Approves: the person, by their OK.
- By: OK. Show which file you'll move out of the folder or delete. Sova has no switch for add-ons on any screen.
- Live: new chat.
- Check: a new chat no longer has what it added.

## Add-on kept in a project

- Change: nothing you offer. It would run in every chat in that folder with no approval, even in a repository the person just cloned.
- Lives: not offered.
- Approves: nobody would, which is why it isn't offered.
- By: None. Offer a project tool, or an add-on in the person's own folder.
- Live: not offered.
- Check: there's nothing to check.
