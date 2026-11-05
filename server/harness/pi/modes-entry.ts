// The engine as a loadable extension file: what the loader's in-place rewrite (own-code.ts modesEntries/modeFileOf)
// answers for a discovered or listed pi-config `mode` extension while Sova runs chat modes.
import type { PiExtensionAPI } from "./extension-types";
import { modesExtension } from "./modes";
import { personalModesSource } from "../../modes/registry";

export default function sovaModes(pi: PiExtensionAPI): void {
  modesExtension(pi, { modes: personalModesSource });
}
