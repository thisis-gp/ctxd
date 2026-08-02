import { readFile } from "node:fs/promises";
import { SemanticError } from "./errors.js";
import { z } from "zod";

export interface SemanticDefinition {
  id: string;
  name: string;
  synonyms: string[];
  description: string;
  table: string;
  columns: string[];
  definition: string;
  sqlTemplate: string;
  measureExpression?: string;
  defaultFilter?: string;
  dimensions?: Record<string, SemanticDimension>;
  databaseName?: string;
  databaseId?: number;
}

export interface SemanticDimension {
  name: string;
  expression: string;
  synonyms: string[];
}

export interface SemanticFilter {
  field: string;
  operator: "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "is_null" | "is_not_null";
  value?: string | number | boolean | Array<string | number | boolean>;
}

export interface SemanticQuery {
  measures: string[];
  dimensions?: string[];
  filters?: SemanticFilter[];
  orderBy?: { field: string; direction?: "asc" | "desc" }[];
  limit?: number;
}

export interface SemanticMatch {
  definition: SemanticDefinition;
  score: number;
}

export const zSemanticQuery = z.object({
  measures: z.array(z.string()).min(1),
  dimensions: z.array(z.string()).optional(),
  filters: z.array(z.object({
    field: z.string(),
    operator: z.enum(["=", "!=", ">", ">=", "<", "<=", "in", "is_null", "is_not_null"]),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]).optional(),
  })).optional(),
  orderBy: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).optional() })).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  // Strict: an agent that passes an unknown key (e.g. `execute`, which is a CLI
  // flag, not part of the query) must get an error rather than silently
  // receiving a different query than the one it thinks it asked for.
}).strict();

export async function loadSemanticDefinitions(file: string): Promise<SemanticDefinition[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new SemanticError(`Could not read semantic definitions at ${file}: ${(err as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new SemanticError(`Semantic definitions are not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(value)) throw new SemanticError("Semantic definitions must be a JSON array.");
  return parseSemanticDefinitions(value);
}

export function parseSemanticDefinitions(value: unknown): SemanticDefinition[] {
  if (!Array.isArray(value)) throw new SemanticError("Semantic definitions must be a JSON array.");
  return value.map((item, index) => validateDefinition(item, index));
}

function validateDefinition(value: unknown, index: number): SemanticDefinition {
  if (!value || typeof value !== "object") throw new SemanticError(`Semantic definition ${index} must be an object.`);
  const v = value as Record<string, unknown>;
  const strings = (key: string): string[] => {
    const x = v[key];
    if (!Array.isArray(x) || x.some((item) => typeof item !== "string")) {
      throw new SemanticError(`Semantic definition ${index}.${key} must be an array of strings.`);
    }
    return x as string[];
  };
  const required = (key: string): string => {
    if (typeof v[key] !== "string" || !(v[key] as string).trim()) {
      throw new SemanticError(`Semantic definition ${index}.${key} is required.`);
    }
    return (v[key] as string).trim();
  };
  const databaseId = v.databaseId;
  if (databaseId !== undefined && (!Number.isInteger(databaseId) || (databaseId as number) < 1)) {
    throw new SemanticError(`Semantic definition ${index}.databaseId must be a positive integer.`);
  }
  return {
    id: required("id"),
    name: required("name"),
    synonyms: strings("synonyms"),
    description: required("description"),
    table: required("table"),
    columns: strings("columns"),
    definition: required("definition"),
    sqlTemplate: required("sqlTemplate"),
    ...(v.measureExpression === undefined ? {} : { measureExpression: required("measureExpression") }),
    ...(v.defaultFilter === undefined ? {} : { defaultFilter: required("defaultFilter") }),
    ...(v.dimensions === undefined ? {} : { dimensions: validateDimensions(v.dimensions, index) }),
    ...(v.databaseName === undefined ? {} : { databaseName: required("databaseName") }),
    ...(databaseId === undefined ? {} : { databaseId: databaseId as number }),
  };
}

function validateDimensions(value: unknown, index: number): Record<string, SemanticDimension> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SemanticError(`Semantic definition ${index}.dimensions must be an object.`);
  }
  const result: Record<string, SemanticDimension> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SemanticError(`Semantic definition ${index}.dimensions.${id} must be an object.`);
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.expression !== "string" || !Array.isArray(item.synonyms)) {
      throw new SemanticError(`Semantic definition ${index}.dimensions.${id} requires name, expression, and synonyms.`);
    }
    if (item.synonyms.some((synonym) => typeof synonym !== "string")) {
      throw new SemanticError(`Semantic definition ${index}.dimensions.${id}.synonyms must contain strings.`);
    }
    result[id] = { name: item.name, expression: item.expression, synonyms: item.synonyms as string[] };
  }
  return result;
}

