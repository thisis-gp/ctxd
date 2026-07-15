import { readFile } from "node:fs/promises";
import { SemanticError } from "../errors.js";
import type { Entity, NormalizedModel } from "../model.js";

export type AdapterKind = "dbt" | "cube" | "metricflow";

export interface AdapterInfo {
  kind: AdapterKind;
  name: string;
  input: string;
  output: "NormalizedModel";
}

export const ADAPTERS: AdapterInfo[] = [
  { kind: "dbt", name: "dbt manifest.json", input: "dbt manifest JSON", output: "NormalizedModel" },
  { kind: "cube", name: "Cube semantic schema", input: "Cube JSON schema export", output: "NormalizedModel" },
  { kind: "metricflow", name: "MetricFlow semantic manifest", input: "MetricFlow JSON manifest", output: "NormalizedModel" },
];

export async function loadModelFromAdapter(kind: AdapterKind, file: string): Promise<NormalizedModel> {
  const value = await readJson(file);
  switch (kind) {
    case "dbt":
      return dbtManifestToModel(value);
    case "cube":
      return cubeSchemaToModel(value);
    case "metricflow":
      return metricFlowManifestToModel(value);
    default:
      throw new SemanticError(`Unsupported adapter kind "${kind}".`);
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new SemanticError(`Could not read adapter input at ${file}: ${(err as Error).message}`);
  }
}

function dbtManifestToModel(value: unknown): NormalizedModel {
  const root = object(value, "dbt manifest");
  const nodes = object(root.nodes ?? {}, "dbt manifest.nodes");
  const sources = object(root.sources ?? {}, "dbt manifest.sources");
  const entities: Entity[] = [];
  for (const node of [...Object.values(nodes), ...Object.values(sources)]) {
    const item = object(node, "dbt node");
    const resourceType = text(item.resource_type ?? item.resourceType ?? "", "dbt node.resource_type", false);
    if (!["model", "seed", "snapshot", "source"].includes(resourceType)) continue;
    const database = text(item.database ?? "default", "dbt node.database", false) || "default";
    const schema = text(item.schema ?? "public", "dbt node.schema", false) || "public";
    const alias = text(item.alias ?? item.name, "dbt node.name", true);
    addTableWithColumns(entities, {
      databaseName: database,
      databaseId: stableNumber(database),
      schema,
      table: alias,
      description: text(item.description ?? "", "dbt node.description", false) || undefined,
      columns: object(item.columns ?? {}, "dbt node.columns"),
    });
  }
  return { entities, relationships: [], assets: [] };
}

function cubeSchemaToModel(value: unknown): NormalizedModel {
  const root = Array.isArray(value) ? { cubes: value } : object(value, "cube schema");
  const cubes = array(root.cubes ?? root, "cube schema.cubes");
  const entities: Entity[] = [];
  for (const cube of cubes) {
    const item = object(cube, "cube");
    const name = text(item.name, "cube.name", true);
    const schema = text(item.schema ?? "semantic", "cube.schema", false) || "semantic";
    const dimensions = array(item.dimensions ?? [], "cube.dimensions");
    const measures = array(item.measures ?? [], "cube.measures");
    addTableWithColumnList(entities, {
      databaseName: "cube",
      databaseId: stableNumber("cube"),
      schema,
      table: name,
      description: text(item.description ?? "", "cube.description", false) || undefined,
      columns: [...dimensions, ...measures].map((column) => {
        const c = object(column, "cube column");
        return {
          name: text(c.name, "cube column.name", true),
          dataType: text(c.type ?? "unknown", "cube column.type", false) || "unknown",
          description: text(c.description ?? "", "cube column.description", false) || undefined,
        };
      }),
    });
  }
  return { entities, relationships: [], assets: [] };
}

function metricFlowManifestToModel(value: unknown): NormalizedModel {
  const root = object(value, "metricflow manifest");
  const semanticModels = array(root.semantic_models ?? root.semanticModels ?? [], "metricflow semantic_models");
  const entities: Entity[] = [];
  for (const semanticModel of semanticModels) {
    const item = object(semanticModel, "metricflow semantic_model");
    const name = text(item.name, "metricflow semantic_model.name", true);
    const nodeRelation = object(item.node_relation ?? item.nodeRelation ?? {}, "metricflow node_relation");
    const schema = text(nodeRelation.schema_name ?? nodeRelation.schemaName ?? "semantic", "metricflow schema", false) || "semantic";
    const table = text(nodeRelation.alias ?? nodeRelation.relation_name ?? nodeRelation.relationName ?? name, "metricflow table", false) || name;
    const dimensions = array(item.dimensions ?? [], "metricflow dimensions");
    const measures = array(item.measures ?? [], "metricflow measures");
    addTableWithColumnList(entities, {
      databaseName: "metricflow",
      databaseId: stableNumber("metricflow"),
      schema,
      table,
      description: text(item.description ?? "", "metricflow description", false) || undefined,
      columns: [...dimensions, ...measures].map((column) => {
        const c = object(column, "metricflow column");
        return {
          name: text(c.name, "metricflow column.name", true),
          dataType: text(c.type ?? c.expr ?? "unknown", "metricflow column.type", false) || "unknown",
          description: text(c.description ?? "", "metricflow column.description", false) || undefined,
        };
      }),
    });
  }
  return { entities, relationships: [], assets: [] };
}

function addTableWithColumns(
  entities: Entity[],
  input: { databaseName: string; databaseId: number; schema: string; table: string; description?: string; columns: Record<string, unknown> },
): void {
  addTableWithColumnList(entities, {
    ...input,
    columns: Object.entries(input.columns).map(([name, value]) => {
      const column = object(value, `column ${name}`);
      return {
        name,
        dataType: text(column.data_type ?? column.dataType ?? "unknown", `column ${name}.data_type`, false) || "unknown",
        description: text(column.description ?? "", `column ${name}.description`, false) || undefined,
      };
    }),
  });
}

function addTableWithColumnList(
  entities: Entity[],
  input: { databaseName: string; databaseId: number; schema: string; table: string; description?: string; columns: Array<{ name: string; dataType: string; description?: string }> },
): void {
  const qualifiedName = `${input.schema}.${input.table}`;
  entities.push({
    id: `table:${qualifiedName}`,
    kind: "table",
    name: input.table,
    qualifiedName,
    databaseId: input.databaseId,
    databaseName: input.databaseName,
    schema: input.schema,
    columnCount: input.columns.length,
    ...(input.description ? { description: input.description } : {}),
  });
  for (const column of input.columns) {
    entities.push({
      id: `column:${qualifiedName}.${column.name}`,
      kind: "column",
      name: column.name,
      qualifiedName: `${qualifiedName}.${column.name}`,
      databaseId: input.databaseId,
      databaseName: input.databaseName,
      schema: input.schema,
      table: qualifiedName,
      dataType: column.dataType,
      ...(column.description ? { description: column.description } : {}),
    });
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SemanticError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new SemanticError(`${label} must be an array.`);
  return value;
}

function text(value: unknown, label: string, required: boolean): string {
  if (typeof value === "string") return value.trim();
  if (!required && value === undefined) return "";
  if (!required && value === null) return "";
  throw new SemanticError(`${label} must be a string.`);
}

function stableNumber(value: string): number {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash || 1);
}
