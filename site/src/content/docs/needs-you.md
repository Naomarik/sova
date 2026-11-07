---
title: Needs you
description: The sidebar list of sessions waiting on you, and the same news on your phone's lock screen.
group: Features
order: 11
---

**Needs you** sits at the top of the session list, above Recent. It lists the sessions that are blocked on you right now and, under them, the ones that may be waiting on you. With phone notifications on, the blockers reach your lock screen too, even with Sova closed. Neither one makes a model call or costs tokens of its own. The guesses in the softer group come from the short check Sova runs on each finished turn.

## What counts as needing you

A session is listed when one of these holds:

- A dialog is open in it, waiting for your answer.
- Its last turn stopped with an error.
- One of its subagents ended in an error.
- It's idle with open alignment questions, and its branch isn't merged yet.
- A baton hand-off is waiting on you.
- One of its tour recordings is waiting for you to sign in to a site, on the tour card.
- A playbook run proposes a branch to merge. Its row carries a **Merge Branch** button.
- A card in its chat waits for your answer, such as an option card or a question card.

A session with a waiting card and open alignment questions too still reads as a question: answering the card doesn't answer the alignment.

A project's failed deploy or open deploy request, its release items (a release ready to publish, a step held for you, a failed step or Publish, a release chat that has gone quiet, or a request to release), and a WhatsApp sender that stopped sending, belong to no session: they list under the session rows as rows of their own, each opening the page where you deal with it (the Deploy panel, the Releases tab, Settings → Outreach). So does each open request an organization's owner files through its Project Assistant. A report, question or request opens the organization's **Requests** tab at it, and stays until work on it starts or you **Mark Done** or **Decline** it. A request to try a version opens the project's **Branches** tab, and an ask for a new owner link opens the **People** tab.

Under the blockers, a softer group named **Maybe waiting on you** lists Sova's guesses from a chat's last reply: a reply that seems to wait on you, or one that says it's done without checking. A guess never sends a phone notification. It goes when the next turn replaces it or the chat is archived, or after 7 idle days. A reply asking you to press Land, merge or restart also leaves on its own while that version is in the merge queue, comes back if the entry is cancelled or stops short, and leaves for good once that version has landed. A newer change with a new ask stays listed.

Some things are worth a look but don't get a row here: a team that has gone quiet shows as a quiet mark on the session's own row, and a worktree that's ready to merge shows on the row's branch status (a green check and how many are ready, the same status the chat shows beside its composer). A worktree ready to land waits for you: it lands once you press **Land** (beside the composer, in the session's Worktrees section, or on the project's Merge Queue tab) or type "land it" in its chat, through the project's merge queue.

A subagent you killed yourself isn't listed. A server restart ends no subagent, since each runs in a process of its own, so a subagent error is always a real one. A subagent error stops counting once you've opened the session, or once the session has finished a turn since.

## How the list reads

- **One row per session**, newest first within each group, however many things it's waiting on.
- **Every row reads the same**, whatever it is about, in two lines: the project's or folder's name with a state word, then the title (the session's, or what the item is, such as "Deploy failed"). The reason ("3 open questions in al_3 Autonomy settings", "Waiting on a dialog.", "429 rate limited") is hover text on the row, with every reason it has. On a phone, open the row to see why. Two projects with the same name are told apart by a bit of their folder path.
- **The whole row is one link.** The buttons on a row are the **×** on a chat's row (see [Dismiss](#dismiss)), **Merge Branch** on a proposed playbook run and **Cancel** on an act the Overseer holds; pressing one doesn't navigate.
- **A shortcut, not a place.** A row here has none of a session row's marks, menu or dragging. Every session listed here is still in its usual place: Folders or the Archive, its group, and Recent when it moved lately. A row goes when the thing it waits on is done, or when you dismiss it.
- **Only while it has rows.** An empty list isn't shown at all, so the list appearing is the signal. You can collapse it; a search opens it again so every hit shows.
- **Refreshed every 10 seconds** while the tab is visible, and at once when you come back to it.

Organization sessions wait in the Organizations section's own Needs you, not in this one. The Overseer counts them too, so its "need you" number can be higher than this list's.

## Dismiss

Every chat's row has a **×** at its right, shown when you hover the row or reach it with the keyboard on a computer, and always shown on a phone. Press it when you've read a row and don't mean to act on it now.

- **It stops counting everywhere.** The row leaves the list, and the chat leaves the Overseer's "need you" number, project cards, the phone app's badge and notifications, on all your devices. The chat itself doesn't change: a dialog stays open and a question stays unanswered, and its row elsewhere keeps its marks.
- **Undo, briefly.** A "Dismissed." toast with **Undo** shows for a few seconds. There is no list of dismissed rows.
- **Something new brings it back.** The row returns when that chat has something new: a new reply, question, error or dialog.
- **Only chats.** A row of no session (a failed deploy, a release item, a WhatsApp sender, an owner's request) has no ×. It closes where it lives.

## Proactivity

The Overseer's **Proactivity** setting decides what happens with this news. Set it on the Overseer page or in Settings → Overseer:

| Mode | What you get |
|---|---|
| Off | No Needs you list. The Overseer chat still works. |
| List Only (default) | The Needs you list. No messages from the Overseer, and no tokens spent. |
| Brief Me | The list, plus an Overseer message when something new needs you, at most once every 10 minutes, and one when Sova first finds a playbook schedule waiting for your approval. |

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

1. Fill in **Contact address**, a `mailto:` address or an `https://` URL, and press **Save Changes**. The push services use it to reach whoever runs the server, and nothing is sent without one.
2. Press **Enable on This Device** and allow notifications when your browser asks.
3. Press **Send Test** to check. It reaches every device you added, ignoring the switches and quiet hours below, and says which ones failed.

The same tab lists your devices with when each was added and its last delivery or error, and **Remove** takes one off. You can also switch off whole kinds (Needs input, Open questions, Error, Baton, Subagent error, Playbook needs you, WhatsApp down, App down; Subagent error starts off) and turn on **Quiet hours**, 22:00 to 07:00 on the server's clock by default.

### What arrives

- **Once per problem.** Each blocker is sent at most once until it clears. If it clears and comes back, it's new again.
- **Nothing old.** What was already waiting when the server started is never sent.
- **Nothing you're looking at.** A session open in a Sova page right now isn't sent.
- **Dropped, not held.** Anything that arrives during quiet hours, or while a kind is off, is dropped. Nothing arrives in a burst when quiet hours end.
- **Grouped.** Sends are at least 30 seconds apart; what arrives in between goes out together. One session reads "{Kind} · {session name}" with the reason underneath, and a newer notification for that session replaces the older one. Several read "3 sessions need you", one line each.
- **Secrets hidden.** Titles and text pass through Sova's redactor before they're encrypted, since they show on a lock screen.

Organization sessions are sent too, though they're not on this list. When a project's merge thread has a question and no chat to ask it in, it's sent once to every device, titled "The merge thread needs you", and a tap opens the project's Merge Queue tab. Tapping a notification opens that session (WhatsApp down opens Settings → Outreach), or the Overseer when several need you. Where your browser supports app badges, the installed app's icon shows how many sessions need you.
