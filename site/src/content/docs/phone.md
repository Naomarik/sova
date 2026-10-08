---
title: Check in from your phone
description: Reach Sova from your phone over your tailnet, pair it with a one-use code, and follow sessions that are open in a terminal.
group: Features
order: 13
---

Sova is one web app at every width. On a phone, or a folded foldable, it shows one column: the session list or a session. From there you can answer a question, steer a turn, or start a session, the same as at your desk.

## Reach Sova from your phone

Sova listens only on `127.0.0.1`, port 4800 by default, so at first only the machine it runs on can open it. To reach it from a phone:

- **Your tailnet.** Serve it with `tailscale serve`. Sova answers any `*.ts.net` name, even with Mesh off. This is the address the pairing QR points at.
- **Your own HTTPS proxy.** Add the proxy's host name to `SOVA_ALLOWED_HOSTS` and its origin to `SOVA_ALLOWED_ORIGINS` when you start Sova. Sova refuses a host name it doesn't know, even with the right token.

Phone notifications need one of those HTTPS addresses. See [Needs you](/docs/needs-you/#on-your-lock-screen).

## Let your phone in

Every browser needs the install's access token once. Your phone doesn't have to see that token: an unlocked browser makes a **pairing code** that the phone trades for its own sign-in.

1. In Sova on your computer, open the Overview and choose **Access**.
2. Press **Make a Code**. The code expires in 5 minutes and works once.
3. Scan the QR with your phone's camera. It opens Sova's tailnet address with the code, and the phone is in.

No camera handy? Each address the code works at is listed with a **Copy Link** button. You can also open Sova on the phone and type the code on its unlock screen, choosing **Pairing code** under "What are you pasting?".

The QR is shown only when a phone can actually open the link: if the page you're on can't name a tailnet address, it says to open Sova at that address and make another code. Keep the QR and its links private until they're used.

Each address of Sova needs its own sign-in: `127.0.0.1`, `localhost`, and your tailnet name are separate. A code works at any of them.

## Add it to your Home Screen

Add Sova to your phone's Home Screen to run it as an app. On iPhone and iPad this is required for notifications, and the app's icon can show how many sessions need you.

## Sessions you started in a terminal

Sessions you already run in pi's terminal UI show up in Sova as they are: Sova reads the same session files, so there's nothing to import.

While a terminal has a session open, its row and its header carry a **TUI** chip, and Sova streams it live. It's read-only here: the composer says "Read only while this session is open in the TUI.", and Rewind and the other actions that would write to it are off. You can still read it, copy from it, and share it.

When the terminal closes the session, Sova says "The TUI closed this session." Press **Open for Chat** to carry on in Sova.

## Signed in for good, until you say otherwise

Once in, a browser stays signed in. There's no password and no expiry. To sign every browser and phone out at once, delete `~/.pi/agent/sova/auth-token` and restart Sova; it makes a new token and every old sign-in stops working.

If pairing itself is broken, the Access page can show the install's token behind a second step, to paste into the phone's unlock screen as **Access token**. It's a long-lived credential with full access, so reveal it only if you need it.
