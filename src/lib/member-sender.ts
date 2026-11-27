// The name over a message another computer typed (§app.extensions/senders): "From {name}", the name the list place's
// declaration gives that caller (src/lib/list-place.ts), else the computer's name when it was sent. Pure: the
// transcript (src/components/BuiltinKinds.tsx) and the Timeline (src/components/SessionTimeline.tsx) both read it.
import type { Sender } from "../../shared/senders";

type Member = Extract<Sender, { kind: "member" }>;
type People = { declaration(): { self?: string } | null; personOfCaller(caller: string): { id: string; name: string } | undefined };

/** Who to name over a member's message, or undefined when it is yours (your own person in the declaration). */
export function memberName(sender: Member, place: People): string | undefined {
  const person = place.personOfCaller(sender.by);
  if (person) return person.id === place.declaration()?.self ? undefined : person.name;
  return sender.label || "another computer";
}
