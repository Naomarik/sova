# §app/chat-actions — In-chat actions a script can wait on

A script can stop, compact, rewind or regenerate a chat, remove one of its queued messages, or
reload it on the server's current code, and learn how that went, with one request
(`POST /api/chat/action?path=<session>&wait=<ms>`) or `sova run chat.<action>`. The chat takes the
action exactly as it takes the same button pressed in a tab.

## §app.chat-actions/route — The same action as the button, with its answer

The chat handles a script's action just as it handles the button: the same checks, the same
refusals word for word, the same result. Every open screen of that chat shows what it shows when
another tab presses the button: the transcript, the queue, whether a reply is running, the code
state. The answer names the outcome. Stop answers `stopped`, saying whether anything was running
and returning any queued text the stop cleared. Compact, Rewind, Regenerate and Remove answer
`done` with the chat's own reply. Rewind's reply includes the text the composer would get.
Reload Now answers `current`, `reloading`, `pending` or `failed`. A refusal answers 409 with the
chat's own sentence.

Two differences from a press: the rewound text comes back in the answer and is not placed into an
open composer, and an action does not mark the session as seen, so its unread mark stays as it was.

The route never sends a message, a steer or an answer to a waiting dialog. Answering a dialog can
approve a sandbox widening, so it stays with the person and the Overseer's own tool.

## §app.chat-actions/never-replay — Each action reaches the chat at most once

Each request hands its action to the chat at most once, and nothing sends it again. Once the
action went over, when the wait runs out, when the chat restarts or reconnects before answering,
or when the wait is 0, the answer is `202` with outcome `unknown`: the action may or may not have
happened. When the chat never opens (no hello within a minute) or goes away before the action
went over, the outcome is known: the answer is `503` with outcome `not-sent` and the sentence "The
chat did not open; nothing was sent.", and `sova run` exits 1, never 5.
`sova run` exits with a class of its own for it. Exit 5: the action was handed to the chat but its
outcome is unknown; it was not and will not be retried. On a chat action, `sova run` also
exits 5 when the connection opened (so the request may have been read) and then broke or reset
before the whole answer arrived, as when the server restarts mid-wait. Exit 1 means the connection never
opened (refused, unknown host, a host it refuses), so nothing was delivered. Every other command
keeps exit 1 for a broken connection. The exit-5 message says plainly that Sova may have acted
and to check the chat before running it again. Neither `sova run` nor anything else ever retries
a chat action.

## §app.chat-actions/terminal-open — A session open in a terminal refuses it

A session open in a terminal refuses every action with a 409. The sentence is the one every other
action on that session gives ("Session is open in another pi process … it is read-only here. Use
watch instead."). This holds for any wait, 0 included: the answer always waits for the chat to
open or refuse.

## §app.chat-actions/cold — Stop and Reload Now start nothing

Stop on a chat that isn't open answers that nothing was running, and Reload Now answers that the
chat isn't running. Neither starts the chat. A chat that is still starting counts as not open, so a
reply it starts after the answer is not stopped. A chat whose process ran on through a server
restart is open: right after the restart, the answer waits until the server has taken it back, so
a reply still streaming there is stopped. A session open in a terminal still gets its 409.

## §app.chat-actions/catalogue — The six commands

The catalogue lists them as `chat.stop`, `chat.compact`, `chat.rewind`, `chat.regenerate`,
`chat.queue.remove` and `chat.reload-code`. They all need the `sessions` peer capability, the same
as a chat's own connection.
