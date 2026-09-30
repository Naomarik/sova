# Outreach

[← Sova](../../README.md)

Outreach is how Sova reaches a person on an organization's roster outside Sova. Today it does one
thing: it sends a person their gathering link (the `/h/` link of a hand-off) on WhatsApp, so you
don't have to copy it into a chat by hand. The layer is channel-generic, so email or Slack can be
added later; WhatsApp is the first and only channel now.

- **Setting up WhatsApp:** [whatsapp.md](whatsapp.md), a from-scratch guide to the sender.
- **The sender's protocol:** [services/whatsapp/IPC.md](../../services/whatsapp/IPC.md).

## How it fits together

```
you, or the Overseer after your confirm ──▶ Sova: the send-link act ──▶ the WhatsApp channel
                                                                            │ Unix socket, or through
                                                                            ▼ the gateway's Sova
                                                                sova-whatsapp (the sender) ──▶ WhatsApp
```

- **Sova** decides who gets what: it mints a fresh link for the person, writes the message, and
  hands it to a channel. The message is fixed text with your name, the gathering's public title and
  the link; never anything a model wrote.
- **The sender** (`services/whatsapp`) is a separate, small program that holds the one WhatsApp
  connection of one number, as a linked device of your phone. It runs on one always-on host; every
  other Sova host sends through that host's Sova. Sova never starts, pairs or unlinks it.

## Who may send

- **You**, with **Send on WhatsApp** where Sova shows "Send {name} their link". It goes at once.
- **The global Overseer**, only in the turn your click on its confirm card opened, for the people
  and sessions that card lists. It never sees the link, the token or the number.
- A gathering's own model never sends. Project overseers don't send yet.

There is no consent switch: everyone on a roster agreed to be contacted when they were added.
Replies are not read: the sender drops incoming messages unread, and people answer through the link.

## What is kept, and where

- **In the organization's workspace**, `outreach.jsonl`: one line per send and receipt (when, who,
  which session, sent / delivered / read / failed / refused). Never a number, a link, a token, a
  message id or the message.
- **On the host that sent**, a short-lived map from WhatsApp's message reference to that line, so
  receipts find their send.
- **In the sender's directory**, its credentials (the linked device: keep it secret, see
  [whatsapp.md](whatsapp.md#7-protect-the-credentials)), its reconnect budget and send counts, and
  which idempotency keys were sent. No number and no message.

## Limits

The number's limits live in the sender, shared by every host that sends through it: by default one
send every 3 seconds at most, 20 an hour, 60 a day. Settings → Outreach can pause all sending from
a host. See [whatsapp.md](whatsapp.md#9-operate).
