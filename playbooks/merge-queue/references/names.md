# Private names: the interview

The leak scan checks every push of the target against the project's list of private names: what must never reach its public repo. Without a list, Sova still lands branches but holds every push, and asks you to run this interview. The list belongs to the user. Its file is the one Sova's message names (`<names file>` below); never a path you pick.

This is the one time you talk to the user: in your own chat, where they read you. You never message another chat about it.

## When the list is missing
1. `node <method>/scripts/discover-names.mjs --file <names file> --target <target> --repo <project root>` collects what this machine knows (host and home names, tailnet hosts and IPs, Sova's peers and devices, login emails and their domains, organization names) and writes them to the file. It prints kinds and counts, never values, and which names the public target already holds (masked).
2. Ask the user one short set of questions, in your chat: what else must never reach the public repo? Servers and their IPs, domain names, hostnames or tailnet names, API or odd encryption keys, client or person names, anything else.
3. When they answer, add their names: `--add-kind <kind> --add <value>` per name, or `--add-file <file>` (one `<kind>: <value>` per line; delete the file right after). Rerun with `--show` and show them the list in your chat only; ask whether it is right.
4. Once they confirm, the next landing pushes (or the user resumes it). Say that the push hold lifts with the next landing.

## When the list exists
Sova doesn't call you for it. If the user asks, run the script with `--show` and show the list in your chat only.

## Rules
- Never write a name anywhere but the names file: not in a note, a commit, a file in a repo, a command line you print back, or another chat. In your chat, only when showing the list on the user's request or in the interview.
- The list only grows on its own. Drop a name only on the user's word (a false positive, or one they say may be public), after copying the file aside as a backup.
- "Already public" names: tell the user (masked as printed); what to do about them is theirs to decide.
