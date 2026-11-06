# §mesh/compatibility — Hosts on different versions
> Part of the Sova design spec · [overview](../design/overview.md)

Two hosts on different builds stay as usable as what really changed between them allows. What hosts
exchange is split into four areas, each with one version number, and comparing those numbers puts
every other host in one of four states: **Works fully**, **Read only**, **Display may be wrong** or
**Update needed**. The state says what you can do with that host's sessions, and it looks the same on
every screen. A build difference that changed none of the numbers costs nothing and raises no warning.

## §mesh.compatibility/areas — Four areas, one number each

Each build carries one version number for each of four areas:

| Area | Id | Covers |
| --- | --- | --- |
| Session list | `sessions` | the session rows a host lists |
| Reading a chat | `transcript` | a chat's transcript and its live replies |
| Writing to a chat | `composer` | messages, steering, Stop, model and in-chat actions, new sessions |
| Host-to-host | `peer` | links, sync and host details |

Two sides match on an area only when their numbers are equal. There is no oldest supported version,
no grace period and no translating down to an older format: a number that differs is a difference,
whichever side is higher. A breaking change raises the number and removes the old format's code in
the same change (§mesh.compatibility/declare-a-change).

## §mesh.compatibility/states — Four states and what each allows

For each other host that answers, exactly one state holds. The first line that is true decides it:

1. The session list or host-to-host number differs, or the host lists no areas and is on another
   build (§mesh.compatibility/legacy): **Update needed**.
2. Otherwise the reading number differs: **Display may be wrong**.
3. Otherwise the writing number differs: **Read only**.
4. Otherwise: **Works fully**.

| You want to | Works fully | Read only | Display may be wrong | Update needed |
| --- | --- | --- | --- | --- |
| See its sessions in the list | yes | yes | yes, marked | yes, marked |
| Open and read a chat | yes | yes | yes, under a warning bar | no |
| Watch replies arrive live | yes | yes | yes, under a warning bar | no |
| Send or steer a message | yes | no | no | no |
| Stop a running reply | yes | no | no | no |
| Start a new session there | yes | no | no | no |
| Links and sync with that host | yes | yes | yes | no |

Read only means nothing can be sent: no message, no steer, no Stop, no model or in-chat action and no
new session. A reply running on such a host is stopped from that host's own page, or after the hosts
match. A host that is down, refuses this host or hides from it (§mesh.peers/health) keeps that state
and has none of these four.

## §mesh.compatibility/judged-by-the-page — The page judges with the versions it runs

The page works out each host's state itself, comparing the numbers bundled into the code it was
loaded with against the numbers that host lists in its hello. The server's numbers play no part, so
a tab left open across an update is judged by what it runs: it can show a state a reload clears, while
a freshly loaded tab on the same host shows another. Two tabs on two builds can each be right.

## §mesh.compatibility/marks — Each state looks the same everywhere

The Mesh page, the host menu, a session row's word, a session head, New Session's Host choice and
workspace panes all show the same state in the same words, from the same reading:

| State | Dot | Word |
| --- | --- | --- |
| Works fully | green | none |
| Read only | amber | read only |
| Display may be wrong | amber | display may be wrong |
| Update needed | amber | update needed |

Amber means you have lost something. A host that works fully on another build shows no amber and no
mark on rows or heads; only the Mesh page and the host menu say it is on another build
(§mesh.ui/page, §mesh.remote-sessions/host-filter). The words "other version" and "can't be reached"
are never used for a host that answers. No sentence about a host's version relies on the release
number, which two different builds can share.

## §mesh.compatibility/read-only — Read only: a notice in place of the composer

A chat on a host that is Read only opens and stays live: its transcript and running replies keep
arriving. The composer, Stop included, gives way to a notice saying that nothing can be sent there
from this page, Stop included, and that you can still read and watch. The notice names the host that
is behind, the side with the lower writing number. When the other host's build is older than this
host's (§mesh.peers/resync), the notice has `Resync`, which opens the same confirm sheet as the host
menu's.

