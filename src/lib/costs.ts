// Project costs at API prices (§app/project-costs): the card's and the org roll-up's pure rules,
// so they run under tsx --test.

/** Dollars as the copy deck writes them: `$1,240.00`, `$0.08`, `<$0.01`, `$0.00`. */
export function usd(n: number): string {
  if (!(n > 0)) return "$0.00";
  if (n < 0.005) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
