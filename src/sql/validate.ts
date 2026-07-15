/**
 * Read-only SQL validation (§10, FR-6).
 *
 * Defense in depth — a query must pass ALL layers before it can execute:
 *   1. Non-empty, single statement (no stacked `;` statements).
 *   2. Leading verb must be SELECT or WITH.
 *   3. A real SQL parse (node-sql-parser) asserting every parsed statement is a
 *      SELECT / WITH-select, with no SELECT ... INTO target.
 *
 * If the parser cannot understand the SQL at all, we FAIL CLOSED — an unparseable
 * statement is treated as unsafe rather than passed through.
 */

import pkg from "node-sql-parser";
import { UnsafeSqlError } from "../errors.js";

// node-sql-parser is CommonJS; under NodeNext ESM we must take the default export
// and destructure, rather than rely on a (runtime-nonexistent) named export.
const { Parser } = pkg;
const parser = new Parser();

export interface SqlValidationResult {
  ok: boolean;
  /** Reason it was rejected (only present when ok === false). */
  reason?: string;
  /** Statement type(s) detected, e.g. ["select"]. */
  statements?: string[];
}

export interface SqlReferences {
  tables: string[];
  columns: Array<{ table?: string; column: string }>;
}

/** Strip comments and normalize whitespace for keyword scanning. */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
}

/**
 * Validate SQL is read-only. Returns a structured result rather than throwing,
 * so the MCP `context_validate_sql` tool can report cleanly. Callers that want
 * an exception can use {@link assertReadOnlySql}.
 */
export function validateReadOnlySql(sql: string): SqlValidationResult {
  const trimmed = (sql ?? "").trim();
  if (!trimmed) return { ok: false, reason: "Empty SQL." };

  const cleaned = stripComments(trimmed);
  if (!cleaned) return { ok: false, reason: "SQL contains only comments." };

  // Layer 1: reject stacked statements. A single trailing semicolon is fine.
  const withoutTrailing = cleaned.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return { ok: false, reason: "Multiple statements are not allowed." };
  }

  // Layer 2: leading verb must be SELECT or WITH (fast reject for obvious mutations).
  const firstWord = withoutTrailing.match(/^[a-z]+/i)?.[0]?.toLowerCase() ?? "";
  if (firstWord !== "select" && firstWord !== "with") {
    return {
      ok: false,
      reason: `Statement must start with SELECT or WITH (got "${firstWord || "?"}").`,
    };
  }

  // Layer 3: real parse. Fail closed if unparseable.
  let ast;
  try {
    ast = parser.astify(withoutTrailing, { database: "postgresql" });
  } catch (err) {
    return { ok: false, reason: `Could not parse SQL (rejected): ${(err as Error).message}` };
  }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return { ok: false, reason: "Exactly one statement is required." };
  }
  const types = statements.map((s) => String((s as { type?: string }).type ?? "unknown"));
  if (!types.every((t) => t === "select")) {
    return { ok: false, reason: `Only SELECT statements allowed (got ${types.join(", ")}).`, statements: types };
  }

  // AST-level defense in depth: reject SELECT ... INTO even if the keyword scan
  // were somehow bypassed (e.g. dialect quirk). node-sql-parser exposes the INTO
  // target on the statement node.
  for (const s of statements) {
    const into = (s as { into?: { type?: unknown; expr?: unknown; position?: unknown } }).into;
    // node-sql-parser includes `{ position: null }` on ordinary SELECTs. A real
    // SELECT INTO has a populated type/expr/position describing the target.
    if (into && (into.type === "into" || into.expr != null || into.position != null)) {
      return { ok: false, reason: "SELECT ... INTO is not allowed (creates a table)." };
    }
  }

  return { ok: true, statements: types };
}

/** Throw {@link UnsafeSqlError} if the SQL is not a safe read-only statement. */
export function assertReadOnlySql(sql: string): void {
  const result = validateReadOnlySql(sql);
  if (!result.ok) {
    throw new UnsafeSqlError(result.reason ?? "SQL rejected as unsafe.");
  }
}

/** Extract physical table and column references after read-only parsing. */
export function extractSqlReferences(sql: string): SqlReferences {
  const trimmed = stripComments((sql ?? "").trim()).replace(/;\s*$/, "");
  let ast: any;
  try {
    ast = parser.astify(trimmed, { database: "postgresql" });
  } catch {
    return { tables: [], columns: [] };
  }
  const tables = new Set<string>();
  const aliases = new Map<string, string>();
  const ctes = new Set<string>();
  const columns: Array<{ table?: string; column: string }> = [];
  const seen = new Set<object>();
  const clean = (value: unknown): string => String(value ?? "").replace(/[\[\]`\"]+/g, "").trim();
  const walk = (node: any): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node.with && Array.isArray(node.with)) {
      for (const item of node.with) {
        const name = clean(item?.name?.value ?? item?.name);
        if (name) ctes.add(name.toLowerCase());
        walk(item?.stmt);
      }
    }
    if (Array.isArray(node.from)) {
      for (const item of node.from) {
        const table = clean(item?.table);
        if (table && !ctes.has(table.toLowerCase())) {
          const qualified = item.db ? `${clean(item.db)}.${table}` : table;
          tables.add(qualified.toLowerCase());
          const alias = clean(item.as);
          aliases.set((alias || table).toLowerCase(), qualified);
        }
        walk(item?.join);
        walk(item?.on);
      }
    }
    if (node.type === "column_ref") {
      const column = clean(node.column?.expr?.value ?? node.column);
      if (column && column !== "*") {
        const table = clean(node.table);
        columns.push({ table: table ? (aliases.get(table.toLowerCase()) ?? table) : undefined, column });
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "from" || key === "with" || key === "column") continue;
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  const statements = Array.isArray(ast) ? ast : [ast];
  statements.forEach(walk);
  return { tables: [...tables], columns };
}

/**
 * Enforce the configured row limit. If the query has no LIMIT, append one. If it
 * has a LIMIT larger than `rowLimit`, clamp it down. This prevents a caller from
 * requesting `LIMIT 1000000` to pull far more than the guardrail allows.
 */
export function enforceLimit(sql: string, rowLimit: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  const re = /\blimit\s+(\d+)/i;
  const m = trimmed.match(re);
  if (!m) return `${trimmed}\nLIMIT ${rowLimit}`;
  const existing = Number(m[1]);
  if (existing <= rowLimit) return trimmed;
  return trimmed.replace(re, `LIMIT ${rowLimit}`);
}
