import { SchemaReferenceError } from "./errors.js";
import type { Entity } from "./model.js";

/**
 * Sensitive-table / sensitive-field denylisting (§10).
 *
 * A denylist entry matches at three granularities, all case-insensitive:
 *   - "schema.table"        -> masks the table and all its columns
 *   - "table"               -> masks any table with that bare name, and its columns
 *   - "schema.table.column" -> masks a single column
 *   - "table.column"        -> masks a column by bare table + column name
 *   - "*.column"            -> masks a column name on every table
 *   - "schema.*.column"     -> masks a column name on every table in a schema
 *
 * Denylisted entities are still *indexed* (so an agent knows they exist) but are
 * flagged `denylisted: true` and never carry descriptions or sample values.
 */

export class Denylist {
  private readonly entries: Set<string>;

  constructor(entries: string[]) {
    this.entries = new Set(entries.map((e) => e.trim().toLowerCase()).filter(Boolean));
  }

  get size(): number {
    return this.entries.size;
  }

  /** Is a table denylisted? `schema` may be undefined. */
  isTableDenied(schema: string | undefined, table: string): boolean {
    const t = table.toLowerCase();
    if (this.entries.has(t)) return true;
    if (schema && this.entries.has(`${schema.toLowerCase()}.${t}`)) return true;
    return false;
  }

  /** Is a column denylisted? Considers table-level denials too. */
  isColumnDenied(schema: string | undefined, table: string, column: string): boolean {
    if (this.isTableDenied(schema, table)) return true;
    const t = table.toLowerCase();
    const c = column.toLowerCase();
    if (this.entries.has(`*.${c}`)) return true;
    if (schema && this.entries.has(`${schema.toLowerCase()}.*.${c}`)) return true;
    if (this.entries.has(`${t}.${c}`)) return true;
    if (schema && this.entries.has(`${schema.toLowerCase()}.${t}.${c}`)) return true;
    return false;
  }
}

/** Reject SQL that references a denylisted entity indexed in the active snapshot. */
export function rejectIfDenylisted(entity: Entity): void {
  if (entity.denylisted) {
    throw new SchemaReferenceError(
      `Denylisted ${entity.kind} "${entity.qualifiedName}" cannot be referenced in SQL.`,
    );
  }
}
