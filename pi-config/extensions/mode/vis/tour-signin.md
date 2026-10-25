<!--
  Part `tour-signin` of the tour guide: `vis_guide {kind:"tour-signin"}` returns it alone. The core (tour.md)
  carries the ordinary sign-in (its "Sign-in and site approval" list); this part holds the rest. Each rule lives in one file only.
  server/tours/tools-signin.test.ts validates the two inline signIn examples below.
-->
# tour-signin: signing the recorder in

Read this only when a sign-in fails twice, the sign-in asks for an account box or a one-time code, or a job waits in `needs-test-account`. An ordinary sign-in needs only the core guide.

## The `signIn` declaration (a site's own sign-in form)

`signIn` is `{route,account?,username,password,submit,signedIn,origins?}`:
1. `route`: the sign-in page on the source. On a hash-routed site include the hash: `/#/login`.
2. `account` (optional): a box asked before the username, such as a company code. The recorder clears it before typing.
3. `username` and `password`: the boxes. Name them, and `account`, by `role` or `testId`, never `text`.
4. `submit`: the control that signs in. `signedIn`: a control visible only once signed in.
   Pick one every signed-in page shows (e.g. the app's home link in the header), never one only some pages show (a "Sign out" button on one menu page).
   Name it as it reads after sign-in: the app may switch language then (an English sign-in page, an Arabic app). The look's pages list it.
5. `origins` (optional): up to 4 exact origins the sign-in may send to. Default: the source's own. They count as declared sites and need approval.

Plain:
`"signIn":{"route":"/login","username":{"kind":"role","role":"textbox","name":"Email"},"password":{"kind":"testId","testId":"password"},"submit":{"kind":"role","role":"button","name":"Sign in"},"signedIn":{"kind":"role","role":"link","name":"Home"}}`

With an account box first (its value goes in `credentials` as `account`, never here):
`"signIn":{"route":"/#/login","account":{"kind":"role","role":"textbox","name":"Company code"},"username":{"kind":"role","role":"textbox","name":"Username"},"password":{"kind":"testId","testId":"password"},"submit":{"kind":"role","role":"button","name":"Sign in"},"signedIn":{"kind":"role","role":"heading","name":"Dashboard"}}`

## What the recorder does

1. Before the first view, at each size, it opens `signIn.route`. If the signed-in control already shows, it goes on. Otherwise it signs in there.
   So a site that shows its sign-in form in place of any page works too.
2. Pick a route that shows the signed-in control once signed in (most apps redirect). Otherwise each size signs in again there.
3. It waits up to 10 s for the signed-in control or the password box, whichever shows first.
4. If the route shows neither, recording stops, unless the tour already holds a session, which it then trusts.
   Its `nearby` lists up to 8 controls the sign-in page does show, as ready targets with match counts. Check `signIn.route`, `signIn.signedIn` and `signIn.password` against them, then record again.
5. To sign in it types the login into the declared boxes, clicks `submit`, and continues once `signedIn` shows.
6. Nothing on the sign-in page is pictured. The account, username and password boxes are blacked out in every picture.
7. Never make the sign-in page a view or a look page: signed in there, a fresh load would only sign in again, so the dry run and the look refuse it by name ("… is the sign-in page; it is never pictured.").
   The look lists it signed out; describe it in a reference view.

## Signed out mid-tour

1. If a view later shows the password box in place of the page, the site signed the recorder out.
2. A size that signed in up front signs in again at `signIn.route` and reloads the view. At most two sign-ins per attempt.
3. If that route then says the recorder is signed in, recording stops: "This view shows the sign-in's password box while the site says the recorder is signed in, so recording stopped."
4. A size that only trusted a held session stops instead: "The tour's held sign-in no longer works…". The next recording signs in afresh.
5. Later, whenever a view lands on that page again, it signs in again.

## Where the login comes from

**The user gave you the login** (in chat or otherwise): pass it as `credentials` beside the script.
`{op:"dry-run",script,credentials:{"https://app.example":{account?,username,password,code?}}}`
- Keyed by the sign-in origin.
- `account` exactly when the script declares an account box: required then, refused otherwise.
- Pass it again with `record` if the hour has passed. It is used without asking.
- Never put any of it in the script, a note, reference text, a mark or your own messages. A value that appears in the tour is refused.
- The call's arguments show it as "[hidden]" everywhere but this chat's own file.

**Otherwise** the job waits in `needs-sign-in` with `requirements.signIn`:
- `{origin,kind:"form",fields:["username","password"]}`;
- `fields:["account","username","password"]` when the script declares an account box;
- `fields:["code"]` for a one-time code.
The user is marked as needed, and you get a short "Tour sign-in" notice. Point them at the sign-in form on the tour card in this chat.
Don't ask them to paste a password into chat unless they prefer to. If they do, cancel the job and record again with `credentials`.

## Sign-in notices

1. A notice names its tour and job: `Tour "<title>" (tourId <tourId>), job <jobId>, was waiting for this sign-in when this was sent.`
2. Sova sends it only when this chat is idle and the job still waits on that sign-in. If the wait ended first, no notice is sent.
3. Still, call `status` for that job before you act. Act only if it still shows `needs-sign-in`.
4. If the job moved on, say nothing to the user about signing in.

## How long a login lives

- In Sova's memory for this tour only, never on disk. The look, the dry run and the recording share it (same `tourId`), so the tour signs in once.
- Cleared when the recording ends, is cancelled, Sova restarts, or an hour passes. A recording still waiting then stops.
- Wrong details fail the attempt once, never retried, and are forgotten: ask the user to check them. Only a page still showing the sign-in form counts as wrong details.
- "Signed in, but the signed-in control (signIn.signedIn) never showed, so recording stopped.": the login worked (the form went away) and is kept.
  Pick `signedIn` from its `nearby` list (the page the app landed on), as above, then dry run again: it signs in without asking.
- A page that asks you to prove you're human stops the attempt. Record another way, or use reference text.
- A tour of Sova's own test copy never declares `signIn` (`tour-sova`).

## Waiting for a sign-in

- A job waiting for a sign-in keeps its browser and waits as long as needed.
- Only as many can wait as can run at once. Past that, a new recording that needs a sign-in is refused, naming the one waiting.
  Ask the user to finish or cancel that one.

## Signed-in editions stay in their chat

An edition recorded after a form sign-in has no Share link and can't be sent to a hand-off. Say so when you present it.

## HTTP authentication: stored test accounts

1. A 401 uses stored test accounts only. The job waits in `needs-test-account` with `requirements.testAccount`.
2. Ask the operator to enter a test account for that exact origin on the tour card.
3. Sova stores one per exact origin and reuses it for every later tour of that origin. A different running copy on the same address uses it too.
4. So leave `accountId` out, and don't ask again for an origin that already has one.
5. Supply `accountId` only when the operator gives you one. A missing account, or one for another origin, is refused, never swapped.
6. An edition recorded with a stored test account stays shareable.
7. The operator can Remove Account on the tour card. The next recording that needs that origin waits for a test account again: ask then.
