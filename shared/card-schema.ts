/**
 * A view card's declared data shape (§chat.transcript-cards/files: "a JSON Schema of types, required
 * fields, enums and string and array lengths; anything else in it is refused"), and the check of a
 * card's data against it (§chat.transcript-cards/data-cards, "Checked before it draws"). Pure and
 * DOM-free: the server checks a raise with it, the page a card's stored data.
 */

import { CARD_DATA_MAX_BYTES, cardDataBytes, type CardDataError } from "./view-cards.ts";

export const SCHEMA_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;
export type SchemaType = (typeof SCHEMA_TYPES)[number];

/** The subset: every keyword it may use. */
export interface CardSchema {
  type?: SchemaType | SchemaType[];
  properties?: Record<string, CardSchema>;
  required?: string[];
  items?: CardSchema;
  enum?: (string | number | boolean | null)[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

const KEYS = ["type", "properties", "required", "items", "enum", "minLength", "maxLength", "minItems", "maxItems"];
const MAX_DEPTH = 16;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** A declared shape checked: null when it is one, else what is wrong with it, by its path in the shape (`data.properties.rows`). */
export function schemaError(schema: unknown, at = "data", depth = 0): string | null {
  if (depth > MAX_DEPTH) return `${at} is nested deeper than ${MAX_DEPTH}.`;
  if (!isObject(schema)) return `${at} must be an object (a shape).`;
  for (const k of Object.keys(schema)) if (!KEYS.includes(k)) return `${at}.${k} is not something a card's data shape may say (only ${KEYS.join(", ")}).`;
  const t = schema.type;
  if (t !== undefined) {
    const list = Array.isArray(t) ? t : [t];
    if (!list.length || !list.every((x) => SCHEMA_TYPES.includes(x as SchemaType))) return `${at}.type must be one of ${SCHEMA_TYPES.join(", ")}, or a list of them.`;
  }
  for (const k of ["minLength", "maxLength", "minItems", "maxItems"] as const) if (schema[k] !== undefined && !isCount(schema[k])) return `${at}.${k} must be a whole number, 0 or more.`;
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || !schema.enum.length || !schema.enum.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) return `${at}.enum must list strings, numbers, booleans or null.`;
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === "string"))) return `${at}.required must list field names.`;
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) return `${at}.properties must be an object of shapes.`;
    for (const [name, sub] of Object.entries(schema.properties)) {
      const e = schemaError(sub, `${at}.properties.${name}`, depth + 1);
      if (e) return e;
    }
  }
  if (schema.items !== undefined) return schemaError(schema.items, `${at}.items`, depth + 1);
  return null;
}

const typeOf = (v: unknown): SchemaType => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : (typeof v as SchemaType));
const fits = (t: SchemaType, actual: SchemaType) => t === actual || (t === "number" && actual === "integer");

function check(schema: CardSchema, v: unknown, path: string): CardDataError | null {
  if (schema.type !== undefined) {
    const list = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(v);
    if (!list.some((t) => fits(t, actual))) return { path, why: `must be ${list.join(" or ")}` };
  }
  if (schema.enum && !schema.enum.some((e) => e === v)) return { path, why: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` };
  if (typeof v === "string") {
    const n = [...v].length;
    if (schema.minLength !== undefined && n < schema.minLength) return { path, why: schema.minLength === 1 ? "is empty" : `is shorter than ${schema.minLength} characters` };
    if (schema.maxLength !== undefined && n > schema.maxLength) return { path, why: `is longer than ${schema.maxLength} characters` };
  }
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) return { path, why: `has fewer than ${schema.minItems} items` };
    if (schema.maxItems !== undefined && v.length > schema.maxItems) return { path, why: `has more than ${schema.maxItems} items` };
    if (schema.items) for (let i = 0; i < v.length; i++) {
      const e = check(schema.items, v[i], `${path}[${i}]`);
      if (e) return e;
    }
  }
  if (isObject(v)) {
    for (const r of schema.required ?? []) if (!(r in v)) return { path: path === "data" ? r : `${path}.${r}`, why: "is missing" };
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (!(name in v)) continue;
      const e = check(sub, v[name], path === "data" ? name : `${path}.${name}`);
      if (e) return e;
    }
  }
  return null;
}

/** A view card's data checked against its type's shape: ok, or the first field that broke a rule. */
export function checkViewData(schema: unknown, data: unknown): { ok: true; data: unknown } | { ok: false; error: CardDataError } {
  const bytes = cardDataBytes(data);
  if (bytes === undefined) return { ok: false, error: { path: "data", why: "is not JSON" } };
  if (bytes > CARD_DATA_MAX_BYTES) return { ok: false, error: { path: "data", why: `is larger than ${CARD_DATA_MAX_BYTES / 1024} KB` } };
  if (schemaError(schema)) return { ok: false, error: { path: "data", why: "has no shape this Sova can check" } };
  const e = check(schema as CardSchema, data, "data");
  return e ? { ok: false, error: e } : { ok: true, data: JSON.parse(JSON.stringify(data)) };
}
