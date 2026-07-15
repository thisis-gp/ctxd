/**
 * Database metadata indexer (§7.2).
 *
 * Converts raw Metabase database metadata into normalized Entity + Relationship
 * records. Answers "what data structures are available through Metabase?".
 *
 * It never connects to PostgreSQL directly and never uses mbquery — its only
 * input is what the Metabase adapter returns.
 */

import { Denylist } from "../denylist.js";
import { logger } from "../logger.js";
import type { Entity, Relationship } from "../model.js";
import type { MetabaseClient } from "../metabase/client.js";
import type { MbField, MbTable } from "../metabase/types.js";

export interface MetadataIndexResult {
  entities: Entity[];
  relationships: Relationship[];
  /** Metabase numeric table id -> qualified name, for the content indexer. */
  tableIdToQualified: Map<number, string>;
}

function qualifyTable(schema: string | undefined, table: string): string {
  return schema ? `${schema}.${table}` : table;
}

export class MetadataIndexer {
  constructor(
    private readonly client: MetabaseClient,
    private readonly denylist: Denylist,
  ) {}

  /**
   * Index the given database ids. If `databaseIds` is empty, indexes every
   * database the API key can see (FR-1).
   */
  async index(databaseIds: number[]): Promise<MetadataIndexResult> {
    const targets = databaseIds.length ? databaseIds : await this.discoverDatabaseIds();
    const entities: Entity[] = [];
    const relationships: Relationship[] = [];
    const tableIdToQualified = new Map<number, string>();

    // fieldId -> qualified "table.column", built across all DBs so we can resolve
    // fk_target_field_id references into human-readable relationships.
    const fieldIndex = new Map<number, { table: string; column: string; databaseId: number }>();
    // Deferred FK edges we resolve after all fields are seen.
    const pendingFks: { fromField: MbField; fromTable: string; databaseId: number }[] = [];

    for (const dbId of targets) {
      const meta = await this.client.getDatabaseMetadata(dbId);
      logger.info("indexed database metadata", {
        databaseId: dbId,
        database: meta.name,
        tables: meta.tables?.length ?? 0,
      });

      entities.push({
        id: `database:${dbId}`,
        kind: "database",
        name: meta.name,
        qualifiedName: meta.name,
        databaseId: dbId,
        databaseName: meta.name,
      });

      const seenSchemas = new Set<string>();
      for (const table of meta.tables ?? []) {
        const schema = table.schema ?? undefined;
        if (schema && !seenSchemas.has(schema)) {
          seenSchemas.add(schema);
          entities.push({
            id: `schema:${dbId}.${schema}`,
            kind: "schema",
            name: schema,
            qualifiedName: schema,
            databaseId: dbId,
            databaseName: meta.name,
            schema,
          });
        }
        this.indexTable(table, dbId, meta.name, entities, fieldIndex, pendingFks);
        if (typeof table.id === "number") {
          tableIdToQualified.set(table.id, qualifyTable(table.schema ?? undefined, table.name));
        }
      }
    }

    // Second pass: resolve FK relationships now that every field id is known.
    for (const { fromField, fromTable, databaseId } of pendingFks) {
      const target = fromField.fk_target_field_id
        ? fieldIndex.get(fromField.fk_target_field_id)
        : undefined;
      if (!target) continue;
      relationships.push({
        id: `fk:${fromTable}.${fromField.name}->${target.table}.${target.column}`,
        kind: "fk",
        fromTable,
        fromColumn: fromField.name,
        toTable: target.table,
        toColumn: target.column,
        databaseId,
      });
    }

    logger.info("metadata indexing complete", {
      entities: entities.length,
      relationships: relationships.length,
    });
    return { entities, relationships, tableIdToQualified };
  }

  private async discoverDatabaseIds(): Promise<number[]> {
    const dbs = await this.client.listDatabases();
    return dbs.map((d) => d.id);
  }

  private indexTable(
    table: MbTable,
    dbId: number,
    dbName: string,
    entities: Entity[],
    fieldIndex: Map<number, { table: string; column: string; databaseId: number }>,
    pendingFks: { fromField: MbField; fromTable: string; databaseId: number }[],
  ): void {
    const schema = table.schema ?? undefined;
    const qName = qualifyTable(schema, table.name);
    const tableDenied = this.denylist.isTableDenied(schema, table.name);
    const fields = table.fields ?? [];

    entities.push({
      id: `table:${qName}`,
      kind: "table",
      name: table.name,
      qualifiedName: qName,
      description: tableDenied ? undefined : table.description ?? undefined,
      databaseId: dbId,
      databaseName: dbName,
      schema,
      denylisted: tableDenied || undefined,
      columnCount: fields.length,
    });

    for (const field of fields) {
      const colDenied = this.denylist.isColumnDenied(schema, table.name, field.name);
      const colQName = `${qName}.${field.name}`;
      if (typeof field.id === "number") {
        fieldIndex.set(field.id, { table: qName, column: field.name, databaseId: dbId });
      }
      entities.push({
        id: `column:${colQName}`,
        kind: "column",
        name: field.name,
        qualifiedName: colQName,
        description: colDenied ? undefined : field.description ?? undefined,
        databaseId: dbId,
        databaseName: dbName,
        schema,
        table: qName,
        dataType: field.database_type ?? field.base_type,
        semanticType: field.semantic_type ?? undefined,
        visibility: field.visibility_type,
        denylisted: colDenied || undefined,
      });

      if (field.fk_target_field_id) {
        pendingFks.push({ fromField: field, fromTable: qName, databaseId: dbId });
      }
    }
  }
}
