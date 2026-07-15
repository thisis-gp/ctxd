/**
 * Metabase API client — the adapter boundary (§7.1).
 *
 * This is the ONLY module permitted to talk HTTP to Metabase or understand its
 * response shapes. It exposes narrow, intention-revealing methods; everything
 * else in the app depends on these methods (and the normalized model), never on
 * raw endpoints.
 *
 * Safety:
 *  - The API key is passed in via the constructor (from config), never read from
 *    a global, and is sent as the `x-api-key` header. It is never logged.
 *  - Query execution goes through the dataset endpoint and is treated as
 *    read-only; SQL is validated upstream before it ever reaches here.
 */

import { MetabaseApiError, MetabaseAuthError } from "../errors.js";
import { logger } from "../logger.js";
import type {
  MbCard,
  MbDashboard,
  MbDatabase,
  MbDatabaseMetadata,
  MbDatasetResult,
} from "./types.js";

export interface MetabaseClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export class MetabaseClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: MetabaseClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "x-api-key": this.apiKey,
          "content-type": "application/json",
          accept: "application/json",
          ...(init.headers ?? {}),
        },
      });

      if (res.status === 401 || res.status === 403) {
        throw new MetabaseAuthError(
          `Metabase rejected the API key (HTTP ${res.status}) for ${path}. ` +
            `Verify METABASE_API_KEY and its permissions.`,
        );
      }
      if (!res.ok) {
        const body = await safeText(res);
        throw new MetabaseApiError(
          `Metabase API ${path} failed: HTTP ${res.status} ${res.statusText}${
            body ? ` — ${body.slice(0, 300)}` : ""
          }`,
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof MetabaseAuthError || err instanceof MetabaseApiError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new MetabaseApiError(`Metabase API ${path} timed out after ${timeoutMs}ms`);
      }
      throw new MetabaseApiError(
        `Metabase API ${path} request failed: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verify connectivity + auth cheaply. Returns the authenticated user email. */
  async ping(): Promise<{ ok: true }> {
    await this.request<unknown>("/api/user/current");
    return { ok: true };
  }

  /** List databases (without heavy table payloads). */
  async listDatabases(): Promise<MbDatabase[]> {
    // Metabase may wrap the list in { data: [...] } depending on version.
    const raw = await this.request<MbDatabase[] | { data: MbDatabase[] }>("/api/database");
    return Array.isArray(raw) ? raw : raw.data;
  }

  /** Full metadata for one database: tables + fields + fk targets (§7.2). */
  async getDatabaseMetadata(databaseId: number): Promise<MbDatabaseMetadata> {
    return this.request<MbDatabaseMetadata>(`/api/database/${databaseId}/metadata`);
  }

  /** List all accessible cards (questions + models) (§7.3). */
  async listCards(): Promise<MbCard[]> {
    const raw = await this.request<MbCard[] | { data: MbCard[] }>("/api/card");
    return Array.isArray(raw) ? raw : raw.data;
  }

  /** List dashboards (summary form). */
  async listDashboards(): Promise<MbDashboard[]> {
    const raw = await this.request<MbDashboard[] | { data: MbDashboard[] }>("/api/dashboard");
    return Array.isArray(raw) ? raw : raw.data;
  }

  /** Fetch one dashboard with its card references. */
  async getDashboard(dashboardId: number): Promise<MbDashboard> {
    return this.request<MbDashboard>(`/api/dashboard/${dashboardId}`);
  }

  /**
   * Execute a read-only native query against a database via /api/dataset.
   *
   * This client does NOT validate the SQL — validation happens upstream in
   * src/sql/validate.ts before this is ever called (§10, defense in depth).
   */
  async runNativeQuery(
    databaseId: number,
    sql: string,
    opts: { rowLimit: number; timeoutMs: number },
  ): Promise<MbDatasetResult> {
    logger.debug("metabase.runNativeQuery", { databaseId, rowLimit: opts.rowLimit });
    const result = await this.request<MbDatasetResult>(
      "/api/dataset",
      {
        method: "POST",
        body: JSON.stringify({
          database: databaseId,
          type: "native",
          native: { query: sql },
          // Metabase honors constraints for row-limiting the result set.
          constraints: {
            "max-results": opts.rowLimit,
            "max-results-bare-rows": opts.rowLimit,
          },
        }),
      },
      opts.timeoutMs,
    );
    if (result.status && result.status !== "completed") {
      throw new MetabaseApiError(
        `Query did not complete (status=${result.status})${
          result.error ? `: ${result.error}` : ""
        }`,
      );
    }
    return result;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
