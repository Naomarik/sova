---
title: Needs you
description: The sidebar list of sessions waiting on you, and the same news on your phone's lock screen.
group: Features
order: 11
---

**Needs you** sits at the top of the session list, above Recent. It lists the sessions that are blocked on you right now. With phone notifications on, the same news reaches your lock screen, even with Sova closed. Neither one makes a model call or costs tokens.

## What counts as needing you

A session is listed when one of these holds:

- A dialog is open in it, waiting for your answer.
- Its last turn stopped with an error.
- One of its subagents ended in an error.
- It's idle with open alignment questions, and its branch isn't merged yet.
- A baton hand-off is waiting on you.

Some things are worth a look but don't block anything, so they never get a row here: a reply that seems to ask you something, a team that has gone quiet, a stuck subagent, or a worktree that's ready to merge. Those show as a quiet mark on the session's own row instead. A [scheduled playbook](/docs/playbooks-and-schedules/) can act on branches ready to merge for you: the Merge round wakes when one turns ready, asks its owner, and lands it.

A subagent you killed yourself isn't listed, and neither is one that ended only because the Sova server restarted. A subagent error stops counting once you've opened the session, or once the session has finished a turn since.

## How the list reads

- **One row per session**, newest first, however many things it's waiting on.
- **The second line says why**, in place of the session's summary: "3 open questions in al_3 Autonomy settings", "Waiting on a dialog.", "1 subagent ended in an error." Hover the row for every reason it has.
- **A shortcut, not a place.** Every session listed here is still in Recent, its group, or the Archive. Nothing on the list puts a row away: it goes when the thing it waits on is done.
- **Only while it has rows.** An empty list isn't shown at all, so the list appearing is the signal. You can collapse it; a search opens it again so every hit shows.
- **Refreshed every 10 seconds** while the tab is visible, and at once when you come back to it.

Organization sessions wait in the Organizations section's own Needs you, not in this one. The Overseer counts them too, so its "need you" number can be higher than this list's.

## Proactivity

The Overseer's **Proactivity** setting decides what happens with this news. Set it on the Overseer page or in Settings → Overseer:

| Mode | What you get |
|---|---|
| Off | No Needs you list. The Overseer chat still works. |
| List Only (default) | The Needs you list. No messages from the Overseer, and no tokens spent. |
| Brief Me | The list, plus an Overseer message when something new needs you, at most once every 10 minutes. |

Phone notifications work under every mode, Off included, and don't need the Overseer at all.

## On your lock screen

Sova can tell your phone, or any browser, that a session needs you while no Sova page is open. It uses the browser's own Web Push service: your phone doesn't need to reach Sova to receive a notification, only to open it.

### Before you start

- Sova has to be on a secure address: `https://`, or `http://localhost`. To reach it from a phone, serve it on your tailnet with `tailscale serve`, or put your own HTTPS proxy in front of it.
- On iPhone and iPad (iOS 16.4 and later), add Sova to your Home Screen first, and turn notifications on from the app you added. Safari in a tab can't subscribe.
- Android and desktop browsers work installed or in a tab.
- A subscription belongs to one address. The same phone opening Sova at another address is another device.

### Turn it on

Open **Settings → Notifications**:

1. Fill in **Contact address**, a `mailto:` address or an `https://` URL. The push services use it to reach whoever runs the server, and nothing is sent without one.
2. Press **Enable on This Device** and allow notifications when your browser asks.
3. Press **Send Test** to check. It reaches every device you added and says which ones failed.

The same tab lists your devices with when each was added and its last delivery or error, and **Remove** takes one off. You can also switch off whole kinds (Needs input, Open questions, Error, Baton, Subagent error, Playbook needs you; Subagent error starts off) and set **Quiet hours**, 22:00 to 07:00 by default.

### What arrives

- **Once per problem.** Each blocker is sent at most once until it clears. If it clears and comes back, it's new again.
- **Nothing old.** What was already waiting when the server started is never sent.
- **Nothing you're looking at.** A session open in a Sova page right now isn't sent.
- **Dropped, not held.** Anything that arrives during quiet hours, or while a kind is off, is dropped. Nothing arrives in a burst when quiet hours end.
- **Grouped.** Sends are at least 30 seconds apart; what arrives in between goes out together. One session reads "{Kind} · {session name}" with the reason underneath, and a newer notification for that session replaces the older one. Several read "3 sessions need you", one line each.
- **Secrets hidden.** Titles and text pass through Sova's redactor before they're encrypted, since they show on a lock screen.

Tapping a notification opens that session, or the Overseer when several need you. Where your browser supports app badges, the installed app's icon shows how many sessions need you.
