/**
 * SQLite snapshot store (§9).
 *
 * `search.sqlite` holds normalized entities/relationships/assets plus FTS5 full-
 * text indexes for sub-second ranked retrieval (§12: <2s search). It stores
 * metadata and query DEFINITIONS only — never production row values (§9,§10).
 *
 * Two roles:
 *   - SnapshotWriter: creates the DB during `snapshot build`.
 *   - SnapshotReader: opens it read-only for search / MCP serving.
 */

import Database from "better-sqlite3";
import type { Asset, Entity, NormalizedModel, Relationship } from "../model.js";

const SCHEMA_SQL = `
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  description TEXT,
  database_id INTEGER NOT NULL,
  database_name TEXT NOT NULL,
  schema TEXT,
  table_name TEXT,
  data_type TEXT,
  semantic_type TEXT,
  visibility TEXT,
  denylisted INTEGER NOT NULL DEFAULT 0,
  column_count INTEGER
);
CREATE INDEX idx_entities_kind ON entities(kind);
CREATE INDEX idx_entities_qname ON entities(qualified_name);
CREATE INDEX idx_entities_table ON entities(table_name);

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  from_table TEXT NOT NULL,
  from_column TEXT NOT NULL,
  to_table TEXT NOT NULL,
  to_column TEXT NOT NULL,
  database_id INTEGER NOT NULL
);
CREATE INDEX idx_rel_from ON relationships(from_table);
CREATE INDEX idx_rel_to ON relationships(to_table);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  metabase_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  query_type TEXT,
  native_sql TEXT,
  database_id INTEGER,
  table_refs TEXT NOT NULL DEFAULT '[]',
  collection_name TEXT,
  dashboard_names TEXT,
  url TEXT
);
CREATE INDEX idx_assets_kind ON assets(kind);

CREATE VIRTUAL TABLE entities_fts USING fts5(
  entity_id UNINDEXED, name, qualified_name, description
);
CREATE VIRTUAL TABLE assets_fts USING fts5(
  asset_id UNINDEXED, name, description, native_sql, table_refs
);
`;

/** Turn arbitrary user text into a safe FTS5 MATCH expression (prefix, OR-joined). */
export function toFtsMatch(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  // Quote each token (escapes FTS operators) and allow prefix matches.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
}

function entityRow(e: Entity) {
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    qualified_name: e.qualifiedName,
    description: e.description ?? null,
    database_id: e.databaseId,
    database_name: e.databaseName,
    schema: e.schema ?? null,
    table_name: e.table ?? null,
    data_type: e.dataType ?? null,
    semantic_type: e.semanticType ?? null,
    visibility: e.visibility ?? null,
    denylisted: e.denylisted ? 1 : 0,
    column_count: e.columnCount ?? null,
  };
}

