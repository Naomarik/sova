# Team Bar: a demonstration extension

An example of a Sova extension that uses three openings of extension contract v1.22 to give a team's
session bar a person filter, owner avatars and "From {name}" on messages typed from someone else's
computer. Every person in it is made up. Sova never installs it by itself: it is here so Sova's own
checks and demonstrations keep using the openings.

It has two parts with the same id, `team-bar`, one for each kind of computer:

| Part | Folder | Install it on | What it does |
|---|---|---|---|
| host mode | `host/` | the team's shared server, which holds the team's chats | asks Sova to record who started each chat and who typed each message (`"records": ["senders"]`), and labels each chat with its owner (`owner`, a person's id) through `POST /api/sessions/labels` |
| user | `user/` | each person's own Sova | answers the `list` screen place with the people and the owner key, so Sova draws the person menu and an owner avatar on each row, the shared server's rows included |

Both share one id because a chat's owner is read as `row.labels["team-bar"].owner`: the user part's
declaration names the key, and the label the host-mode part writes sits under the same id on the shared
server. A label from another computer is shown only because your own installed extension names it.

Each part is a small Node program with no dependencies (`server.mjs`) and no page.

## The people file

Both parts read `people.json` from their data folder (`$SOVA_EXTENSION_DATA_DIR`, that is
`<state root>/extension-data/team-bar`), on each use, so an edit needs no restart and no new approval.
`people.example.json` shows the shape:

- `people`: each `{id, name, initials, callers}`. `callers` are what Sova records as a sender:
  `peer:<node id>` for a linked computer (the node id the shared server's Mesh page lists for it) or
  `operator` for the shared server's own page.
- `self` (user part only): which person is you, highlighted in the bar.

The host-mode part gives a chat the owner whose `callers` name the computer that started it. A chat
started by no one in the file stays without an owner.

## Install

Settings → Extensions → Add Extension, choose `host/` on the shared server and `user/` on your own
Sova, review and approve, then write the people file into the data folder. Link your Sova to the
shared server from the Mesh page and give your computer `sessions` there.

## The demonstration

`demo/run-demo.mjs` runs the whole thing on two throwaway, linked copies of Sova started from this
checkout (never your own Sova, never `~/.pi`), on the scripted stand-in model:

```sh
node examples/extensions/team-bar/demo/run-demo.mjs          # prints each copy's unlock URL; writes .cache/team-bar-demo/demo.json
echo stop > .cache/team-bar-demo/control                      # stops both copies and the parts
```

One copy plays the shared server with the host-mode part, the other plays Kim's Sova with the user
part, paired through the mesh. It seeds chats owned by four made-up people in different states: Kim's
are started and typed from Kim's Sova through the link, Ravi's on the server's own page, and Lee's and
Ana's (whose computers aren't in the demo) are given an owner through the labels route, with their
messages and who-typed markers appended to the closed session files. `demo/screens.mjs` then takes the
screenshots on Kim's copy. The control file also takes `work` (a 30 s turn in one of Kim's chats),
`off` and `on` (Kim's user part).
