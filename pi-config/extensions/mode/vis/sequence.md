<!-- owner: process member. Step-through walks messages (a divider goes with the next, a note with the one before), so "Step 2" is what `mark 2` names. Emphasis targets: actor id or label, message number. -->
# vis sequence
Messages between parties over time (protocols, handshakes, request/response). The reader can step through it message by message.
```vis sequence
title: TCP handshake
caption: The server commits resources at the SYN-ACK.
actor c "Client"
actor s "Server"
c -> s "SYN"
s --> c "SYN-ACK"
== TLS ==
note c s "keys derived from the exchange"
mark 2 "the server commits resources here"
```
- `actor <id> ["Label"] [tone]` (optional; order = first use). `a -> b "msg"`, reply `a --> b "msg"`, self `a -> a "msg"`. `note a [b] "text"`, `== section ==`. At most 8 actors (2–4 fit a phone); short message labels.
- `mark` targets: an actor, a message's "label" or its number (1 = the first message; notes and dividers don't count).
