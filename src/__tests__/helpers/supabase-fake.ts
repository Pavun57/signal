import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A Supabase fake that models the query layer instead of ignoring it.
 *
 * Every hand-rolled fake in this suite used to return whole fixture objects
 * regardless of the `.select()` column list, and most treated `.eq()` as a
 * no-op. Mutation testing found nine production reverts that passed the entire
 * suite because of it, four of them column-list drops and three of them dropped
 * predicates. The worst failed unsafe: removing `affiliation_source` from the
 * select in `recordAffiliation` makes every row read as legacy data, which
 * collapses the monotonic guard and lets refused detaches through.
 *
 * The type system cannot help here. A `.select()` argument is a plain string, so
 * a predicate reading a column nobody asked for is a compile-time non-event and
 * a runtime `undefined`. This fake is the only thing that can guard it:
 *
 * - `select()` projects. Reading a column that was not selected throws and names
 *   the column, so the failure says what is wrong instead of quietly reading
 *   `undefined` and taking the wrong branch.
 * - `eq()`, `in()` and `not(col, "is", null)` actually filter.
 * - `limit(n)` truncates. Ownership checks pair it with `maybeSingle()`
 *   precisely because a contact can sit in several campaigns, so a fake that
 *   ignored it would turn the normal case into a PGRST116 error.
 * - `single()` and `maybeSingle()` follow PostgREST: `single()` is an error
 *   unless exactly one row matched, `maybeSingle()` unless at most one did. A
 *   dropped predicate therefore fails loudly rather than picking row zero.
 *
 * Deliberately not a general PostgREST parser. It supports the syntax the tests
 * in this repo actually use and throws on anything else, so the next person gets
 * an error rather than a silent wrong answer.
 */

export type FakeRow = Record<string, unknown>;

export interface FakeRelation {
  /** Column on the parent row holding the foreign key. */
  localKey: string;
  /** Column on the embedded table it points at. Defaults to "id". */
  foreignKey?: string;
}

export type QueryKind = "select" | "update" | "delete" | "insert";

export interface ObservedQuery {
  table: string;
  kind: QueryKind;
  /** The raw string handed to `select()`, or null for a bare update. */
  select: string | null;
  filters: readonly Filter[];
  /** The payload handed to `update()` or `insert()`, or null for a read. */
  payload: FakeRow | null;
}

export interface SupabaseFakeOptions {
  /**
   * The tables this fake serves, one getter per table. Getters rather than
   * arrays so a test can reassign its fixture between cases and the fake still
   * reads the current one. A query against an unregistered table throws.
   */
  tables: Record<string, () => FakeRow[]>;
  /**
   * Embedded resource joins, keyed by parent table then by the alias used in the
   * select string. `person:people!inner(...)` on `campaign_people` needs
   * `{ campaign_people: { person: { localKey: "person_id" } } }`.
   */
  relations?: Record<string, Record<string, FakeRelation>>;
  /**
   * What the next UPDATE should come back with. The real columns carry CHECK
   * constraints, so a rejected write is an ordinary runtime outcome and callers
   * have to read the error.
   */
  updateError?: () => { message: string } | null;
  /**
   * What a SELECT against the named table should fail with, if anything. A
   * failed read is an ordinary runtime outcome (network blip, RLS, dropped
   * column), and the difference between "the query failed" and "no rows"
   * is exactly what several production bugs collapsed.
   */
  selectError?: (table: string) => { message: string } | null;
  /**
   * What the next INSERT should fail with, if anything. Unique indexes make a
   * rejected insert an ordinary runtime outcome (`code: "23505"`), and the
   * dedup helpers branch on that code, so a test has to be able to inject it.
   */
  insertError?: () => { message: string; code?: string } | null;
  /** Called as each query resolves. Lets a test assert on what was asked for. */
  onQuery?: (query: ObservedQuery) => void;
}

export type Filter =
  | { op: "eq"; column: string; value: unknown }
  | { op: "in"; column: string; values: readonly unknown[] }
  | { op: "is"; column: string; value: null }
  | { op: "isNot"; column: string; value: null };