## §mesh.compatibility/display-warning — Display may be wrong: a warning bar over the chat

Opening a session on a host in Display may be wrong draws the chat anyway, under a warning bar. The
bar says the chat may not show correctly and names the host that is behind, the side with the lower
reading number, with `Resync` when the other host's build is older than this host's. The chat stays
live. Sending is off, as Read only words it (§mesh.compatibility/read-only), and the composer gives
way to the same notice.

## §mesh.compatibility/update-needed — Update needed: the session says why

A session on a host in Update needed can't be opened. Its address shows a page saying that the host
runs another version of Sova, that the session opens once the two match, that nothing here changed,
and a way to the Mesh page. That page never says the host can't be reached.

## §mesh.compatibility/refusal — The host holding a session refuses what it can't trust

The page's state is the visible half; the host holding a session enforces the rest. That host refuses
any writing-area request (a message, a steer, Stop, a model or in-chat action, a new session) that
states a writing number other than its own, with one plain sentence and nothing done. A sender behind
that host is told to reload the page; a sender ahead of it is told that host needs an update.

A send that states no version is accepted while writing is at its first version. Once writing has
moved past its first version it is refused, with a sentence asking to reload the page.

The rule is the same on the host serving the page: a tab left open across its own host's update is
refused in the same words, with the mesh on or off.

## §mesh.compatibility/every-send-states-a-version — Every send states a version

Every writing-area request says which writing number sent it, on the socket as well as on routes. A
page states the number bundled into it, and the proxy carries it to the other host unchanged
(§mesh.remote-sessions/proxy). The Overseer and commands run on another host state their own host's.

A link message is a host-to-host send: its host states its host-to-host number and it is judged by
that area, so a link works with a host that is Read only (§mesh.compatibility/states).

## §mesh.compatibility/host-acts — What hosts do on their own

Links, sync and the Overseer run with no page. For them a host reads each other host's state by the
same rule, with its own running numbers in the page's place. A host in Update needed by that reading
takes no link and no sync (§mesh.links/delivery, §mesh.sync/categories), and the Overseer can neither
read from nor act on it. The Overseer can read and link a host that is Read only or Display may be
wrong, but can't send to it or create a session on it. Each refusal names the host and says it runs another
version of Sova. The details dialog (§mesh.details/view) keeps asking every host that answers.

## §mesh.compatibility/best-effort — Everything else is best effort

Screens outside the four areas that show another host's data (its projects, organizations, models and
folders in pickers, and the hand-off strip) have no area and no state of their own. They keep working
whatever the host's state, and anything new that the other host doesn't send is simply absent. Commands
run on another host need no area: their ids are never reused, and a host that doesn't know one says so
(§mesh.peers/remote-commands).

## §mesh.compatibility/legacy — Hosts with no list, and the rollout

A host whose hello lists no areas is judged as before this feature: on another build, as its protocol
fingerprint shows, it is `skewed`, which reads as Update needed; on the same fingerprint it works
fully. Sync, and messages on links already made, stay as they were with a host that lists no areas.
Nothing changes between two hosts until both run a build that lists its areas, and `Resync` brings an
older one over.

Every area starts at its first version on the first build that lists them. Once both hosts list their
areas the fingerprint decides nothing: it stays in the hello for hosts that list none, for details and
for Resync. From then on only a real breaking change in an area changes what you can do.

## §mesh.compatibility/declare-a-change — Developers declare every change to an area

A check holds each area's format against a recorded shape, built from the types themselves, so a
reworded comment changes nothing. When an area's format changes, the check fails with instructions
until the developer declares the change one of two ways: compatible, with a note and the number kept;
or breaking, with the number raised and the old format's code removed in the same change. Nothing
classifies a change on its own.

Saved samples of the current version of each area run through the page's own readers, and must keep
displaying correctly, so a breaking change declared compatible is caught. Raising a number replaces
its samples.
