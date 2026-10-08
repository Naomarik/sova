import { getCollection, type CollectionEntry } from "astro:content";

export type DocEntry = CollectionEntry<"docs">;

// Sidebar order: groups in this order; within a group, its own pages, then each subgroup in this
// order; pages by `order` within those. Prev/next follows the same sequence.
export const groups = ["Start", "Modes", "Features", "Setup"] as const;
export const subgroups = ["Major", "Minor"] as const;
export const subgroupLabels: Record<(typeof subgroups)[number], string> = { Major: "Major modes", Minor: "Minor modes" };
const subRank = (d: DocEntry) => (d.data.subgroup ? subgroups.indexOf(d.data.subgroup) + 1 : 0);

// The page's path under /docs/: "index" is /docs/ itself, "modes/index" is /docs/modes/.
export const docSlug = (id: string) => id.replace(/(^|\/)index$/, "");
export const docHref = (id: string) => {
  const slug = docSlug(id);
  return slug ? `/docs/${slug}/` : "/docs/";
};

export async function sortedDocs(): Promise<DocEntry[]> {
  const all = await getCollection("docs");
  return all.sort((a, b) =>
    groups.indexOf(a.data.group) - groups.indexOf(b.data.group) || subRank(a) - subRank(b) || a.data.order - b.data.order || a.id.localeCompare(b.id));
}
