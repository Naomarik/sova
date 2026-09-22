<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/sova-mark-dark.svg">
    <img src="docs/brand/sova-mark-light.svg" alt="" width="72" height="72">
  </picture>
</p>

# sova

**Run pi sessions side by side. Stop juggling terminals.**

Send one prompt to several models, compare their approaches, and branch the conversation worth
pursuing. Sova gives your [pi](https://pi.dev) coding agent a browser interface—from a full desktop
workspace to your phone—using the sessions you already have.

It runs on your machine alongside pi. Read the tool calls, inspect the diffs, and follow the
work without digging through terminal scrollback. Your existing setup stays yours.

## Get started

Requires Git, Node.js ≥22.19, and npm.

```sh
curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/v0.1.0/scripts/install.sh | bash
```

Then run `sova` and open **http://127.0.0.1:4800**. Uses your existing pi provider login.
[First-time login or command not found?](docs/getting-started.md)

## More work, less window switching

- **Try several approaches at once.** Start parallel sessions with different models, send a shared
  prompt, and compare answers side by side. Fork from the same conversation or start fresh.
- **Change direction without starting over.** Fork a conversation, rewind to an earlier message,
  or steer a running web chat. Switch models, attach files, and keep going with the context you built.
- **Keep your terminal. Get another window.** Browse existing sessions without importing them;
  watch terminal sessions live and read-only in your browser or on your phone.
  [Terminal presence and phone access](docs/getting-started.md#terminal-and-phone-access) need setup.
- **See what your agents are doing.** Follow workers and coordinated teams down to their individual
  transcripts with the optional [subagents extension](pi-config/extensions/subagents/README.md).
- **Work beyond your laptop.** The optional [remote extension](pi-config/extensions/remote/README.md)
  runs session tools on your configured SSH, AWS SSM, Docker, or Incus targets.

Single-user, loopback by default, no built-in authentication. Protect access before exposing it
beyond your machine. Model requests go to your configured provider; tools and extensions may also
use the network.

## Make it yours

[Setup and safe access](docs/getting-started.md) ·
[Themes, models, and optional extensions](docs/customization.md) ·
[Development](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE) · [NOTICE](NOTICE).
Bundled fonts include their own licenses in [public/fonts/](public/fonts/);
[pi-config](pi-config/LICENSE) is licensed separately.
