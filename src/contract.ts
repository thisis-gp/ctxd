import { readFile } from "node:fs/promises";
import { SemanticError } from "./errors.js";
import type { NormalizedModel, Relationship } from "./model.js";
import { assertSafeJoinPath, findApprovedJoinPath } from "./join-graph.js";

export type RelationshipCardinality = "one_to_one" | "many_to_one" | "one_to_many" | "many_to_many" | "unknown";

export interface ContextEntity {
  id: string;
  table: string;
  grain: string;
  name?: string;
  synonyms?: string[];
  description?: string;
}

export interface ContextDimension {
  id: string;
  entity: string;
  expression: string;
  name?: string;
  synonyms?: string[];
  description?: string;
}

export interface ContextMeasure {
  id: string;
  entity: string;
  expression: string;
  name?: string;
  synonyms?: string[];
  description?: string;
  defaultFilter?: string;
}

export interface ContextJoin {
  id: string;
  from: string;
  to: string;
  fromColumn: string;
  toColumn: string;
  relationship: RelationshipCardinality;
  approved: boolean;
  fanoutRisk?: "none" | "low" | "high";
  description?: string;
}

export interface ContextContract {
  version: 1;
  project: string;
  description?: string;
  entities: ContextEntity[];
  dimensions: ContextDimension[];
  measures: ContextMeasure[];
  joins: ContextJoin[];
  policies?: { maxRows?: number; allowedSchemas?: string[] };
}

export interface ContractQuery {
  measures: string[];
  dimensions?: string[];
  filters?: Array<{ field: string; operator: "=" | "!=" | ">" | ">=" | "<" | "<="; value: string | number | boolean }>;
  limit?: number;
}

/** Compile a query against the reviewed contract, never against inferred FK paths. */
export function compileContractQuery(query: ContractQuery, contract: ContextContract): string {
  const allowedSchemas = contract.policies?.allowedSchemas;
  for (const entity of contract.entities) assertAllowedSchema(entity.table, allowedSchemas);
  const measures = query.measures.map((id) => {
    const item = contract.measures.find((measure) => measure.id === id);
    if (!item) throw new SemanticError(`Unknown contract measure "${id}".`);
    return item;
  });
  if (!measures.length) throw new SemanticError("A contract query requires at least one measure.");
  const dimensions = (query.dimensions ?? []).map((id) => {
    const item = contract.dimensions.find((dimension) => dimension.id === id);
    if (!item) throw new SemanticError(`Unknown contract dimension "${id}".`);
    return item;
  });
  const anchor = measures[0]!.entity;
  const entityIds = new Set([anchor, ...measures.map((item) => item.entity), ...dimensions.map((item) => item.entity)]);
  const joins = new Map<string, ContextJoin>();
  for (const entity of [...entityIds].filter((item) => item !== anchor)) {
    const path = findApprovedJoinPath(contract, anchor, entity);
    assertSafeJoinPath(path);
    for (const join of path.joins) joins.set(join.id, join);
  }
  const entities = contract.entities.filter((item) => entityIds.has(item.id));
  const aliases = new Map(entities.map((item) => [item.id, `e${[...entityIds].indexOf(item.id)}`]));
  const quote = (value: string | number | boolean): string => typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  const expression = (value: string, entity: string): string => value.includes(".") ? value : `${aliases.get(entity)}.${value}`;
  const projections = [...dimensions.map((item) => `${expression(item.expression, item.entity)} AS "${item.id}"`), ...measures.map((item) => `${item.expression.includes("(") ? item.expression.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (token) => token === "COUNT" || token === "SUM" || token === "AVG" || token === "MIN" || token === "MAX" ? token : token) : expression(item.expression, item.entity)} AS "${item.id}"`)];
  const from = `FROM ${entities.find((item) => item.id === anchor)!.table} ${aliases.get(anchor)}`;
  const joinSql: string[] = [];
  const connected = new Set([anchor]);
  const pendingJoins = [...joins.values()];
  while (pendingJoins.length) {
    const index = pendingJoins.findIndex((join) => (connected.has(join.from) && entityIds.has(join.to) && !connected.has(join.to)) || (connected.has(join.to) && entityIds.has(join.from) && !connected.has(join.from)));
    if (index < 0) throw new SemanticError("Contract join graph cannot connect all selected entities from the measure anchor.");
    const join = pendingJoins.splice(index, 1)[0];
    if (!join) throw new SemanticError("Contract join graph produced an empty join edge.");
    const forward = connected.has(join.from);
    const fromEntity = contract.entities.find((item) => item.id === join.from);
    const toEntity = contract.entities.find((item) => item.id === join.to);
    if (!fromEntity || !toEntity) throw new SemanticError(`Join "${join.id}" references missing entities.`);
    const nextEntity = forward ? toEntity : fromEntity;
    const left = forward ? `${aliases.get(fromEntity.id)}.${join.fromColumn}` : `${aliases.get(toEntity.id)}.${join.toColumn}`;
    const right = forward ? `${aliases.get(toEntity.id)}.${join.toColumn}` : `${aliases.get(fromEntity.id)}.${join.fromColumn}`;
    joinSql.push(`JOIN ${nextEntity.table} ${aliases.get(nextEntity.id)} ON ${left} = ${right}`);
    connected.add(nextEntity.id);
  }
  const filters = (query.filters ?? []).map((filter) => {
    const dimension = contract.dimensions.find((item) => item.id === filter.field);
    if (!dimension) throw new SemanticError(`Unknown contract filter field "${filter.field}".`);
    return `${expression(dimension.expression, dimension.entity)} ${filter.operator} ${quote(filter.value)}`;
  });
  const sql = [`SELECT ${projections.join(", ")}`, from, ...joinSql];
  if (filters.length) sql.push(`WHERE ${filters.join(" AND ")}`);
  if (dimensions.length) sql.push(`GROUP BY ${dimensions.map((item) => expression(item.expression, item.entity)).join(", ")}`);
  const limit = query.limit ?? contract.policies?.maxRows ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new SemanticError("Contract query limit must be between 1 and 1000.");
  sql.push(`LIMIT ${limit};`);
  return sql.join("\n");
}

