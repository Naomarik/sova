// The docs are the site's content, read where they already are: docs.json names the folder
// (relative to the project root) and, one by one, the files in it the user agreed to publish.
// Nothing is moved, so every link and image reference into that folder keeps working, and a file
// not on the list is never published. Frontmatter is optional; a missing title falls back to the
// file's first "# " heading (src/lib/docs.mjs).
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { published } from "./lib/docs.mjs";

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: published.files, base: published.base }),
    schema: z.object({
      title: z.string().optional(),
      description: z.string().optional(),
    }),
  }),
};