interface SelectSpec {
  star: boolean;
  columns: string[];
  embeds: Array<{
    alias: string;
    table: string;
    inner: boolean;
    /**
     * FK-column disambiguation hint (`alias:table!column(...)`), used when
     * two FKs link the same pair of tables. The fake checks it against the
     * registered relation's localKey so a hint naming the wrong column fails
     * here the same way PostgREST would fail it in production.
     */
    hint: string | null;
    spec: SelectSpec;
  }>;
  /** The original string, quoted back in error messages. */
  source: string;
}

const EMBED =
  /^([a-z_][a-z0-9_]*)\s*:\s*([a-z_][a-z0-9_]*)(![a-z0-9_]+)?\s*\(([\s\S]*)\)$/i;
const PLAIN_COLUMN = /^[a-z_][a-z0-9_]*$/i;

/**
 * Keys that JS, vitest and jsdom probe on any object they are handed. They are
 * not columns, so a miss on one is not a bug and must not throw. Everything
 * reachable through Object.prototype (`toString`, `constructor`, ...) already
 * satisfies the `in` check and never reaches this set.
 */
const PROBE_KEYS = new Set<string>([
  "then",
  "catch",
  "finally",
  "toJSON",
  "nodeType",
  "tagName",
  "$$typeof",
  "asymmetricMatch",
  "_isMockFunction",
  "@@__IMMUTABLE_ITERABLE__@@",
  "@@__IMMUTABLE_RECORD__@@",
  "@@__IMMUTABLE_LIST__@@",
  "@@__IMMUTABLE_MAP__@@",
  "@@__IMMUTABLE_SET__@@",
]);

/** Splits a select string on commas that are not inside an embed's parens. */
function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of source) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (depth !== 0) {
    throw new Error(
      `[supabase fake] unbalanced parentheses in select("${source}")`,
    );
  }
  parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

export function parseSelect(source: string): SelectSpec {
  const spec: SelectSpec = {
    star: false,
    columns: [],
    embeds: [],
    source,
  };

  for (const part of splitTopLevel(source)) {
    if (part === "*") {
      spec.star = true;
      continue;
    }

    const embed = EMBED.exec(part);
    if (embed) {
      const [, alias, table, modifier, inner] = embed;
      spec.embeds.push({
        alias,
        table,
        inner: modifier === "!inner",
        hint: modifier && modifier !== "!inner" ? modifier.slice(1) : null,
        spec: parseSelect(inner),
      });
      continue;
    }

    if (PLAIN_COLUMN.test(part)) {
      spec.columns.push(part);
      continue;
    }

    throw new Error(
      `[supabase fake] unsupported select syntax "${part}" in select("${source}"). This fake implements plain columns, "*", and embedded resources of the form alias:table(cols) or alias:table!inner(cols). Add support for the form you need rather than working around it.`,
    );
  }

  return spec;
}

/** Every name the caller is allowed to read off a row projected by `spec`. */
function selected(spec: SelectSpec): string[] {
  return [...spec.columns, ...spec.embeds.map((e) => e.alias)];
}

/**
 * Wraps a projected row so that reading a column the select did not ask for is
 * an error naming the column, rather than an `undefined` that quietly flips a
 * predicate.
 */
function guard(table: string, target: FakeRow, spec: SelectSpec): FakeRow {
  // `select("*")` asked for everything, so there is nothing to guard.
  if (spec.star) return target;

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      if (prop in t) return Reflect.get(t, prop, receiver);
      if (PROBE_KEYS.has(prop)) return undefined;
      const asked = selected(spec).join(", ") || "(nothing)";
      throw new Error(
        `[supabase fake] "${prop}" was read off a ${table} row, but select("${spec.source}") did not ask for it (asked for: ${asked}). Either the production select is missing the column, or the code is reading a column it never requested. Against a real database this would be undefined and the predicate reading it would silently take the wrong branch.`,
      );
    },
  });
}

function matchesFilter(filter: Filter, row: FakeRow): boolean {
  switch (filter.op) {
    case "eq":
      return row[filter.column] === filter.value;
    case "in":
      return filter.values.includes(row[filter.column]);
    case "is":
      return row[filter.column] === null || row[filter.column] === undefined;
    case "isNot":
      return row[filter.column] !== null && row[filter.column] !== undefined;
  }
}

