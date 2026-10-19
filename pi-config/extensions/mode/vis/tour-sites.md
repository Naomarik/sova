<!--
  Part `tour-sites` of the tour guide: `vis_guide {kind:"tour-sites"}` returns it alone. Sources, site
  approval, the sandbox and the recorder's network rules. Each rule lives in one file only.
-->
# tour-sites: sources, site approval and the network

Read this only when the source is a project's running copy, or a report names a blocked origin, redirect, socket or write. An ordinary site and its Approve Site need only the core guide.

## A project's running copy

Name the copy alone: `source` is `{kind:"project",instanceId,serviceId,endpoint}`.
1. Take all three from the project's running-copy tools (`status`, or the running-copy note in this chat).
2. `instanceId` is the instance's id. A port listed as `server.http` is `serviceId:"server"`, `endpoint:"http"`: the port's name, never its number or a URL.
3. Leave out `projectId` and `checkout`. Sova fills them in from its own records and refuses ones that don't match.
4. Never read another Sova's state files or registries (`registry.json`, anything under `.agent/`) to find ids. Use the running-copy tools only.
5. If a source field is refused, the error names the field and what it expects: fix that field.
6. Don't remember a localhost address. Each dry run and recording resolves that same copy again.
7. If the copy stopped, or its ownership is unknown, ask to start that same copy through the project's tools. Never follow another copy that took its old port.
8. If the copy answers 404 at `/` (say its frontend was never built), report that to the operator and stop. Never build, install or change the copy yourself.
9. Don't write files in the copy's checkout, not even a temporary script. Use /tmp while diagnosing.

The project's verified own running copy needs no extra site approval.

## Another site (live, local or dev server)

1. Use `{kind:"site",origin:"https://example.test"}`.
2. The user must approve each new exact origin (scheme, host and effective port), loopback included.
3. Declare extra resource and redirect origins in `sites`.
4. A redirect, of the page or of anything it loads, to an origin the tour neither declares nor already requested fails the attempt, naming that origin, even if approved. Add it to `sites`, or use reference text.
5. A named site other than `localhost` must resolve only to public addresses. A name that points at a private or local address is refused.

## Site approval

1. A job waiting in `needs-site-approval` lists `requirements.origins`.
2. Ask the operator to press Approve Site on the chat's tour card for each. When several wait at once, the card offers Approve All.
3. You cannot approve for the user. Consent is not sandbox permission: blocked destinations stay blocked.
4. An undeclared subresource that isn't approved yet stops before contact and waits for Approve Site.
5. An undeclared redirect fails the attempt, and a popup always fails it. Don't keep retrying either.
6. The operator can Revoke Site on the tour card. Revoking a site that a running recording of this tour uses stops that recording ("Revoke Site and Stop Recording").
7. After a revoke, the next recording that needs that origin waits for approval again: ask then.
8. Waiting for approval or a test account holds no recording slot.

## The sandbox

Recording follows the sandbox this chat's own tools run under right now.
- **On:** a recording reaches only the sites the sandbox allows, plus this project's own running copies. Its tour gets no Open This Page link.
- **Off or Subagents only:** not confined by the sandbox, but every connection still goes through the recording's own proxy, loopback included.
- **In every state** the proxy admits an origin only while it is approved, and only if the script declares it (`source`, `sites`, `signIn.origins` or the test-account origin) or one of its pages already requested it through the recorder's checks. Anything else is refused before contact.
- If recording refuses because the chat's sandbox state can't be established, ask the user to open this chat in Sova, then retry.
- Never ask the user to change the sandbox so a tour works. If the site the tour needs is blocked, say so.

## Network rules while recording

1. Recording uses fresh isolated browser contexts and the installed Chrome/Chromium, never a downloaded browser, never the operator's everyday profile.
2. Form submission and downloads are blocked. The sign-in's one submit is the only write exception; it never covers a view's actions.
3. A write the page sends by itself (analytics, a "mark as seen" call) is stopped quietly, never reaches the site, and is counted in the job's `quietAborts`.
4. A live connection (a WebSocket, such as a dev server's live reload) to an approved site opens and receives. Anything the page sends on it is dropped and counted in `quietAborts`. A Sova test copy keeps stricter rules (`tour-sova`).
5. A form submission, or any request after an `open` or `fill`, fails the attempt. So does a page that shows an alert, confirm or prompt.
6. Filling an autosaving field can write too: don't assume it is safe. A mutating GET is not safe because it is a GET.
7. Use an isolated, seeded, read-only test interface. Otherwise stop, or explain the state with reference text. Never work around the action rules.

## Queue and size limits

- A few jobs run at once. Queued jobs show their actual place in line and can be cancelled.
- A picture is at most 15 MiB, an edition 256 MiB (the script limits are in the core).
