import { asSchema, jsonSchema } from "ai";
import type { Schema } from "ai";
import type { z } from "zod";

/**
 * JSON Schema keywords Claude's structured outputs API rejects with a 400
 * (e.g. "For 'array' type, property 'maxItems' is not supported"). The
 * official Anthropic SDK strips these client-side; the AI SDK passes Zod
 * bounds like `.max(25)` straight through as `maxItems`, so any constrained
 * schema handed to `generateObject` fails before the model ever runs.
 */
const UNSUPPORTED_KEYWORDS = [
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
] as const;

/** Sub-objects whose values are schemas but whose KEYS are user-chosen names. */
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

/** Keys whose values are data (enum members, defaults), not schema nodes. */
const DATA_KEYS = new Set([
  "enum",
  "const",
  "examples",
  "default",
  // Maps property names to lists of property names: no schemas inside.
  "dependentRequired",
]);

/**
 * Deletes unsupported constraint keywords from a JSON schema in place,
 * recursing through nested schemas. Property maps are special-cased so a
 * property that happens to be NAMED "maxItems" survives.
 */
function stripUnsupported(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripUnsupported(item);
    return;
  }
  if (!node || typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  for (const keyword of UNSUPPORTED_KEYWORDS) delete obj[keyword];

  for (const [key, value] of Object.entries(obj)) {
    if (DATA_KEYS.has(key)) continue;
    if (SCHEMA_MAPS.has(key)) {
      if (value && typeof value === "object") {
        for (const sub of Object.values(value)) stripUnsupported(sub);
      }
    } else if (value && typeof value === "object") {
      stripUnsupported(value);
    }
  }
}

/**
 * Wraps a Zod schema for `generateObject`/`streamObject` so the wire schema
 * contains no keywords the structured outputs API rejects, while the full Zod
 * schema (bounds included) still validates the response client-side. Use this
 * at every `generateObject` call site instead of passing the Zod schema
 * directly.
 */
export function apiSafeSchema<T>(schema: z.ZodType<T>): Schema<T> {
  return jsonSchema<T>(
    async () => {
      const wire = structuredClone(await asSchema(schema).jsonSchema);
      stripUnsupported(wire);
      return wire;
    },
    {
      validate: (value) => {
        const parsed = schema.safeParse(value);
        return parsed.success
          ? { success: true, value: parsed.data }
          : { success: false, error: parsed.error };
      },
    },
  );
}

/**
 * Same stripping for a raw JSON schema (signal recipes carry their own
 * hand-written schemas). Returns an AI SDK schema; no client-side validation
 * beyond JSON shape, matching the previous `jsonSchema(raw)` behavior.
 */
export function apiSafeJsonSchema(raw: object): Schema<unknown> {
  const wire = structuredClone(raw);
  stripUnsupported(wire);
  return jsonSchema(wire as Parameters<typeof jsonSchema>[0]);
}
