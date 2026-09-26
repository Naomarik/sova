// An error sentence plus what it means for the operator's work ("Nothing changed."), said once: a
// server message that already says nothing happened (the reconcile refusal does) isn't told twice.
// Pure, for tsx --test.

const SAYS_NOTHING_HAPPENED = /\bnothing\b[^.]*\b(changed|sent|added|started|promoted|written)\b|\bno \w+ (was|were) (started|sent|added|changed)\b/i;

export function unchangedError(message: string, consequence = "Nothing changed."): string {
  const m = message.trim().replace(/\.$/, "");
  if (!m) return consequence;
  return SAYS_NOTHING_HAPPENED.test(m) ? `${m}.` : `${m}. ${consequence}`;
}
