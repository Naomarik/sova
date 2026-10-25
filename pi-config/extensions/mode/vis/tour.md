<!--
  The tour CORE: what `vis_guide {kind:"tour"}` returns. Paid for once per chat that records a tour, so keep
  it at most 13,500 chars after comments (about 3,000 tokens; glm-5.3 reads ~4.44 chars per token; tested in
  pi-config/extensions/mode/index.test.ts). It covers the ordinary case alone: a chat recording an ordinary
  tour reads no part. Rare cases live in the parts beside it (tour-signin.md, tour-sites.md, tour-sova.md,
  tour-sharing.md), each pointed to with "only when …", returned by `vis_guide` with the part's name. Each rule
  lives in exactly one file. Written for a cheap model: short lines, must-know first (the hands-off rule, then
  exploring with `look`), numbered rules, no paragraph over ~600 chars. The worked example is validated by
  src/vis/guide.test.ts with the real script validator and run by server/tours/runner.integration.test.ts;
  recorder failure messages cite the part names.
-->
# tour: explain a real interface

A tour is a recorded, checked explanation of a real interface, at desktop and phone size.
Record with `record_tour`, present with `show_tour`. Never write a `vis tour` fence.
On Claude Code they are `mcp__sova__record_tour` and `mcp__sova__show_tour`.

## Hands off: always

1. Never change the app you tour, its data or its settings, not even to make a tour work.
2. Never sign in to the app outside the recorder: no developer sign-in shortcut, no curl or database query against the app's data.
3. Never read Sova's own records (its state folder `~/.pi/agent/sova/`, or `.agent/sova/` in a test tree; other chats' tours) or anything but the app's own source.
4. When something seems to need one of these, stop and ask the user.

## Before you write

- Know what to cover, who it is for, and what they should understand or decide. If any is missing, ask one short question; never guess the scope. For an ambiguous request, propose a compact outline first.
- A tour suits an existing feature, a UI/UX experiment, a flow review, or a before/after.
  A layout that doesn't exist yet is a wireframe; explaining a model is an interactive illustration.
