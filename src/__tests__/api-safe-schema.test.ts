import { describe, expect, it } from "vitest";
import { z } from "zod";

import { apiSafeJsonSchema, apiSafeSchema } from "@/lib/ai/api-safe-schema";

async function wireSchema(schema: {
  jsonSchema: unknown | PromiseLike<unknown>;
}): Promise<Record<string, unknown>> {
  return (await schema.jsonSchema) as Record<string, unknown>;
}

describe("apiSafeSchema", () => {
  const zodSchema = z.object({
    facts: z
      .array(
        z.object({
          category: z.enum(["background", "story"]),
          fact: z.string().max(500),
        }),
      )
      .max(25),
    score: z.number().min(0).max(10).optional(),
  });

  it("strips unsupported constraint keywords from the wire schema", async () => {
    const wire = await wireSchema(apiSafeSchema(zodSchema));
    const serialized = JSON.stringify(wire);
    for (const keyword of [
      "maxItems",
      "minItems",
      "maxLength",
      "minLength",
      '"minimum"',
      '"maximum"',
    ]) {
      expect(serialized).not.toContain(keyword);
    }
    // The structure itself survives.
    const facts = (wire.properties as Record<string, unknown>).facts as Record<
      string,
      unknown
    >;
    expect(facts.type).toBe("array");
  });

  it("keeps enum values and required lists intact", async () => {
    const wire = await wireSchema(apiSafeSchema(zodSchema));
    expect(JSON.stringify(wire)).toContain('"background"');
    expect(wire.required).toEqual(["facts"]);
  });

  it("still validates bounds client-side via the original Zod schema", () => {
    const schema = apiSafeSchema(zodSchema);
    const tooMany = {
      facts: Array.from({ length: 26 }, () => ({
        category: "story",
        fact: "x",
      })),
    };
    expect(schema.validate!(tooMany)).toMatchObject({ success: false });
    expect(
      schema.validate!({
        facts: [{ category: "story", fact: "a real fact" }],
      }),
    ).toMatchObject({ success: true });
  });

  it("does not strip a property that is named like a keyword", async () => {
    const named = z.object({ maxItems: z.string() });
    const wire = await wireSchema(apiSafeSchema(named));
    expect((wire.properties as Record<string, unknown>).maxItems).toBeDefined();
  });

  it("strips keywords nested inside anyOf branches", async () => {
    const wire = await wireSchema(
      apiSafeJsonSchema({
        anyOf: [
          { type: "array", items: { type: "string" }, maxItems: 3 },
          { type: "string", minLength: 2 },
        ],
      }),
    );
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain("maxItems");
    expect(serialized).not.toContain("minLength");
    expect((wire.anyOf as unknown[]).length).toBe(2);
  });

  it("strips keywords from tuple-style items arrays", async () => {
    const wire = await wireSchema(
      apiSafeJsonSchema({
        type: "array",
        items: [
          { type: "string", maxLength: 5 },
          { type: "number", minimum: 0 },
        ],
      }),
    );
    const serialized = JSON.stringify(wire);
    expect(serialized).not.toContain("maxLength");
    expect(serialized).not.toContain('"minimum"');
    expect((wire.items as unknown[]).length).toBe(2);
  });

  it("treats dependentSchemas values as schemas and dependentRequired as data", async () => {
    const wire = await wireSchema(
      apiSafeJsonSchema({
        type: "object",
        properties: { a: { type: "string" } },
        dependentSchemas: {
          maxItems: { type: "object", minProperties: 1 },
        },
        dependentRequired: { a: ["maxItems"] },
      }),
    );
    const dependents = wire.dependentSchemas as Record<string, unknown>;
    // The key named like a keyword survives; the schema under it is stripped.
    expect(dependents.maxItems).toBeDefined();
    expect(JSON.stringify(dependents)).not.toContain("minProperties");
    // dependentRequired values are property-name data, untouched.
    expect(wire.dependentRequired).toEqual({ a: ["maxItems"] });
  });
});

describe("apiSafeJsonSchema", () => {
  it("strips keywords from raw recipe schemas without mutating the input", async () => {
    const raw = {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, maxItems: 5 },
      },
    };
    const wire = await wireSchema(apiSafeJsonSchema(raw));
    expect(JSON.stringify(wire)).not.toContain("maxItems");
    // Input untouched: recipes are shared objects.
    expect(raw.properties.items.maxItems).toBe(5);
  });
});