export async function loadContextContract(file: string): Promise<ContextContract> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new SemanticError(`Could not read context contract at ${file}: ${(err as Error).message}`);
  }
  return parseContextContract(value);
}

export function parseContextContract(value: unknown): ContextContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SemanticError("Context contract must be an object.");
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw new SemanticError("Context contract version must be 1.");
  const requiredString = (key: string): string => {
    if (typeof v[key] !== "string" || !(v[key] as string).trim()) throw new SemanticError(`Context contract ${key} is required.`);
    return (v[key] as string).trim();
  };
  const array = <T>(key: string, parser: (value: unknown, index: number) => T): T[] => {
    if (!Array.isArray(v[key])) throw new SemanticError(`Context contract ${key} must be an array.`);
    return (v[key] as unknown[]).map(parser);
  };
  return {
    version: 1,
    project: requiredString("project"),
    ...(v.description === undefined ? {} : { description: requiredString("description") }),
    entities: array("entities", parseEntity),
    dimensions: array("dimensions", parseDimension),
    measures: array("measures", parseMeasure),
    joins: array("joins", parseJoin),
    ...(v.policies === undefined ? {} : { policies: parsePolicies(v.policies) }),
  };
}

function parseEntity(value: unknown, index: number): ContextEntity {
  const v = object(value, `entities[${index}]`);
  return { id: stringField(v, "id", `entities[${index}]`), table: stringField(v, "table", `entities[${index}]`), grain: stringField(v, "grain", `entities[${index}]`), ...optionalText(v) };
}

function parseDimension(value: unknown, index: number): ContextDimension {
  const v = object(value, `dimensions[${index}]`);
  return { id: stringField(v, "id", `dimensions[${index}]`), entity: stringField(v, "entity", `dimensions[${index}]`), expression: stringField(v, "expression", `dimensions[${index}]`), ...optionalText(v) };
}

function parseMeasure(value: unknown, index: number): ContextMeasure {
  const v = object(value, `measures[${index}]`);
  return { id: stringField(v, "id", `measures[${index}]`), entity: stringField(v, "entity", `measures[${index}]`), expression: stringField(v, "expression", `measures[${index}]`), ...optionalText(v), ...(v.defaultFilter === undefined ? {} : { defaultFilter: stringField(v, "defaultFilter", `measures[${index}]`) }) };
}

function parseJoin(value: unknown, index: number): ContextJoin {
  const v = object(value, `joins[${index}]`);
  const relationship = stringField(v, "relationship", `joins[${index}]`) as RelationshipCardinality;
  if (!["one_to_one", "many_to_one", "one_to_many", "many_to_many", "unknown"].includes(relationship)) throw new SemanticError(`joins[${index}].relationship is invalid.`);
  if (typeof v.approved !== "boolean") throw new SemanticError(`joins[${index}].approved must be boolean.`);
  return { id: stringField(v, "id", `joins[${index}]`), from: stringField(v, "from", `joins[${index}]`), to: stringField(v, "to", `joins[${index}]`), fromColumn: stringField(v, "fromColumn", `joins[${index}]`), toColumn: stringField(v, "toColumn", `joins[${index}]`), relationship, approved: v.approved, ...(v.fanoutRisk === undefined ? {} : { fanoutRisk: stringField(v, "fanoutRisk", `joins[${index}]`) as ContextJoin["fanoutRisk"] }), ...(v.description === undefined ? {} : { description: stringField(v, "description", `joins[${index}]`) }) };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SemanticError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  if (typeof value[key] !== "string" || !(value[key] as string).trim()) throw new SemanticError(`${label}.${key} is required.`);
  return (value[key] as string).trim();
}

