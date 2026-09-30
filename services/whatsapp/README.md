# sova-whatsapp

Sova's WhatsApp sender: one linked device of one WhatsApp number, one long-lived
[Baileys](https://github.com/WhiskeySockets/Baileys) connection, served to Sova over a local Unix socket.

- Set it up: [docs/outreach/whatsapp.md](../../docs/outreach/whatsapp.md)
- Protocol: [IPC.md](IPC.md)

It is its own pnpm project (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`), outside Sova's
workspace, and imports nothing from Sova. pnpm only:

```sh
pnpm install --frozen-lockfile
node bin/sova-whatsapp.mjs check-config
pnpm test          # the state machine, config, IPC, CLI refusals and the console guard; no network
```

| File | What |
|---|---|
| `bin/sova-whatsapp.mjs` | The CLI: `run`, `pair`, `status`, `unlink`, `check-config`. Loads the console guard first. |
| `src/core.mjs` | The state machine: states, reconnect budget, limits, idempotent sends, receipts. No Baileys. |
| `src/baileys.mjs` | The only Baileys code: opens the socket, adapts it to the core's driver shape. |
| `src/ipc.mjs` | IPC v1 server and a small client. |
| `src/config.mjs` | Settings (env, `config.json`, defaults) and the refusals (modes, git work tree, socket length). |
| `src/store.mjs` | `state.json` and `events.json`, 0600, atomic. |
| `src/log.mjs`, `src/quiet-console.mjs` | The redacting logger, and the guard that drops dependencies' console output (libsignal prints private keys). |
| `sova-whatsapp.service.example` | A systemd user unit template. |

`scripts/fake-whatsapp-sender.mjs` (at the repository root) runs `src/core.mjs` and `src/ipc.mjs`
over a fake WhatsApp for Sova's hermetic tests.
