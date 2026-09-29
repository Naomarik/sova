// The share build's icons for drawings: every file in public/icons, bundled with the drawings' own
// chunk (the share listener serves only this build's assets). vis.tsx loads it with the Views.
const files = import.meta.glob<string>("../../public/icons/*.svg", { query: "?url", import: "default", eager: true });

export const SHARE_ICONS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".svg".length), url]));
