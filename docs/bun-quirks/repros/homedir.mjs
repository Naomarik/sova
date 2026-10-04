// bun homedir.mjs  vs  node homedir.mjs
// Node: os.homedir() follows process.env.HOME set at runtime ("/tmp/elsewhere").
// Bun 1.4.2: it keeps returning the HOME the process started with.
import os from "node:os";
const before = os.homedir();
process.env.HOME = "/tmp/elsewhere";
console.log({ before, after: os.homedir(), expected: "/tmp/elsewhere" });
