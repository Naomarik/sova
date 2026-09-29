// Where a drawing's icons come from: the operator app serves them at /icons/; the share build,
// whose listener serves only its own assets, bundles the few a drawing it draws uses and points
// here at them (src/share/vis.tsx).
let resolve = (name: string): string => `/icons/${name}.svg`;

export const visIcon = (name: string): string => resolve(name);

export function setVisIcons(fn: (name: string) => string): void {
  resolve = fn;
}
