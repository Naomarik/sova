// bun main.ts  vs  npx tsx main.ts (or any case-sensitive resolver)
// Expected: "parts.ts". Bun 1.4.2 on Linux: `error: ENOENT reading ".../parts.tsx"`: the resolver
// matches `./parts` to `Parts.tsx` case-insensitively, then reads it under the import's case,
// a file that doesn't exist on a case-sensitive file system. (Alone, `Parts.tsx` with an import of
// `./parts` gives the same ENOENT instead of "module not found".)
import { which } from "./parts";
console.log(which);
