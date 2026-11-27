---
title: Check in from your phone
description: Reach Sova from your phone over your tailnet or a network you trust, pair it with a one-use code, and follow sessions that are open in a terminal.
group: Features
order: 13
---

Sova is one web app at every width. On a phone, or a folded foldable, it shows one column: the session list or a session. From there you can answer a question, steer a turn, or start a session, the same as at your desk. To give a long reply the whole screen, press [**Focus**](/docs/change-direction/#focus-on-the-conversation) at the transcript's bottom right: the header's chips and the composer go away until you press it again, and your draft is kept.

## Reach Sova from your phone

Sova listens only on `127.0.0.1`, port 4800 by default, so at first only the machine it runs on can open it. To reach it from a phone:

- **Your tailnet.** Serve it with `tailscale serve`. Sova answers any `*.ts.net` name, even with Mesh off. This is the address the pairing QR points at first.
- **A network you trust.** On the Access page, the **Networks** card lists this computer's VPNs (WireGuard, ZeroTier, NetBird, Nebula, or plain "VPN" with its interface name), then its Wi-Fi and wired networks. Press **Trust…** on one, or type a private range such as `10.224.0.0/22` under **Add a range** and press **Trust Range…**, then confirm. Sova then also answers at this computer's address on that network, to devices inside the range alone; every other device is cut off before it sees a page. Every device there still pairs once with a code. Trust lasts until you press **Stop Trusting**, which cuts that network's connections at once.
- **Your own HTTPS proxy.** Add the proxy's host name to `SOVA_ALLOWED_HOSTS` and its origin to `SOVA_ALLOWED_ORIGINS` when you start Sova. Sova refuses a host name it doesn't know, even with the right token.

Phone notifications need an HTTPS address: your tailnet's or your proxy's. A trusted network's address is plain HTTP, so there the phone gets no notifications, can't install Sova as an app, has no voice input, and some Copy buttons don't work. See [Needs you](/docs/needs-you/#on-your-lock-screen).

Only trust a Wi-Fi or wired network you control, such as your home's. Sova's traffic there is readable by anyone on that network, including the sign-in, which never expires.

## Let your phone in

A browser on the machine Sova runs on, opening Sova's own address, just gets in. Every other browser needs the install's access token once. Your phone doesn't have to see that token: an unlocked browser makes a **pairing code** that the phone trades for its own sign-in.

1. In Sova on your computer, open the Overview and choose **Access**.
2. Press **Make a Code**. The code expires in 5 minutes and works once.
3. Scan the QR with your phone's camera. It opens Sova at the address under **QR points at** with the code, and the phone is in.

**QR points at** lists Tailscale, every network you trust, and the address the page is open at when another device can reach it. Pick one and the QR is redrawn for it; the same code works at all of them, and the page remembers your pick. A trusted network's QR opens only on a device connected to that same network: a privacy VPN such as Mullvad doesn't connect your devices to each other, so it won't work there. If the phone still can't open it, check this computer's firewall.

No camera handy? Each address the code works at is listed with a **Copy Link** button, the phone's tailnet address ("Phone · Tailscale") first, then each trusted network's ("Phone · WireGuard · wg0", say). You can also open Sova on the phone and type the code on its unlock screen: under "What are you pasting?", choose **Pairing code** (the screen starts on Access token).

The QR is drawn only for an address another device can open. With none, the page says "No address here can be opened from another device." Open Sova at its tailnet address, or trust a network under **Networks**, then make another code. Keep the QR and its links private until they're used.

Each address of Sova needs its own sign-in: `127.0.0.1`, `localhost`, your tailnet name, and a trusted network's address are separate. A code works at any of them.

## Add it to your Home Screen

Sova installs as an app: add it to your phone's Home Screen, or install it from your browser. On iPhone and iPad this is required for notifications, and the app's icon can show how many sessions need you.

## Sessions you started in a terminal

Sessions you already run in pi's terminal UI show up in Sova as they are: Sova reads the same session files, so there's nothing to import.

While a terminal has a session open, its row and its header carry a **TUI** chip, and Sova streams it live. It's read-only here: the composer says "Read only while this session is open in the TUI.", and Rewind and the other actions that would write to it are off. You can still read it, copy from it, and share it.

When the terminal closes the session, Sova says "The TUI closed this session." Press **Open for Chat** to carry on in Sova.

## Signed in for good, until you say otherwise

Once in, a browser stays signed in. There's no password and no expiry. To sign every browser and phone out at once, delete `~/.pi/agent/sova/auth-token` and restart Sova; it makes a new token and every old sign-in stops working.

If pairing itself is broken, the Access page can show the install's token behind a second step, to paste into the phone's unlock screen as **Access token**. It's a long-lived credential with full access, so reveal it only if you need it.
