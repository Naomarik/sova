// pi-ai's StringEnum as a TypeBox schema, however this extension was loaded.
//
// pi's own loader hands an extension its pi-ai view, whose StringEnum is built with TypeBox. An extension
// imported natively (a Sova chat under Bun) gets pi-ai's real entry instead, and from pi-ai 1.5.0 that
// StringEnum returns a plain object. Type.Optional() of a plain object writes TypeBox's marker into it as an
// ordinary key, so the tool's JSON schema, which the model's provider receives, gained `"~optional": true`.
// Type.Unsafe makes it a TypeBox schema again: the same JSON as before, and no marker in it.
import { StringEnum as piStringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export function StringEnum<const T extends readonly string[]>(values: T, options?: { description?: string; default?: T[number] }) {
	return Type.Unsafe<T[number]>(piStringEnum(values, options) as object);
}