function optionalText(value: Record<string, unknown>): Pick<ContextEntity, "name" | "synonyms" | "description"> {
  const result: Pick<ContextEntity, "name" | "synonyms" | "description"> = {};
  if (value.name !== undefined) result.name = String(value.name);
  if (value.description !== undefined) result.description = String(value.description);
  if (value.synonyms !== undefined) {
    if (!Array.isArray(value.synonyms) || value.synonyms.some((item) => typeof item !== "string")) throw new SemanticError("Context synonyms must be strings.");
    result.synonyms = value.synonyms as string[];
  }
  return result;
}

function parsePolicies(value: unknown): ContextContract["policies"] {
  const v = object(value, "policies");
  const allowedSchemas = v.allowedSchemas === undefined
    ? undefined
    : (() => {
        if (!Array.isArray(v.allowedSchemas) || v.allowedSchemas.some((item) => typeof item !== "string")) {
          throw new SemanticError("Context contract policies.allowedSchemas must be a string array.");
        }
        return v.allowedSchemas as string[];
      })();
  return {
    ...(v.maxRows === undefined ? {} : { maxRows: Number(v.maxRows) }),
    ...(allowedSchemas === undefined ? {} : { allowedSchemas }),
  };
}

function schemaOfTable(table: string): string | undefined {
  const dot = table.indexOf(".");
  return dot > 0 ? table.slice(0, dot) : undefined;
}

function assertAllowedSchema(table: string, allowedSchemas: string[] | undefined): void {
  if (!allowedSchemas?.length) return;
  const schema = schemaOfTable(table)?.toLowerCase();
  const allowed = new Set(allowedSchemas.map((item) => item.toLowerCase()));
  if (!schema || !allowed.has(schema)) {
    throw new SemanticError(`Table "${table}" is outside allowed schemas (${allowedSchemas.join(", ")}).`);
  }
}

export interface ContractValidationReport { ok: boolean; problems: string[]; warnings: string[]; }

export function validateContextContract(contract: ContextContract, model?: NormalizedModel): ContractValidationReport {
  const problems: string[] = [];
  const warnings: string[] = [];
  const unique = (values: string[], label: string) => {
    const seen = new Set<string>();
    for (const value of values) if (seen.has(value)) problems.push(`duplicate ${label} "${value}"`); else seen.add(value);
  };
  unique(contract.entities.map((item) => item.id), "entity id");
  unique(contract.measures.map((item) => item.id), "measure id");
  unique(contract.dimensions.map((item) => item.id), "dimension id");
  const entities = new Map(contract.entities.map((item) => [item.id, item]));
  for (const measure of contract.measures) if (!entities.has(measure.entity)) problems.push(`measure "${measure.id}" references missing entity "${measure.entity}"`);
  for (const dimension of contract.dimensions) if (!entities.has(dimension.entity)) problems.push(`dimension "${dimension.id}" references missing entity "${dimension.entity}"`);
  for (const join of contract.joins) {
    if (!entities.has(join.from) || !entities.has(join.to)) problems.push(`join "${join.id}" references missing entity`);
    if (!join.approved) warnings.push(`join "${join.id}" is not approved and cannot be used for automatic compilation`);
    if (join.relationship === "many_to_many" || join.fanoutRisk === "high") warnings.push(`join "${join.id}" may fan out measures`);
  }
  if (model) {
    const tables = new Set(model.entities.filter((item) => item.kind === "table").map((item) => item.qualifiedName.toLowerCase()));
    for (const entity of contract.entities) if (!tables.has(entity.table.toLowerCase())) problems.push(`entity "${entity.id}" references missing table "${entity.table}"`);
  }
  const allowedSchemas = contract.policies?.allowedSchemas;
  if (allowedSchemas?.length) {
    const allowed = new Set(allowedSchemas.map((item) => item.toLowerCase()));
    for (const entity of contract.entities) {
      const schema = schemaOfTable(entity.table)?.toLowerCase();
      if (!schema || !allowed.has(schema)) problems.push(`entity "${entity.id}" table "${entity.table}" is outside allowed schemas (${allowedSchemas.join(", ")})`);
    }
  }
  return { ok: problems.length === 0, problems, warnings };
}

export function relationshipsToContractJoins(relationships: Relationship[]): ContextJoin[] {
  return relationships.map((relationship) => ({ id: relationship.id, from: relationship.fromTable, to: relationship.toTable, fromColumn: relationship.fromColumn, toColumn: relationship.toColumn, relationship: "unknown", approved: false, fanoutRisk: "high" }));
}
