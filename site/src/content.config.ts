import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

// The /docs pages: hand-written Markdown, one file per page. A file's path is its URL under /docs/
// (index.md is its folder's own page). `group`, `subgroup` and `order` place it in the sidebar:
// a subgroup is a labelled, indented list inside its group (Major and Minor under Modes).
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    group: z.enum(["Start", "Modes", "Features", "Setup"]),
    subgroup: z.enum(["Major", "Minor"]).optional(),
    order: z.number(),
  }),
});

export const collections = { docs };
