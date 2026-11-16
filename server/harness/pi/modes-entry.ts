// The engine as a loadable extension file: what the loader puts in every discovering chat's mode slot
// (own-code.ts ownExtensions: a discovered `mode` extension's place, or added when there is none) and in a
// worker's listed mode slot (workerModePaths).
import type { PiExtensionAPI } from "./extension-types";
import { modesExtension } from "./modes";
import { personalModesSource } from "../../modes/registry";

export default function sovaModes(pi: PiExtensionAPI): void {
  modesExtension(pi, { modes: personalModesSource });
}