- Tours are asked for and changed in chat (no tour button). Each change is a new recording.
- Prefer seeded, made-up data and test accounts; a real account only if the user chooses it.
- The tools exist only while vis mode is on (align Visuals alone doesn't grant them). If missing, say so; never substitute screenshots, downloads or a fence.

## Explore: read a little, then look

1. Read at most about 10 files of the app's source: its routes list, the area's wording, a summary of its demo data.
   Never read styles or components to guess names or screen fit.
2. Then one `record_tour {op:"look",source,signIn,pages:[{route,actions?},…]}`: up to 10 pages, `actions` as in a script (one list, or by size).
   It is a job like a dry run: approval and the sign-in card come up here. Call `status` with its `jobId`; at `checking` the answer holds `look`.
3. Per page and size, `look` lists `controls`: `{role,name}` (use as `{kind:"role",role,name}`), `{testId}` or `{text}`, each with `matches` and `onFirstScreen`; and `links` to other routes.
   Take every target from these lists, copied exactly, with `matches: 1`. Nothing unlisted is a target. `onFirstScreen: false` needs `reveal`.
4. Sign-in boxes unknown? First look with `signInRoute:"/login"` instead of `signIn`, and `pages:[]`: `signInPage` lists that page as seen signed out (`input:"password"` is the password box). Write `signIn` from it, then look again.
5. Pass the look's `tourId` to your dry run: its sign-in carries over, so the user signs in once.

## Rules behind most failures

1. **Each picture is ONE screen.** Desktop is 1440×960, phone is 390×844. Nothing below that screen is pictured.
   Everything a view names sits fully inside it at both sizes: marks, masks, every target it waits for, opens, fills or reveals.
   For lower content add `{op:"reveal",target}` before the mark.
2. **Every target must match exactly one visible control.**
   Prefer a role and its exact name: `{kind:"role",role:"tab",name:"Overview"}`.
   Text matches the whole text exactly (direction marks ignored).
   Each view starts fresh: nothing opened or typed in an earlier view carries over.
3. **Never delete marks, views or steps just to make a rehearsal pass.**
   Fix the target. Marks that don't fit one screen together: split the view into two at that size. Or move the content into a reference view and say so in your report.
4. **Language.** Write the tour's own words (titles, notes, labels, reference text) in the language the user writes to you in.
   Targets match exactly what the screen shows.
   If the app shows another language, ask the user once, before the first rehearsal.

## Sign-in and site approval

1. `signIn.route` shows the password box signed out. Never make it a view or a look page: the look lists it signed out; describe it in a reference view.
2. Name its account, username and password boxes as that page shows them SIGNED OUT (maybe in another language), by `role` or `testId`, never `text`.
3. Pick `signedIn` from a control every signed-in page shows (e.g. the header's home link), as it reads after sign-in: the app may switch language then.
4. The login goes in `credentials` beside the script (or the look), or the user types it on the tour card. Never in the script or your messages.
5. A job in `needs-sign-in`: point the user at the tour card's sign-in form. A "Tour sign-in" notice names its job: act only if its status still shows `needs-sign-in`.
6. A job in `needs-site-approval`: ask the user to press Approve Site on the tour card for each `requirements.origins`.
Read `tour-signin` only when a sign-in fails twice, needs an account box or a one-time code, or a job waits in `needs-test-account`.

## The script

- Version 1: `v`, `title`, `summary`, `audience`, `outcome`, `source`, optional `sites`, `accountId`, `signIn`, then `chapters` and `steps`. Ids are lowercase letters, digits and hyphens.
- `source` is `{kind:"site",origin}` for a site the user named. Read `tour-sites` only for a project's running copy, a blocked origin or a redirect; `tour-sova` only when touring Sova itself.
- A step: `id`, `chapter`, `title`, `summary`, `views`. Title the outcome, not the click: "Find the saved draft", not "Click Drafts".
- Every view: `id`, `title`, `note`, `kind`. Views are states within one step ("Overview", "Details open"), not extra steps.
- A `page` view adds `route` (starts with `/`), `sizes:["desktop","phone"]`, `actions` by size, `marks`, optional `masks`. `{}` and `[]` are valid.
- A view on one size only needs a visible `unavailableReason`. Never stretch a desktop picture and call it phone.
- Before/after: give both views the same `comparison.group`, with `phase` `before` and `after`.
- A `reference` view has `reference` text instead: no route, actions or pictures.
- Targets: `{kind:"role",role,name}`, `{kind:"text",text}` or `{kind:"testId",testId}`. No selectors, JavaScript or file paths.
- A mark is `{target,label,side}`, `side` `left`, `right`, `top` or `bottom`. Keep a few marks that support the explanation; say what to notice.
- Masks are targets over private regions; CSS blur hides nothing.
- Never put a cookie, token, storage blob, login or personal data in a script.
- Limits: 40 steps, 12 chapters, 8 views per step, 30 actions per size, 6 marks and 12 masks per view, 256 KiB per script. Split a bigger tour; never drop views silently.

## Actions (per size, in order)

- `{op:"reveal",target}` brings the target fully into the screen, scrolling whichever panel holds it, then waits for the page to settle.
- `{op:"open",target}` opens a native details summary or a disclosure button (expanded state, controlled region). Never a submit control or a link.
- `{op:"fill",target,value}` sets a text box's value without the app's input events. Test text only.
- `{op:"wait",target}` waits up to about 2.5 s for one visible match, then for it to hold still. Not a delay.
- `{op:"scroll",x,y}` scrolls the page window by pixels, not an inner panel; prefer `reveal`.

**Nothing is ever submitted** except the declared sign-in. Recording never saves, sends, approves, creates, buys or uploads.
After an `open` or `fill`, every request is refused, GETs included: a state that needs one is reference text.

## Workflow

1. **Look:** as above, before the first rehearsal. Keep its `tourId`.
2. **Dry run:** `record_tour {op:"dry-run",tourId:"<id>",script:{…}}` checks every view at both sizes, without pictures. Keep its job id.
   `tourId` and `credentials` go BESIDE the script, never inside it.
3. **Fix:** a failed dry run lists every problem at once in `failure.problems` (`more` counts groups left out). Fix them all from the table below, then dry run again.
   It succeeded when the job reaches `checking`. A safety stop (blocked write, unapproved site, sign-in) stops at once.
4. **Record:** `{op:"record",dryRunId:"<successful job id>"}` (`credentials` again if an hour passed). It stops at its first problem.
5. **Inspect:** at `checking`, call `{op:"inspect",jobId}`. Look at every cell of every overview sheet.
   Then each file in the report's `suspicious` list: `{op:"inspect",jobId,capture:"<file.png>"}`. Re-record any defect. Skip other full-size pictures.
6. **Check:** only after you looked, `{op:"check",jobId,verification:{overviewReviewed:true,suspiciousCapturesReviewed:[…],notes:"<what you checked>"}}`. This publishes the edition; recording alone doesn't.
7. **Show:** `show_tour {tourId,editionId}` with a short line on what the reader will learn. Never attach the script or raw report.

**Waiting:** call `{op:"status",jobId}` and wait for its answer. It answers when the job finishes, fails, rests at `checking` or needs the user, or after up to 5 minutes.
Never sleep or poll in a loop. Calling status again is always safe, also after a Sova restart.
While a job waits on the user, tell them once what to do, then call status again.
A dry run takes 10 s to 3 min; a recording 3 to 12 min. Never invent an ETA or percentage.
Cancel with `{op:"cancel",jobId}`. An interrupted attempt is not replayed: start it again.

## When it fails

| The report says | Do this |
| --- | --- |
| outside the captured screen | Add `{op:"reveal",target}` before it in that size's actions, or pick a target on the first screen. Marks too far apart: split the view (rule 3). |
| covered by "<name>", a fixed or sticky bar | Reveal another target, mark one the bar doesn't cover, or use reference text. |
| matched 0 visible controls | Pick the `nearby` entry you meant: a ready target with its role and match count. Check the route and actions, or look at that page again. |
| matched 2+ visible controls | Pick a `nearby` target with `matches: 1`, or a `testId`. Never take the first entry blindly. |
| two views in a row found none of their targets | That page is not the one expected: a sign-in page, an error or a redirect. Check routes and `signIn`. |
| kept moving | Wait for a stable control first (`wait`), or mark a still element nearby. |
| a sign-in problem, or "neither" control | Rename the `signIn` targets from its `nearby` list or a signed-out look. Check `signIn.route`. If it fails again, tell the user; read `tour-signin`. |
| a blocked origin, socket, redirect or write | Read `tour-sites`. Never work around it. |
| invalid script | The error names the step, view and field: fix that field. |

Each problem's `at` names step, view, size and `action` (its index; none means a mark or mask).
A sandbox or source refusal needs its stated fix, never another address.

## Reference views

Use one when a state can't be reached safely or pictured faithfully. Never invent a picture or claim it was recorded.
The viewer shows the text as written: short paragraphs split by a blank line: what the state is; what the reader would see; why it isn't pictured.

## Inspecting and revising

- Check page and state, readable text, before/after framing, mark placement, masks and clipping.
- A model that can't see pictures: `inspect` also returns `copies`, each picture copied into your working folder (`.sova-tour/<jobId>/`).
  Those copies are the only recording files you may read: hand them to an authorized picture tool (such as `look_at_image`) or the operator. Never claim a check from file names.
- `verification` is your honest note. No boolean proves image quality.
- To change a tour, keep ids whose meaning stays; look again if pages changed; then dry run → record → inspect → check → show with that `tourId`.
- Read `tour-sharing` only when the user asks to share, hand off, or change a shared tour.

## Worked example: where a saved draft waits

The look listed heading "Saved drafts" on `/inbox` with `onFirstScreen: false`, hence `reveal`.
The login comes from the user: `{op:"dry-run",tourId:"<from the look>",script:<below>,credentials:{"https://example.test":{username:"…",password:"…"}}}`.

```json
{
  "v": 1, "title": "Find a saved draft", "summary": "Where a draft waits.",
  "audience": "New reviewers", "outcome": "Find saved drafts.",
  "source": {"kind": "site", "origin": "https://example.test"},
  "signIn": {"route": "/login",
    "username": {"kind": "role", "role": "textbox", "name": "Email"},
    "password": {"kind": "testId", "testId": "password"},
    "submit": {"kind": "role", "role": "button", "name": "Sign in"},
    "signedIn": {"kind": "role", "role": "link", "name": "Home"}},
  "chapters": [{"id": "drafts", "title": "Drafts"}],
  "steps": [{"id": "find-draft", "chapter": "drafts", "title": "Find the saved draft",
    "summary": "Private until sent.",
    "views": [{"id": "list", "title": "Saved drafts", "kind": "page", "note": "Drafts sit below your inbox.",
      "route": "/inbox", "sizes": ["desktop", "phone"],
      "actions": {"desktop": [{"op": "reveal", "target": {"kind": "role", "role": "heading", "name": "Saved drafts"}}],
        "phone": [{"op": "reveal", "target": {"kind": "role", "role": "heading", "name": "Saved drafts"}}]},
      "marks": [{"target": {"kind": "role", "role": "heading", "name": "Saved drafts"}, "label": "Your drafts wait here.", "side": "bottom"}],
      "masks": []},
     {"id": "sending", "title": "Sending", "kind": "reference", "note": "Explained in words.",
      "reference": "Sending delivers it.\n\nIt would move to Sent.\n\nA tour never sends."}]}]
}
```
