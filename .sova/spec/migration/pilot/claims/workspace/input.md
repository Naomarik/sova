# §workspace/input — Group input

One box at the foot of a workspace. A send makes one request, and the server prompts each member.

## §workspace.input/exclusions — What the group box lacks

The group box has no attachments, no slash commands, no @ completion, and no stored draft. Its
text lives only in the component, and the group prompt route has no attachments field.

## §workspace.input/acceptance — Box send outcome

A send does nothing while its trimmed text is empty, a send is in flight, or no member is
available. A box send clears the box only when every targeted member accepts it. A partial send
keeps the text and shows a report. A refusal sends nothing, keeps the text, and offers to send to
the other members when any remain. A refused box send replaces an existing report with that offer.
Any other error keeps the text and every banner and shows a toast; a 400 also rereads the members.
Any accepted send dismisses a refusal offer. Editing the box dismisses a refusal offer but not a
partial report. An accepted box send replaces an existing report.

## §workspace.input/retry — Partial-send retry

A partial report offers one retry per member that missed the message, each labelled
`Send to {member}` and sent to that member alone. A retry sends the text as it was originally sent,
never the box's current text. It never clears the box, whatever the outcome. An accepted retry
leaves the report with only the members still missing, and it closes when none are left. A refused
retry keeps the report and also shows the refusal offer. Any other retry failure keeps the report.

## §workspace.input/keys — Group Enter

Enter without Shift sends unless IME composition is in progress. Shift+Enter inserts a newline.
There is no menu for Enter to defer to.
