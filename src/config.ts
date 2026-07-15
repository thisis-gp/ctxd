/**
 * Configuration loading and validation.
 *
 * All configuration comes from environment variables (§10). Secrets are read
 * here and passed explicitly to the Metabase client; they are never re-read from
 * a global or written to disk.
 */

import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { ConfigError } from "./errors.js";

loadDotenv();

/** Parsed, validated runtime configuration. */
export interface AppConfig {
  metabaseUrl: string;
  metabaseApiKey: string;
  /** Empty array = all databases the key can access. */
  databaseIds: number[];
  metabaseInstance: string;
  snapshotDir: string;
  semanticDefinitionsFile: string;
  contextContractFile: string;
  queryRowLimit: number;
  queryTimeoutMs: number;
  /** Normalized lower-cased denylist entries (schema.table, table, or table.column). */
  denylist: string[];
  /**
   * Admin secret for /admin dashboard (issue per-user connector tokens).
   * End users never share this — each gets their own token from the dashboard.
   */
  adminToken: string;
  dataDir: string;
  httpHost: string;
  httpPort: number;
  /**
   * When false (default), MCP/CLI will not execute SQL through Metabase.
   * Ctxd remains a context + SQL compiler; users run queries in Metabase.
   * Set CTXD_ALLOW_QUERY=true only for trusted tech bots.
   */
  allowQueryExecution: boolean;
}

const envSchema = z.object({
  METABASE_URL: z.string().url("METABASE_URL must be a valid URL"),
  METABASE_API_KEY: z.string().min(1, "METABASE_API_KEY is required"),
  METABASE_DATABASE_IDS: z.string().optional().default(""),
  METABASE_INSTANCE: z.string().optional().default("production"),
  SNAPSHOT_DIR: z.string().optional().default("./snapshots"),
  SEMANTIC_DEFINITIONS_FILE: z.string().optional().default("./semantics/definitions.json"),
  CONTEXT_CONTRACT_FILE: z.string().optional().default("./context.contract.json"),
  QUERY_ROW_LIMIT: z.coerce.number().int().positive().optional().default(1000),
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().optional().default(15000),
  DENYLIST: z.string().optional().default(""),
  CTXD_ADMIN_TOKEN: z.string().optional().default(""),
  CTXD_DATA_DIR: z.string().optional().default("./data"),
  CTXD_HTTP_HOST: z.string().optional().default("0.0.0.0"),
  CTXD_HTTP_PORT: z.coerce.number().int().positive().optional().default(8787),
  CTXD_ALLOW_QUERY: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v.toLowerCase() === "true" || v === "1"),
});

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

function parseIdList(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) {
        throw new ConfigError(`METABASE_DATABASE_IDS contains a non-integer id: "${s}"`);
      }
      return n;
    });
}

function parseDenylist(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Load full config. Requires Metabase credentials — use for build/serve.
 * Throws ConfigError with an actionable message if anything is missing.
 */
export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(
      `Invalid configuration. Check your .env (see .env.example):\n${issues}`,
    );
  }
  const e = parsed.data;
  return {
    metabaseUrl: e.METABASE_URL.replace(/\/+$/, ""),
    metabaseApiKey: e.METABASE_API_KEY,
    databaseIds: parseIdList(e.METABASE_DATABASE_IDS),
    metabaseInstance: e.METABASE_INSTANCE,
    snapshotDir: e.SNAPSHOT_DIR,
    semanticDefinitionsFile: e.SEMANTIC_DEFINITIONS_FILE,
    contextContractFile: e.CONTEXT_CONTRACT_FILE,
    queryRowLimit: e.QUERY_ROW_LIMIT,
    queryTimeoutMs: e.QUERY_TIMEOUT_MS,
    denylist: parseDenylist(e.DENYLIST),
    adminToken: e.CTXD_ADMIN_TOKEN,
    dataDir: e.CTXD_DATA_DIR,
    httpHost: e.CTXD_HTTP_HOST,
    httpPort: e.CTXD_HTTP_PORT,
    allowQueryExecution: e.CTXD_ALLOW_QUERY,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Load config that does NOT require Metabase credentials — used by commands that
 * only touch local snapshots (search, freshness, promote, rollback). Falls back
 * to sensible defaults so `serve`/search work offline against a built snapshot.
 */
export function loadLocalConfig(): Pick<
  AppConfig,
  | "snapshotDir"
  | "semanticDefinitionsFile"
  | "contextContractFile"
  | "queryRowLimit"
  | "queryTimeoutMs"
  | "denylist"
  | "metabaseInstance"
  | "adminToken"
  | "dataDir"
  | "httpHost"
  | "httpPort"
  | "allowQueryExecution"
> {
  return {
    snapshotDir: process.env.SNAPSHOT_DIR ?? "./snapshots",
    semanticDefinitionsFile: process.env.SEMANTIC_DEFINITIONS_FILE ?? "./semantics/definitions.json",
    contextContractFile: process.env.CONTEXT_CONTRACT_FILE ?? "./context.contract.json",
    queryRowLimit: parsePositiveInt(process.env.QUERY_ROW_LIMIT, 1000),
    queryTimeoutMs: parsePositiveInt(process.env.QUERY_TIMEOUT_MS, 15000),
    denylist: parseDenylist(process.env.DENYLIST ?? ""),
    metabaseInstance: process.env.METABASE_INSTANCE ?? "production",
    adminToken: process.env.CTXD_ADMIN_TOKEN ?? "",
    dataDir: process.env.CTXD_DATA_DIR ?? "./data",
    httpHost: process.env.CTXD_HTTP_HOST ?? "0.0.0.0",
    httpPort: parsePositiveInt(process.env.CTXD_HTTP_PORT, 8787),
    allowQueryExecution: parseBool(process.env.CTXD_ALLOW_QUERY, false),
  };
}
