/**
 * Raw Metabase API response shapes.
 *
 * These are intentionally partial — we type only the fields we consume. They live
 * behind the adapter (src/metabase/client.ts) and must not leak into the rest of
 * the app (§7.1). Upstream code consumes the normalized model (src/model.ts).
 */

export interface MbField {
  id: number;
  name: string;
  display_name?: string;
  description?: string | null;
  database_type?: string;
  base_type?: string;
  semantic_type?: string | null;
  visibility_type?: string;
  /** Present when this field is a foreign key: the target field id. */
  fk_target_field_id?: number | null;
  table_id?: number;
}

export interface MbTable {
  id: number;
  name: string;
  display_name?: string;
  description?: string | null;
  schema?: string;
  db_id?: number;
  fields?: MbField[];
}

export interface MbDatabase {
  id: number;
  name: string;
  engine?: string;
  tables?: MbTable[];
}

/** Shape of GET /api/database/:id/metadata */
export interface MbDatabaseMetadata extends MbDatabase {
  tables: MbTable[];
}

export interface MbCard {
  id: number;
  name: string;
  description?: string | null;
  /** "model" for models; "question" otherwise (newer Metabase). */
  type?: string;
  /** Legacy flag marking a model. */
  dataset?: boolean;
  database_id?: number | null;
  collection?: { id: number; name: string } | null;
  dataset_query?: {
    type?: "native" | "query";
    database?: number;
    native?: { query?: string };
    query?: { "source-table"?: number | string };
  };
  table_id?: number | null;
}

export interface MbDashboardCardRef {
  id: number;
  card_id?: number | null;
  card?: { id: number; name: string } | null;
}

export interface MbDashboard {
  id: number;
  name: string;
  description?: string | null;
  collection?: { id: number; name: string } | null;
  /** Newer Metabase uses `dashcards`; older uses `ordered_cards`. */
  dashcards?: MbDashboardCardRef[];
  ordered_cards?: MbDashboardCardRef[];
}

/** Shape of POST /api/dataset result. */
export interface MbDatasetResult {
  data?: {
    rows?: unknown[][];
    cols?: { name: string; display_name?: string; base_type?: string }[];
  };
  row_count?: number;
  status?: string;
  error?: string;
}
