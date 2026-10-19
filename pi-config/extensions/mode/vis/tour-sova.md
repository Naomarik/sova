<!--
  Part `tour-sova` of the tour guide: `vis_guide {kind:"tour-sova"}` returns it alone. Recording Sova
  itself. Each rule lives in one file only.
-->
# tour-sova: recording Sova itself

Read this only when touring Sova's own interface.

## Use a test copy

1. Start a test copy for this branch: a managed copy, slot 1 or higher, with its own made-up data. Use the project's running-copy tools.
2. Record that copy as a `project` source (`tour-sites` says how to name it).
3. Never point a tour at the live Sova or any other Sova. It is refused: "Tours of Sova use a test copy; start one for this branch."
4. The copy must not be able to call a model. A copy whose `auth.json` holds a credential, or whose model settings carry a provider key, is refused.

## Sign-in

1. Sova signs the recorder in to its test copy itself, with a cookie. Never declare `signIn` for it.
2. Never ask for, read or pass that copy's token. Never put it in a URL, request body, script or message.

## Live chat connections

1. On the test copy only, the recorder lets Sova's watch feed through, read-only.
2. Anything the page sends (a message, a prompt, a POST or any other write) aborts the attempt.
3. A page that opens the chat connection stops the attempt, because that would start a chat on the copy.
   The report names the step and view and says "this page opens a live chat; record it as reference text or choose an idle view".
4. So tour pages that render from what they read: an idle chat page doesn't open it.
5. A view that needs the chat connection, or a state that only happens after sending, is reference text.
6. Every other site keeps live connections blocked by these rules; see `tour-sites` for ordinary sites.