function quoteLiteral(value: string | number | boolean): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SemanticError("Semantic filter numbers must be finite.");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${value.replace(/'/g, "''")}'`;
}

function compileFilter(filter: SemanticFilter, definitions: SemanticDefinition[]): string {
  const owner = definitions.find((definition) => definition.dimensions?.[filter.field]);
  const dimension = owner?.dimensions?.[filter.field];
  if (!dimension) throw new SemanticError(`Unknown semantic filter field "${filter.field}".`);
  if (filter.operator === "is_null" || filter.operator === "is_not_null") {
    return `${dimension.expression} ${filter.operator === "is_null" ? "IS NULL" : "IS NOT NULL"}`;
  }
  if (filter.value === undefined) throw new SemanticError(`Filter "${filter.field}" requires a value.`);
  if (filter.operator === "in") {
    if (!Array.isArray(filter.value) || filter.value.length === 0) throw new SemanticError(`IN filter "${filter.field}" requires a non-empty value array.`);
    return `${dimension.expression} IN (${filter.value.map(quoteLiteral).join(", ")})`;
  }
  if (Array.isArray(filter.value)) throw new SemanticError(`Filter "${filter.field}" cannot use an array value.`);
  return `${dimension.expression} ${filter.operator} ${quoteLiteral(filter.value)}`;
}

export function compileSemanticQuery(query: SemanticQuery, definitions: SemanticDefinition[]): string {
  if (!Array.isArray(query.measures) || query.measures.length === 0) {
    throw new SemanticError("A semantic query requires at least one measure.");
  }
  const selected = query.measures.map((id) => {
    const definition = definitions.find((item) => item.id === id);
    if (!definition) throw new SemanticError(`Unknown semantic measure "${id}".`);
    return definition;
  });
  const tables = new Set(selected.map((item) => item.table));
  if (tables.size !== 1) {
    throw new SemanticError("This semantic query needs a reviewed join graph because its measures use different tables.");
  }
  const table = selected[0]!.table;
  const dimensions = query.dimensions ?? [];
  const dimensionOwners = dimensions.map((id) => {
    const owner = selected.find((item) => item.dimensions?.[id]);
    const dimension = owner?.dimensions?.[id];
    if (!dimension) throw new SemanticError(`Unknown semantic dimension "${id}" for the selected measures.`);
    return { id, expression: dimension.expression };
  });
  const aliasFor = (id: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) throw new SemanticError(`Invalid semantic identifier "${id}".`);
    return id;
  };
  const projections = dimensionOwners.map((dimension) => `${dimension.expression} AS "${aliasFor(dimension.id)}"`);
  const measureAliases = new Map<string, string>();
  const measureParts: Array<{ expression: string; alias: string; defaultFilter?: string; id: string }> = [];
  for (const measure of selected) {
    const expression = measure.measureExpression;
    if (!expression) {
      if (selected.length > 1 || dimensions.length > 0) {
        throw new SemanticError(`Measure "${measure.id}" has no composable measureExpression; use its canonical query directly.`);
      }
      return measure.sqlTemplate;
    }
    const alias = aliasFor(measure.id.replace(/[^a-zA-Z0-9_]+/g, "_"));
    measureAliases.set(measure.id, alias);
    measureParts.push({ expression, alias, defaultFilter: measure.defaultFilter, id: measure.id });
  }
  // SQL allows FILTER (WHERE ...) only directly after an aggregate call, so a
  // measureExpression like ROUND(AVG(x), 2) or SUM(x) / 100.0 cannot carry one.
  // For those the filter has to move into WHERE, which is only equivalent when
  // every selected measure shares it — otherwise we would silently widen or
  // narrow the others. Emitting the invalid form instead produced SQL that failed
  // at the database and surfaced as an empty result with no error.
  const offender = measureParts.find(
    (part) => part.defaultFilter && !isBareAggregateCall(part.expression),
  );
  const needsHoist = offender !== undefined;
  if (needsHoist && new Set(measureParts.map((part) => part.defaultFilter ?? "")).size > 1) {
    throw new SemanticError(
      `Measure "${offender.id}" has measureExpression "${offender.expression}", which is not a plain aggregate call, so its filter must be applied in WHERE — but the selected measures do not share the same defaultFilter. Query these measures separately, or change measureExpression to a plain aggregate such as AVG(x) so the filter can be applied per measure.`,
    );
  }
  const hoistedFilter = needsHoist ? offender.defaultFilter : undefined;
  for (const part of measureParts) {
    const condition =
      part.defaultFilter && !needsHoist ? ` FILTER (WHERE ${part.defaultFilter})` : "";
    projections.push(`${part.expression}${condition} AS "${part.alias}"`);
  }
  const filters = (query.filters ?? []).map((filter) => compileFilter(filter, selected));
  if (hoistedFilter) filters.unshift(`(${hoistedFilter})`);
  const sql = [`SELECT ${projections.join(", ")}`, `FROM ${table}`];
  if (filters.length) sql.push(`WHERE ${filters.join(" AND ")}`);
  if (dimensionOwners.length) sql.push(`GROUP BY ${dimensionOwners.map((item) => item.expression).join(", ")}`);
  if (query.orderBy?.length) {
    const allowed = new Set([...dimensions, ...selected.map((item) => item.id)]);
    for (const order of query.orderBy) {
      if (!allowed.has(order.field)) throw new SemanticError(`Unknown semantic order field "${order.field}".`);
    }
    sql.push(`ORDER BY ${query.orderBy.map((order) => {
      const alias = measureAliases.get(order.field) ?? order.field;
      return `"${aliasFor(alias)}" ${(order.direction ?? "asc").toUpperCase()}`;
    }).join(", ")}`);
  }
  const limit = query.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new SemanticError("Semantic query limit must be an integer between 1 and 1000.");
  sql.push(`LIMIT ${limit}`);
  return `${sql.join("\n")};`;
}

function tokens(text: string): Set<string> {
  const stopwords = new Set(["a", "an", "and", "are", "did", "do", "does", "for", "how", "is", "many", "of", "receive", "received", "the", "to", "we", "what", "when", "where", "which", "who", "why"]);
  return new Set(text.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token && !stopwords.has(token)));
}

export function matchSemanticDefinitions(
  question: string,
  definitions: SemanticDefinition[],
  limit = 5,
): SemanticDefinition[] {
  return rankSemanticDefinitions(question, definitions, limit).map((hit) => hit.definition);
}

export function rankSemanticDefinitions(
  question: string,
  definitions: SemanticDefinition[],
  limit = 5,
): SemanticMatch[] {
  const q = tokens(question);
  const normalizedQuestion = normalizePhrase(question);
  return definitions
    .map((definition) => {
      const phrases = [definition.name, ...definition.synonyms];
      const score = phrases.reduce((best, phrase) => {
        const phraseTokens = tokens(phrase);
        const overlap = [...phraseTokens].filter((token) => q.has(token)).length;
        const normalizedPhrase = normalizePhrase(phrase);
        const exact = normalizedPhrase && normalizedQuestion.includes(normalizedPhrase) ? 5 : 0;
        return Math.max(best, overlap + exact);
      }, 0);
      return { definition, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.definition.id.localeCompare(b.definition.id))
    .slice(0, limit)
    .map((hit) => ({ definition: hit.definition, score: hit.score }));
}

const AGGREGATE_NAMES = new Set([
  "count", "sum", "avg", "min", "max", "bool_and", "bool_or", "every",
  "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "var_samp",
  "array_agg", "string_agg", "jsonb_agg", "json_agg", "bit_and", "bit_or",
]);

/**
 * True when the expression is a single aggregate call and nothing else, e.g.
 * `AVG(rating)` or `COUNT(*)`. Only then may a FILTER (WHERE ...) clause follow
 * it. `ROUND(AVG(x), 2)` and `SUM(x) / 100.0` are not, because the aggregate is
 * not the outermost node.
 */
export function isBareAggregateCall(expression: string): boolean {
  const trimmed = expression.trim();
  const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(trimmed);
  if (!match) return false;
  if (!AGGREGATE_NAMES.has((match[1] ?? "").toLowerCase())) return false;
  // The call's closing paren must be the final character, otherwise something
  // wraps or follows the aggregate.
  let depth = 0;
  for (let i = trimmed.indexOf("("); i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i === trimmed.length - 1;
    }
  }
  return false;
}

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function validateSemanticDefinitions(
  definitions: SemanticDefinition[],
  model: { entities: Array<{ kind: string; qualifiedName: string; databaseName: string }> },
): void {
  const tables = new Set(model.entities.filter((entity) => entity.kind === "table").map((entity) => entity.qualifiedName.toLowerCase()));
  const databases = new Set(model.entities.filter((entity) => entity.kind === "database").map((entity) => entity.databaseName.toLowerCase()));
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (!/^[A-Za-z0-9_.-]+$/.test(definition.id) || ids.has(definition.id)) {
      throw new SemanticError(`Semantic definition id must be unique and contain only letters, numbers, _, ., or -: "${definition.id}".`);
    }
    ids.add(definition.id);
    if (!tables.has(definition.table.toLowerCase())) {
      throw new SemanticError(`Semantic definition "${definition.id}" references missing table "${definition.table}".`);
    }
    if (definition.databaseName && !databases.has(definition.databaseName.toLowerCase())) {
      throw new SemanticError(`Semantic definition "${definition.id}" references missing database "${definition.databaseName}".`);
    }
  }
}