export class SnapshotWriter {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  write(model: NormalizedModel): void {
    const insertEntity = this.db.prepare(`
      INSERT INTO entities (id, kind, name, qualified_name, description, database_id,
        database_name, schema, table_name, data_type, semantic_type, visibility,
        denylisted, column_count)
      VALUES (@id, @kind, @name, @qualified_name, @description, @database_id,
        @database_name, @schema, @table_name, @data_type, @semantic_type, @visibility,
        @denylisted, @column_count)
    `);
    const insertEntityFts = this.db.prepare(`
      INSERT INTO entities_fts (entity_id, name, qualified_name, description)
      VALUES (?, ?, ?, ?)
    `);
    const insertRel = this.db.prepare(`
      INSERT INTO relationships (id, kind, from_table, from_column, to_table, to_column, database_id)
      VALUES (@id, @kind, @from_table, @from_column, @to_table, @to_column, @database_id)
    `);
    const insertAsset = this.db.prepare(`
      INSERT INTO assets (id, kind, metabase_id, name, description, query_type,
        native_sql, database_id, table_refs, collection_name, dashboard_names, url)
      VALUES (@id, @kind, @metabase_id, @name, @description, @query_type,
        @native_sql, @database_id, @table_refs, @collection_name, @dashboard_names, @url)
    `);
    const insertAssetFts = this.db.prepare(`
      INSERT INTO assets_fts (asset_id, name, description, native_sql, table_refs)
      VALUES (?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((m: NormalizedModel) => {
      for (const e of m.entities) {
        insertEntity.run(entityRow(e));
        // Denylisted entities are searchable by name but carry no description text.
        insertEntityFts.run(e.id, e.name, e.qualifiedName, e.denylisted ? "" : e.description ?? "");
      }
      for (const r of m.relationships) {
        insertRel.run({
          id: r.id,
          kind: r.kind,
          from_table: r.fromTable,
          from_column: r.fromColumn,
          to_table: r.toTable,
          to_column: r.toColumn,
          database_id: r.databaseId,
        });
      }
      for (const a of m.assets) {
        insertAsset.run({
          id: a.id,
          kind: a.kind,
          metabase_id: a.metabaseId,
          name: a.name,
          description: a.description ?? null,
          query_type: a.queryType ?? null,
          native_sql: a.nativeSql ?? null,
          database_id: a.databaseId ?? null,
          table_refs: JSON.stringify(a.tableRefs ?? []),
          collection_name: a.collectionName ?? null,
          dashboard_names: a.dashboardNames ? JSON.stringify(a.dashboardNames) : null,
          url: a.url ?? null,
        });
        insertAssetFts.run(
          a.id,
          a.name,
          a.description ?? "",
          a.nativeSql ?? "",
          (a.tableRefs ?? []).join(" "),
        );
      }
    });
    tx(model);
  }

  close(): void {
    // Fold the WAL back into the main file so a published snapshot is a single,
    // self-contained, immutable search.sqlite with no sidecar dependencies.
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}

export interface EntitySearchHit extends Entity {
  score: number;
}
export interface AssetSearchHit extends Asset {
  score: number;
}

export class SnapshotReader {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path, { readonly: true, fileMustExist: true });
  }

  private rowToEntity(r: Record<string, unknown>): Entity {
    return {
      id: r.id as string,
      kind: r.kind as Entity["kind"],
      name: r.name as string,
      qualifiedName: r.qualified_name as string,
      description: (r.description as string) ?? undefined,
      databaseId: r.database_id as number,
      databaseName: r.database_name as string,
      schema: (r.schema as string) ?? undefined,
      table: (r.table_name as string) ?? undefined,
      dataType: (r.data_type as string) ?? undefined,
      semanticType: (r.semantic_type as string) ?? undefined,
      visibility: (r.visibility as string) ?? undefined,
      denylisted: r.denylisted ? true : undefined,
      columnCount: (r.column_count as number) ?? undefined,
    };
  }

  private rowToAsset(r: Record<string, unknown>): Asset {
    return {
      id: r.id as string,
      kind: r.kind as Asset["kind"],
      metabaseId: r.metabase_id as number,
      name: r.name as string,
      description: (r.description as string) ?? undefined,
      queryType: (r.query_type as Asset["queryType"]) ?? undefined,
      nativeSql: (r.native_sql as string) ?? undefined,
      databaseId: (r.database_id as number) ?? undefined,
      tableRefs: JSON.parse((r.table_refs as string) ?? "[]"),
      collectionName: (r.collection_name as string) ?? undefined,
      dashboardNames: r.dashboard_names ? JSON.parse(r.dashboard_names as string) : undefined,
      url: (r.url as string) ?? undefined,
    };
  }

  /** Full-text search entities, optionally filtered by kind. */
  searchEntities(query: string, opts: { kinds?: Entity["kind"][]; limit?: number } = {}): EntitySearchHit[] {
    const match = toFtsMatch(query);
    if (!match) return [];
    const limit = opts.limit ?? 20;
    const kindFilter = opts.kinds?.length
      ? `AND e.kind IN (${opts.kinds.map(() => "?").join(",")})`
      : "";
    const stmt = this.db.prepare(`
      SELECT e.*, bm25(entities_fts) AS score
      FROM entities_fts
      JOIN entities e ON e.id = entities_fts.entity_id
      WHERE entities_fts MATCH ? ${kindFilter}
      ORDER BY
        CASE WHEN lower(e.name) = ? OR lower(e.qualified_name) = ? THEN 0 ELSE 1 END,
        score
      LIMIT ?
    `);
    const exact = query.trim().toLowerCase();
    const rows = stmt.all(match, ...(opts.kinds ?? []), exact, exact, limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...this.rowToEntity(r), score: r.score as number }));
  }

  /** Full-text search Metabase assets, optionally filtered by kind. */
  searchAssets(query: string, opts: { kinds?: Asset["kind"][]; limit?: number } = {}): AssetSearchHit[] {
    const match = toFtsMatch(query);
    if (!match) return [];
    const limit = opts.limit ?? 20;
    const kindFilter = opts.kinds?.length
      ? `AND a.kind IN (${opts.kinds.map(() => "?").join(",")})`
      : "";
    const stmt = this.db.prepare(`
      SELECT a.*, bm25(assets_fts) AS score
      FROM assets_fts
      JOIN assets a ON a.id = assets_fts.asset_id
      WHERE assets_fts MATCH ? ${kindFilter}
      ORDER BY CASE WHEN lower(a.name) = ? THEN 0 ELSE 1 END, score
      LIMIT ?
    `);
    const exact = query.trim().toLowerCase();
    const rows = stmt.all(match, ...(opts.kinds ?? []), exact, limit) as Record<string, unknown>[];
    return rows.map((r) => ({ ...this.rowToAsset(r), score: r.score as number }));
  }

  /** Exact entity lookup by qualified name (case-insensitive) or id. */
  getEntity(nameOrId: string): Entity | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM entities
      WHERE id = ? OR lower(qualified_name) = lower(?) OR lower(name) = lower(?)
      ORDER BY CASE kind WHEN 'table' THEN 0 WHEN 'column' THEN 1 ELSE 2 END
      LIMIT 1
    `);
    const row = stmt.get(nameOrId, nameOrId, nameOrId) as Record<string, unknown> | undefined;
    return row ? this.rowToEntity(row) : undefined;
  }

