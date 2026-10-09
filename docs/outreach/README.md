# Outreach

[← Sova](../../README.md)

Outreach is how Sova reaches a person on an organization's roster outside Sova. It sends them a
WhatsApp message with a link, a short note, or both. The link can be their own link to a gathering
(the `/h/` link of a hand-off) or their own link to one of the project's public previews, so you
don't have to copy either into a chat by hand. The layer is channel-generic, so email or Slack can be
added later; WhatsApp is the first and only channel now.

- **Setting up WhatsApp:** [whatsapp.md](whatsapp.md), a from-scratch guide to the sender.
- **The sender's protocol:** [services/whatsapp/IPC.md](../../services/whatsapp/IPC.md).

## How it fits together

```
you, an overseer (see below) ──▶ Sova: the project's send act ──▶ the WhatsApp channel
                                                                            │ Unix socket, or through
                                                                            ▼ the gateway's Sova
                                                                sova-whatsapp (the sender) ──▶ WhatsApp
```

- **Sova** decides who gets what: it makes a fresh link for the person in the same step (a send
  names the gathering or preview, never a URL), writes the message, and hands it to a channel. The
  message is the note if there is one, else a fixed line with your name (and the gathering's public
  title), then the link. A note is at most 500 characters, and one that repeats private text or a
  roster contact is refused. No model ever sees the link, a token or a number.
- **A preview link** sent to someone is their own copy of the preview: same port, expiring when the
  original does (never later), turned off with it, and listed with the previews as "sent to {name}"
  so you can turn off just theirs. The log keeps its `pv_` id, never its URL.
- **The sender** (`services/whatsapp`) is a separate, small program that holds the one WhatsApp
  connection of one number, as a linked device of your phone. It runs on one always-on host; every
  other Sova host sends through that host's Sova, picked from Settings → Outreach's list of the
  senders it can use (each with its number's last 3 digits, its state and its sends against the
  limits). Sova never restarts or stops it. Settings → Outreach shows its state live and, when you
  ask, reconnects it, pauses or resumes it, or starts its stopped service once; on the sender's own
  host only, **Link a Phone** pairs it (a QR on the page, or a pairing code) and **Unlink This
  Number** logs it out and deletes its keys, after you type UNLINK
  ([whatsapp.md](whatsapp.md#4-pair)). No other host and no agent can link or unlink it. While it is
  down, Needs you says so, and a send is refused at once with the why.

## Who may send

- **You**, with **Send on WhatsApp** on a gathering's strip (where Sova shows "Send {name} their
  link"). It goes at once.
- **The global Overseer**, only in the turn your click on its confirm card opened, for the people
  and sessions that card lists. It goes at once.
- **A project overseer** at level L1 or above. In a turn you started, it goes at once. In its own
  runs (the watch, Look Now), each message waits in the project's hold, where you can cancel it; with "Messaging a person on WhatsApp" among the kinds it
  must confirm (on by default) it waits for that review too, and it goes only in the person's
  working hours. One that comes due while WhatsApp is down waits there for WhatsApp to come back,
  at most 24 hours; then it is not sent, and Needs you says so.
- A gathering's own model never sends.

There is no consent switch: everyone on a roster agreed to be contacted when they were added.
Replies are not read: the sender drops incoming messages unread, and people answer through the link.

## What is kept, and where

- **In the organization's workspace**, `outreach.jsonl`: one line per send and receipt (when, who,
  which project, gathering or preview, who sent it, sent / delivered / read / failed / refused /
  unknown). Never a number, a link, a token, a message id, the message or the note. `unknown` means
  the message left and no answer came back (a timeout, a dropped connection, a Sova restart mid-send):
  it may have arrived, so the link it carried is kept, and it is never sent again on its own. A
  person's page lists these under **Sent on WhatsApp**.
- **On the host that sent**, a short-lived map from WhatsApp's message reference to that line, so
  receipts find their send.
- **In the sender's directory**, its credentials (the linked device: keep it secret, see
  [whatsapp.md](whatsapp.md#7-protect-the-credentials)), its reconnect budget and send counts, and
  which idempotency keys were sent. No number and no message.

## Limits

The number's limits live in the sender, shared by every host that sends through it: by default one
send every 3 seconds at most, 20 an hour, 60 a day. Settings → Outreach can pause all sending from
a host, or, on the sender's host, pause the sender itself for every host. See
[whatsapp.md](whatsapp.md#9-operate).
