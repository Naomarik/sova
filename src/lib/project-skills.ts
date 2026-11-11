/** A skill's description cut to one short line, for the project page's Skills card. */
export function shortDescription(d: string | undefined, max = 140): string {
  const t = (d ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
