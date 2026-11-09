// Telling folders apart by as little of their paths as it takes: the Needs you rows' and a branch's place's rule for
// two projects with one name ("Notes · work/notes"). Pure; shared by the server and the page.

/** The end of `place` that tells it from every other of `places` (itself among them): the shortest tail, by whole
    folders, that no two of them share; the whole path when none is that short. Trailing slashes don't count. */
export function shortestTail(places: readonly string[], place: string): string {
  const split = (p: string) => p.replace(/\/+$/, "").split("/").filter(Boolean);
  const parts = places.map(split);
  const tail = (p: string[], n: number) => p.slice(-n).join("/");
  const most = Math.max(...parts.map((p) => p.length));
  let n = 1;
  while (n < most && new Set(parts.map((p) => tail(p, n))).size < parts.length) n++;
  return tail(split(place), n);
}
