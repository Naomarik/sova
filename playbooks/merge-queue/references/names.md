# Private names: the interview

The leak scan checks every push of the target against the project's list of private names: what must never reach its public repo. Without a list, Sova still lands branches but holds every push, and asks you to run this interview. The list belongs to the user. Its file is the one Sova's message names (`<names file>` below); never a path you pick.

You never wait for the user in your own chat: every question goes through `merge.ask {text, entry}`, with the newest landed entry, so Sova asks it in that branch's own chat (no chat to ask: on the Merge Queue tab, with one notification). Their answer comes back to you as a message. A question never quotes a name: the user's answer in their chat is theirs to write.

## When the list is missing
1. `node <method>/scripts/discover-names.mjs --file <names file> --target <target> --repo <project root>` collects what this machine knows (host and home names, tailnet hosts and IPs, Sova's peers and devices, login emails and their domains, organization names) and writes them to the file. It prints kinds and counts, never values, and which names the public target already holds (masked).
2. Ask the user one short set of questions with `merge.ask`: what else must never reach the public repo? Servers and their IPs, domain names, hostnames or tailnet names, API or odd encryption keys, client or person names, anything else. Say how many names of which kinds the file has already (kinds and counts, as the script printed them), never a value. End your turn.
3. When their answer comes, add their names: `--add-kind <kind> --add <value>` per name, or `--add-file <file>` (one `<kind>: <value>` per line; delete the file right after). Rerun with `--show` to check it yourself, then ask with `merge.ask` whether the list is complete, saying its kinds and counts; to see the names themselves they open this chat (the Merge Queue tab's Open Merge Thread), where you show them on request.
4. Once they confirm, the next landing pushes (or the user resumes it). Say so in the entry's note (`merge.note`, no names).

## When the list exists
Sova doesn't call you for it. If the user asks in this chat, run the script with `--show` and show the list here only.

## Rules
- Never write a name anywhere but the names file: not in a note, a commit, a file in a repo, a command line you print back, a `merge.ask` question, or another chat. In your own chat, only when the user asks you there to show the list.
- The list only grows on its own. Drop a name only on the user's word (a false positive, or one they say may be public), after copying the file aside as a backup.
- "Already public" names: tell the user (masked as printed); what to do about them is theirs to decide.