  /** All columns belonging to a table (by qualified table name). */
  getColumnsOfTable(tableQualifiedName: string): Entity[] {
    const rows = this.db
      .prepare(`SELECT * FROM entities WHERE kind = 'column' AND lower(table_name) = lower(?) ORDER BY name`)
      .all(tableQualifiedName) as Record<string, unknown>[];
    return rows.map((r) => this.rowToEntity(r));
  }

  /** All FK relationships touching a table (either direction). */
  getRelationships(tableQualifiedName: string): Relationship[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM relationships WHERE lower(from_table) = lower(?) OR lower(to_table) = lower(?)`,
      )
      .all(tableQualifiedName, tableQualifiedName) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as Relationship["kind"],
      fromTable: r.from_table as string,
      fromColumn: r.from_column as string,
      toTable: r.to_table as string,
      toColumn: r.to_column as string,
      databaseId: r.database_id as number,
    }));
  }

  /**
   * All FK edges as a flat list, for building a join graph in memory. Only the
   * six edge columns are selected (no entity rows), so even large schemas stay
   * cheap — a few hundred edges, not thousands of column records.
   */
  getAllRelationships(): Relationship[] {
    const rows = this.db
      .prepare(`SELECT * FROM relationships`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as Relationship["kind"],
      fromTable: r.from_table as string,
      fromColumn: r.from_column as string,
      toTable: r.to_table as string,
      toColumn: r.to_column as string,
      databaseId: r.database_id as number,
    }));
  }

  /** Assets that reference a given qualified table name. */
  getAssetsReferencingTable(tableQualifiedName: string): Asset[] {
    const rows = this.db
      .prepare(`SELECT * FROM assets WHERE table_refs LIKE ?`)
      .all(`%${tableQualifiedName.toLowerCase()}%`) as Record<string, unknown>[];
    return rows.map((r) => this.rowToAsset(r));
  }

  counts(): { entities: number; relationships: number; assets: number } {
    const one = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      entities: one("SELECT COUNT(*) c FROM entities"),
      relationships: one("SELECT COUNT(*) c FROM relationships"),
      assets: one("SELECT COUNT(*) c FROM assets"),
    };
  }

  /** Verify the DB opens and has the expected tables (used by `validate`). */
  healthCheck(): boolean {
    const tables = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    return ["entities", "relationships", "assets"].every((t) => names.has(t));
  }

  close(): void {
    this.db.close();
  }
}
