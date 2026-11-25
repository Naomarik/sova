// The Transport agent card's one action row (components/TransportAgentCard.tsx): which buttons it shows, in
// which order, their words, and which one is primary. DOM- and Solid-free, so a unit test reads it.

export type TransportCardAction =
  | { kind: "allow"; id: string; label: string; primary: boolean }
  | { kind: "done"; id: string; label: string; primary: boolean }
  | { kind: "save"; label: string; primary: boolean }
  | { kind: "open"; href: string; label: string; primary: false };

/**
 * The row: what the agent asks you first (Allow Downloads, a Done per command, Save Values), then Open Agent Chat.
 * The first answer is the card's one primary; Open Agent Chat is never primary. With more than one command, each
 * Done names its command by number, as the command's own label does. Pure.
 */
export function transportCardActions(at: { downloads: string | null; commands: readonly string[]; hostValues: boolean; href: string | null }): TransportCardAction[] {
  type Answer = Exclude<TransportCardAction, { kind: "open" }>;
  const answers: Answer[] = [];
  if (at.downloads) answers.push({ kind: "allow", id: at.downloads, label: "Allow Downloads", primary: false });
  const many = at.commands.length > 1;
  at.commands.forEach((id, i) => answers.push({ kind: "done", id, label: many ? `Done With Command ${i + 1}` : "Done", primary: false }));
  if (at.hostValues) answers.push({ kind: "save", label: "Save Values", primary: false });
  if (answers[0]) answers[0] = { ...answers[0], primary: true };
  return at.href ? [...answers, { kind: "open", href: at.href, label: "Open Agent Chat", primary: false }] : answers;
}
