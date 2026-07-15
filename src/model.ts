/**
 * Normalized domain model — the vocabulary shared by the indexers, snapshot
 * builder, search, and MCP layers.
 *
 * Crucially, NOTHING here references Metabase's raw HTTP shapes. The Metabase
 * adapter (src/metabase) is the only place that knows about the real API; it
 * emits these normalized types. This is the isolation boundary mandated by
 * §7.1 — swapping the data source later means rewriting only the adapter.
 */

/** Kind discriminator for a database-structure entity (§7.2). */
export type EntityKind = "database" | "schema" | "table" | "column";

/** A normalized database-structure entity. */
export interface Entity {
  /** Stable id, e.g. "table:public.users" or "column:public.users.email". */
  id: string;
  kind: EntityKind;
  /** Bare name, e.g. "users" or "email". */
  name: string;
  /** Fully-qualified name, e.g. "public.users" or "public.users.email". */
  qualifiedName: string;
  /** Human/semantic description if Metabase exposes one. */
  description?: string;
  /** Metabase numeric database id this entity belongs to. */
  databaseId: number;
  databaseName: string;
  /** Schema name (undefined for the database entity itself). */
  schema?: string;
  /** Parent table's qualified name (columns only). */
  table?: string;
  /** Raw DB column type, e.g. "VARCHAR", "int8" (columns only). */
  dataType?: string;
  /** Metabase semantic type, e.g. "type/Email", "type/FK" (columns only). */
  semanticType?: string;
  /** Metabase field visibility, e.g. "normal", "hidden", "sensitive". */
  visibility?: string;
  /** True if masked out by the configured denylist (§10). */
  denylisted?: boolean;
  /** Number of columns (tables only) — cheap signal of table "size". */
  columnCount?: number;
}

/** Kind of relationship between two tables. */
export type RelationshipKind = "fk";

/** A normalized foreign-key relationship (§7.2). */
export interface Relationship {
  id: string;
  kind: RelationshipKind;
  /** Qualified name of the referencing table. */
  fromTable: string;
  fromColumn: string;
  /** Qualified name of the referenced table. */
  toTable: string;
  toColumn: string;
  databaseId: number;
}

/** Kind discriminator for a Metabase analytical asset (§7.3). */
export type AssetKind = "question" | "model" | "dashboard";

/** A normalized Metabase-owned analytical asset. */
export interface Asset {
  /** Stable id, e.g. "question:42". */
  id: string;
  kind: AssetKind;
  /** Metabase numeric id. */
  metabaseId: number;
  name: string;
  description?: string;
  /** "native" (raw SQL) or "query" (structured/MBQL) — undefined for dashboards. */
  queryType?: "native" | "query";
  /** Raw SQL for native questions/models, when accessible. */
  nativeSql?: string;
  /** Metabase database id the asset targets, when known. */
  databaseId?: number;
  /** Qualified table names this asset references, when safely determinable. */
  tableRefs: string[];
  collectionName?: string;
  /** For a card that lives on dashboards: the dashboard names. */
  dashboardNames?: string[];
  url?: string;
}

/** The full normalized dataset produced by the indexers before snapshotting. */
export interface NormalizedModel {
  entities: Entity[];
  relationships: Relationship[];
  assets: Asset[];
}
