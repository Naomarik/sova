// The terminal command that resumes a session in pi's TUI. Pure, so it's unit-tested in
// session-command.test.ts.

/**
 * A POSIX-shell single-quoted word. Inside single quotes nothing is special — not `$`, a
 * backtick, `\`, or bash's history `!` — so the only character to handle is `'` itself: close
 * the quote, emit an escaped one, reopen (`it's` → `'it'\''s'`).
 */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * `pi --session '<path>'`. The full path, never the id: a partial id can match more than one
 * session, and a path can't. No `cd` is needed, since pi takes the tools' cwd from the session
 * header, not from the shell it was launched in.
 */
export const resumeCommand = (sessionPath: string): string => `pi --session ${shellQuote(sessionPath)}`;