const NOT_ONE_ROW = (table: string, count: number) => ({
  code: "PGRST116",
  message: `JSON object requested, multiple (or no) rows returned: ${count} rows matched on "${table}"`,
  details: "",
  hint: "",
});

export function createSupabaseFake(
  options: SupabaseFakeOptions,
): SupabaseClient {
  const rowsOf = (table: string): FakeRow[] => {
    const getter = options.tables[table];
    if (!getter) {
      throw new Error(
        `[supabase fake] no rows registered for table "${table}". Seed it in the test, or the query under test is reading a table nobody expected.`,
      );
    }
    return getter();
  };

  /** Returns null when an `!inner` embed found no match, meaning "drop the row". */
  function project(
    table: string,
    row: FakeRow,
    spec: SelectSpec,
  ): FakeRow | null {
    const target: FakeRow = {};
    if (spec.star) Object.assign(target, row);
    for (const column of spec.columns) target[column] = row[column];

    for (const embed of spec.embeds) {
      const relation = options.relations?.[table]?.[embed.alias];
      if (!relation) {
        throw new Error(
          `[supabase fake] select("${spec.source}") embeds "${embed.alias}" on "${table}", but no relation is registered for it. Declare it in the fake's \`relations\` so the join is modelled rather than guessed.`,
        );
      }
      if (embed.hint && embed.hint !== relation.localKey) {
        throw new Error(
          `[supabase fake] select("${spec.source}") hints "${embed.alias}" through "${embed.hint}", but the registered relation joins via "${relation.localKey}". Either the hint names the wrong FK column or the relation registration is stale.`,
        );
      }
      const foreignKey = relation.foreignKey ?? "id";
      const key = row[relation.localKey];
      const match = rowsOf(embed.table).find((r) => r[foreignKey] === key);
      const nested = match ? project(embed.table, match, embed.spec) : null;
      if (!nested) {
        if (embed.inner) return null;
        target[embed.alias] = null;
        continue;
      }
      target[embed.alias] = nested;
    }

    return guard(table, target, spec);
  }

  function chain(table: string) {
    let spec: SelectSpec | null = null;
    let kind: QueryKind = "select";
    let updates: FakeRow | null = null;
    let take: number | null = null;
    const filters: Filter[] = [];

    const raw = () =>
      rowsOf(table).filter((r) => filters.every((f) => matchesFilter(f, r)));

    const notify = () => {
      options.onQuery?.({
        table,
        kind,
        select: spec?.source ?? null,
        filters,
        payload: updates,
      });
    };

    const rows = (): FakeRow[] => {
      if (!spec) {
        throw new Error(
          `[supabase fake] a read on "${table}" resolved without calling select(). This fake does not guess a column list.`,
        );
      }
      const out: FakeRow[] = [];
      for (const row of raw()) {
        const projected = project(table, row, spec);
        if (projected) out.push(projected);
        // Applied after projection, since an !inner embed that finds no match
        // drops the row and PostgREST counts what survives the join.
        if (take !== null && out.length >= take) break;
      }
      return out;
    };

    const runUpdate = () => {
      notify();
      const error = options.updateError?.() ?? null;
      if (error) return { data: null, error };
      const matched = raw();
      for (const row of matched) Object.assign(row, updates ?? {});
      // PostgREST returns the updated rows when the caller chains `.select()`,
      // and that is the only way to tell an update whose predicates matched
      // nothing from one that landed. The compare-and-swap in recordAffiliation
      // depends on exactly that distinction.
      return {
        data: spec
          ? matched.map((row) => project(table, row, spec!)).filter(Boolean)
          : null,
        error: null,
      };
    };

    /**
     * Removes the matched rows from the array the table getter returned.
     *
     * Mutating in place rather than reassigning, because the getter owns the
     * fixture and a test that reads it after the call has to see the deletion.
     * A delete with no filters empties the table, exactly as PostgREST would.
     */
    const runDelete = () => {
      notify();
      const error = options.updateError?.() ?? null;
      if (error) return { data: null, error };
      const all = rowsOf(table);
      const removed: FakeRow[] = [];
      for (const row of raw()) {
        const at = all.indexOf(row);
        if (at >= 0) {
          all.splice(at, 1);
          removed.push(row);
        }
      }
      // PostgREST returns the deleted rows when the caller chains `.select()`,
      // and that is the only way to tell a delete that matched nothing from
      // one that worked. Code that checks it -- because an RLS policy can make
      // a delete a silent no-op -- needs the fake to model it, or the check
      // reads as "deleted nothing" and the test passes for the wrong reason.
      return { data: removed, error: null };
    };

    /**
     * Appends the payload to the array the table getter returned, mutating in
     * place for the same reason runDelete does: the getter owns the fixture,
     * and a test reading it after the call has to see the new row. Returns the
     * row so `.select().single()` can hand it back the way PostgREST does.
     */
    const runInsert = () => {
      notify();
      const error = options.insertError?.() ?? null;
      if (error) return { data: null, error };
      const row: FakeRow = { ...(updates ?? {}) };
      rowsOf(table).push(row);
      return { data: row, error: null };
    };

    const runMutation = () =>
      kind === "delete"
        ? runDelete()
        : kind === "insert"
          ? runInsert()
          : runUpdate();

    const readError = () => options.selectError?.(table) ?? null;

    const resolve = () => {
      if (kind !== "select") return runMutation();
      notify();
      const error = readError();
      if (error) return { data: null, error };
      return { data: rows(), error: null };
    };

    const c: Record<string, unknown> & PromiseLike<unknown> = {
      select: (columns = "*") => {
        spec = parseSelect(columns);
        return c;
      },
      update: (payload: FakeRow) => {
        kind = "update";
        updates = payload;
        return c;
      },
      delete: () => {
        kind = "delete";
        return c;
      },
      insert: (payload: FakeRow) => {
        kind = "insert";
        updates = payload;
        return c;
      },
      eq: (column: string, value: unknown) => {
        filters.push({ op: "eq", column, value });
        return c;
      },
      in: (column: string, values: readonly unknown[]) => {
        filters.push({ op: "in", column, values });
        return c;
      },
      limit: (count: number) => {
        take = count;
        return c;
      },
      not: (column: string, operator: string, value: unknown) => {
        if (operator !== "is" || value !== null) {
          throw new Error(
            `[supabase fake] not("${column}", "${operator}", ${String(value)}) is not implemented. Only not(col, "is", null) is.`,
          );
        }
        filters.push({ op: "isNot", column, value: null });
        return c;
      },
      is: (column: string, value: unknown) => {
        if (value !== null) {
          throw new Error(
            `[supabase fake] is("${column}", ${String(value)}) is not implemented. Only is(col, null) is.`,
          );
        }
        filters.push({ op: "is", column, value: null });
        return c;
      },
      single: async () => {
        // insert().select().single() returns the created row, projected the
        // same way a read would be.
        if (kind === "insert") {
          const result = runInsert();
          if (result.error || !result.data) {
            return { data: null, error: result.error };
          }
          return {
            data: spec ? project(table, result.data, spec) : result.data,
            error: null,
          };
        }
        if (kind !== "select") return runMutation();
        notify();
        const error = readError();
        if (error) return { data: null, error };
        const found = rows();
        if (found.length !== 1) {
          return { data: null, error: NOT_ONE_ROW(table, found.length) };
        }
        return { data: found[0], error: null };
      },
      maybeSingle: async () => {
        if (kind !== "select") return runMutation();
        notify();
        const error = readError();
        if (error) return { data: null, error };
        const found = rows();
        if (found.length > 1) {
          return { data: null, error: NOT_ONE_ROW(table, found.length) };
        }
        return { data: found[0] ?? null, error: null };
      },
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => resolve())
          .then(onF, onR),
    } as unknown as Record<string, unknown> & PromiseLike<unknown>;

    return c;
  }

  return { from: (table: string) => chain(table) } as unknown as SupabaseClient;
}
