import type { DefaultNotApplied } from "../../shared/protocol";

/** A new chat's empty-screen line when it couldn't start on this computer's default profile. */
export function defaultNotAppliedLine(note: DefaultNotApplied): string {
  const reason = note.reason.trim();
  const said = reason ? `: ${reason}` : "";
  return `This chat didn't start on ${note.profile}${said}${/[.!?]$/.test(said) ? "" : "."}`;
}
