# attention: how Sova tells you things, and what it writes for you

All of this is about this computer and works in any folder. None of it spreads to other computers.

## Phone notifications

- Change: whether Sova notifies the person's devices, the contact address it needs, which kinds it sends (needs input, open questions, error, baton, subagent error, playbook needs you, WhatsApp down, app down), and quiet hours.
- Lives: this computer. Subagent errors are off by default, the rest on. Quiet hours run on the server's clock and drop, never queue.
- Approves: the person, by Save Changes.
- By: Screen. Settings → Notifications. No card holds these. Nothing is sent until a contact address is saved.
- Live: from the next send.
- Check: Send Test on Settings → Notifications sends one to every device.

## This device

- Change: whether this phone or browser receives notifications.
- Lives: the browser's own subscription.
- Approves: the person, in that browser, at its own permission prompt.
- By: Screen. Enable on This Device on Settings → Notifications, on that device. On an iPhone or iPad, add Sova to the Home Screen and open it from there first.
- Live: now.
- Check: the Devices list shows it, with its last delivery.

## A notification of your own

- Change: nothing yet: there's no custom notification, no custom event, and no way for a script to raise something that needs the person.
- Lives: nowhere.
- Approves: nobody: there's no change to approve.
- By: None. The nearest ways are a script posting a card into a chat, a todo on the Overseer's list, or a program following Sova's event stream (the `scripts` topic). Sova can't call a URL when something happens.
- Live: never, today.
- Check: there's nothing to check.

## Decisions

- Change: whether Sova's opt-in classifier flags replies that ask the person, stalled teams and the like. It sends session content to a provider, so say that first.
- Lives: this computer. Everything is off until turned on.
- Approves: the person, by Apply on the card, which says it sends session content to a provider, or on the tab.
- By: Card or Screen. The Sova-wide setting `decisions`, or Settings → Decisions. Its key stays on that tab and never goes on a card.
- Live: from its next check.
- Check: Settings → Decisions shows the state, and the flags appear in Needs you.

## The summary line

- Change: which model writes the line under each session's title. Whether a browser draws that line is the browser's own, under Settings → General.
- Lives: `<agent dir>/topic-outline.json`, on this computer.
- Approves: the person, by Apply, or on the tab.
- By: Card or Screen. The Sova-wide setting `summaries.model`, or Settings → Summaries. A model turned off in Settings → Models won't summarize. A summary timeout and budget have no screen: `summaries.limits` is the card for those.
- Live: sessions started afterwards.
- Check: a new session's row shows the line.

## Session titles

- Change: whether Sova names sessions itself, how often, and with which model. A title the person typed is never changed.
- Lives: this computer.
- Approves: the person, by Apply, or on the tab.
- By: Card or Screen. The Sova-wide setting `summaries.titles`, or Settings → Summaries, Session titles.
- Live: from the next sweep.
- Check: a quiet session gets a title.

## Outreach

- Change: which WhatsApp numbers this computer sends from, the default, and which other computers may send through it. WhatsApp is the only channel; a new one needs Sova's own code.
- Lives: this computer. Pairing happens on the phone.
- Approves: the person, on the page.
- By: Screen. Settings → Outreach.
- Live: now, for sends after it's saved.
- Check: Settings → Outreach shows each number's state.
