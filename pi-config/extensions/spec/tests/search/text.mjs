// The judge's own words-to-stems, used only to measure the test set (leak check, vocabulary gap).
// Deliberately small and independent of any ranker under test: lowercase, split on anything that
// is not a letter or digit, drop English stopwords, then a light suffix strip.

const STOP = new Set(`a an and are as at be but by can do does for from has have how i if in into is it
its me my no not of on or our so than that the their them then there these this to too up us was we
what when where which while who why will with you your yours it's dont don't doesn't isn't`.split(/\s+/));

/** A light English stemmer: plural, -ing, -ed, -ly; a doubled final consonant collapses. */
export function stem(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.endsWith("ies") && w.length > 4) w = w.slice(0, -3) + "y";
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const suf of ["ing", "ed", "ly"]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      w = w.slice(0, -suf.length);
      if (/([b-df-hj-np-tv-z])\1$/.test(w) && !/(ll|ss|zz)$/.test(w)) w = w.slice(0, -1);
      break;
    }
  }
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  return w;
}

/** Words of a text, lowercased, stopwords dropped, in order (duplicates kept). */
export function words(text) {
  return String(text).toLowerCase().replace(/[`*_]/g, " ").split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, "")).filter((w) => w && !STOP.has(w));
}

/** Distinct stems of a text. */
export function stems(text) {
  return [...new Set(words(text).map(stem))];
}

/** Fraction of the query's distinct stems found among the target text's stems. */
export function overlap(query, target) {
  const q = stems(query);
  if (!q.length) return 0;
  const t = new Set(stems(target));
  return q.filter((s) => t.has(s)).length / q.length;
}
