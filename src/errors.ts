/**
 * Custom error classes.
 *
 * We use typed errors (never bare `throw new Error`) so callers — especially the
 * CLI and MCP layers — can distinguish a config problem from an auth failure from
 * a rejected-unsafe-SQL problem, and map each to the right exit code / MCP error.
 */

export class AgentContextError extends Error {
  /** Stable machine-readable code for programmatic handling. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Missing or invalid configuration (e.g. no METABASE_URL). */
export class ConfigError extends AgentContextError {
  constructor(message: string) {
    super("CONFIG", message);
  }
}

/** Metabase authentication / authorization failure. */
export class MetabaseAuthError extends AgentContextError {
  constructor(message: string) {
    super("METABASE_AUTH", message);
  }
}

/** Any other Metabase API failure (non-2xx, network, etc.). */
export class MetabaseApiError extends AgentContextError {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super("METABASE_API", message);
    this.status = status;
  }
}

/** A snapshot could not be built / validated / opened. */
export class SnapshotError extends AgentContextError {
  constructor(message: string) {
    super("SNAPSHOT", message);
  }
}

/** SQL rejected because it is not a safe read-only statement (§10). */
export class UnsafeSqlError extends AgentContextError {
  constructor(message: string) {
    super("UNSAFE_SQL", message);
  }
}

/** A requested entity / release / snapshot was not found. */
export class NotFoundError extends AgentContextError {
  constructor(message: string) {
    super("NOT_FOUND", message);
  }
}

/** A query targeted a database outside the configured allowlist. */
export class DatabaseAccessError extends AgentContextError {
  constructor(message: string) {
    super("DATABASE_ACCESS", message);
  }
}

/**
 * Query execution is disabled (default). Ctxd is a context + SQL compiler;
 * users run SQL in Metabase. Opt in with CTXD_ALLOW_QUERY=true for tech bots.
 */
export class QueryDisabledError extends AgentContextError {
  constructor(message = "Query execution is disabled. Ctxd drafts and validates SQL; run it in Metabase. Set CTXD_ALLOW_QUERY=true only for trusted tech bots.") {
    super("QUERY_DISABLED", message);
  }
}

/** A query could not be recorded in the audit log. */
export class AuditError extends AgentContextError {
  constructor(message: string) {
    super("AUDIT", message);
  }
}

export class SemanticError extends AgentContextError {
  constructor(message: string) {
    super("SEMANTIC_ERROR", message);
  }
}

export class SchemaReferenceError extends AgentContextError {
  constructor(message: string) {
    super("SCHEMA_REFERENCE_ERROR", message);
  }
}
