import { writeFile } from "node:fs/promises";
import { SemanticError } from "./errors.js";
import type { Entity, NormalizedModel, Relationship } from "./model.js";
import type { ContextContract, ContextDimension, ContextEntity, ContextJoin, ContextMeasure } from "./contract.js";

export interface DraftContractOptions {
  project: string;
  description?: string;
  schemas?: string[];
  maxEntities?: number;
  includeUnapprovedJoins?: boolean;
}

export interface DraftContractResult {
  contract: ContextContract;
  warnings: string[];
}

const DIMENSION_NAME_RE = /(^id$|_id$|name|title|status|state|type|category|email|phone|city|country|created_at|updated_at|date|time)/i;
const NUMERIC_TYPE_RE = /(int|numeric|decimal|double|float|real|money)/i;

export function draftContractFromModel(model: NormalizedModel, opts: DraftContractOptions): DraftContractResult {
  if (!opts.project.trim()) throw new SemanticError("Draft contract project is required.");
  const allowedSchemas = new Set((opts.schemas ?? []).map((item) => item.toLowerCase()));
  const tables = model.entities
    .filter((item) => item.kind === "table")
    .filter((item) => allowedSchemas.size === 0 || (item.schema ? allowedSchemas.has(item.schema.toLowerCase()) : false))
    .sort((a, b) => (b.columnCount ?? 0) - (a.columnCount ?? 0) || a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, opts.maxEntities ?? 50);
  const tableSet = new Set(tables.map((item) => item.qualifiedName.toLowerCase()));
  const entities: ContextEntity[] = tables.map((table) => ({
    id: entityId(table),
    table: table.qualifiedName,
    grain: `${singularize(table.name)} row`,
    name: humanize(table.name),
    ...(table.description ? { description: table.description } : {}),
  }));
  const entityByTable = new Map(entities.map((entity) => [entity.table.toLowerCase(), entity]));
  const columnsByTable = groupColumns(model.entities, tableSet);
  const dimensions: ContextDimension[] = [];
  const measures: ContextMeasure[] = [];
  const warnings: string[] = [];

  for (const table of tables) {
    const entity = entityByTable.get(table.qualifiedName.toLowerCase());
    if (!entity) continue;
    measures.push({
      id: `${entity.id}.count`,
      entity: entity.id,
      expression: "COUNT(*)",
      name: `${humanize(table.name)} count`,
      description: "Auto-drafted row count. Review grain and filters before production use.",
    });
    for (const column of (columnsByTable.get(table.qualifiedName.toLowerCase()) ?? []).slice(0, 16)) {
      if (!isUsefulDimension(column)) continue;
      dimensions.push({
        id: `${entity.id}.${safeId(column.name)}`,
        entity: entity.id,
        expression: column.name,
        name: humanize(column.name),
        ...(column.description ? { description: column.description } : {}),
      });
    }
  }

  const joins = model.relationships
    .filter((relationship) => tableSet.has(relationship.fromTable.toLowerCase()) && tableSet.has(relationship.toTable.toLowerCase()))
    .map((relationship) => relationshipToDraftJoin(relationship, entityByTable, opts.includeUnapprovedJoins === true))
    .filter((join): join is ContextJoin => join !== undefined);

  if (tables.length === (opts.maxEntities ?? 50)) {
    warnings.push(`draft limited to ${tables.length} entities; increase --max-entities to include more tables`);
  }
  if (!opts.includeUnapprovedJoins && joins.length > 0) {
    warnings.push("joins are drafted as unapproved; review fanout before enabling automatic cross-entity compilation");
  }

  return {
    contract: {
      version: 1,
      project: opts.project,
      ...(opts.description ? { description: opts.description } : {}),
      entities,
      dimensions,
      measures,
      joins,
      policies: { maxRows: 1000, ...(opts.schemas?.length ? { allowedSchemas: opts.schemas } : {}) },
    },
    warnings,
  };
}

export async function writeDraftContract(file: string, result: DraftContractResult): Promise<void> {
  await writeFile(file, JSON.stringify(result.contract, null, 2) + "\n", "utf8");
}

function groupColumns(entities: Entity[], tableSet: Set<string>): Map<string, Entity[]> {
  const grouped = new Map<string, Entity[]>();
  for (const entity of entities) {
    if (entity.kind !== "column" || !entity.table) continue;
    const key = entity.table.toLowerCase();
    if (!tableSet.has(key)) continue;
    (grouped.get(key) ?? grouped.set(key, []).get(key)!).push(entity);
  }
  for (const columns of grouped.values()) {
    columns.sort((a, b) => scoreDimension(b) - scoreDimension(a) || a.name.localeCompare(b.name));
  }
  return grouped;
}

function isUsefulDimension(column: Entity): boolean {
  if (column.denylisted) return false;
  if (column.visibility === "sensitive" || column.visibility === "hidden") return false;
  return DIMENSION_NAME_RE.test(column.name) || Boolean(column.semanticType);
}

function scoreDimension(column: Entity): number {
  let score = 0;
  if (/^(name|title|status|state|type|category)$/i.test(column.name)) score += 4;
  if (/(created_at|updated_at|date|time)$/i.test(column.name)) score += 3;
  if (column.semanticType) score += 2;
  if (NUMERIC_TYPE_RE.test(column.dataType ?? "")) score -= 1;
  return score;
}

function relationshipToDraftJoin(
  relationship: Relationship,
  entityByTable: Map<string, ContextEntity>,
  approve: boolean,
): ContextJoin | undefined {
  const from = entityByTable.get(relationship.fromTable.toLowerCase());
  const to = entityByTable.get(relationship.toTable.toLowerCase());
  if (!from || !to) return undefined;
  return {
    id: `${from.id}__${safeId(relationship.fromColumn)}__${to.id}`,
    from: from.id,
    to: to.id,
    fromColumn: relationship.fromColumn,
    toColumn: relationship.toColumn,
    relationship: "many_to_one",
    approved: approve,
    fanoutRisk: approve ? "low" : "high",
    description: "Auto-drafted from a physical FK. Review cardinality before approving.",
  };
}

function entityId(entity: Entity): string {
  return safeId(entity.schema ? `${entity.schema}_${entity.name}` : entity.name);
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "item";
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function singularize(value: string): string {
  return value.endsWith("ies") ? `${value.slice(0, -3)}y` : value.endsWith("s") ? value.slice(0, -1) : value;
}
