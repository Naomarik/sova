// The rules for a chat's labels that both sides check: the labels store (server/session-labels.ts) and the list
// place's declaration (src/lib/list-place.ts). DOM-free, and imports nothing.

/** A label key: the manual tags' rule. */
export const LABEL_KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** An extension id as the loader takes it (server/extensions.ts EXTENSION_ID_RE), bounded. */
const EXT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Whether `id` is an extension id labels may be kept under: the loader's rule, bounded, never `.` or `..`. */
export const validExtId = (id: string): boolean => EXT_ID_RE.test(id) && id !== "." && id !== "..";
