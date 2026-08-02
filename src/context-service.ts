/**
 * Context service — the shared retrieval brain used by both the CLI and the MCP
 * server. It resolves the active snapshot (the promoted `current`, or an explicit
 * release), answers compact context queries, validates SQL, and runs read-only
 * queries through Metabase with mandatory limits + local audit.
 *
 * Every response carries the source snapshot + release so an agent always knows
 * which version of the world it is reasoning about (§7.6, FR-5).
 */

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { AuditError, DatabaseAccessError, NotFoundError, QueryDisabledError, SchemaReferenceError, SnapshotError } from "./errors.js";
import { rejectIfDenylisted } from "./denylist.js";
import { logger } from "./logger.js";
import type { Asset, Entity, Relationship } from "./model.js";
import { MetabaseClient } from "./metabase/client.js";
import { ReleaseManager } from "./release/manager.js";
import { readManifest } from "./snapshot/manifest.js";
import { currentPointerPath, snapshotPaths } from "./snapshot/paths.js";
import { SnapshotReader } from "./snapshot/store.js";
import type { CurrentPointer, SnapshotManifest } from "./snapshot/types.js";
import {
  compileSemanticQuery,
  rankSemanticDefinitions,
  parseSemanticDefinitions,
  type SemanticDefinition,
  type SemanticMatch,
  type SemanticQuery,
} from "./semantic.js";
import {
  assertReadOnlySql,
  enforceLimit,
  extractSqlReferences,
  validateReadOnlySql,
  type SqlValidationResult,
} from "./sql/validate.js";
import { compileContractQuery, parseContextContract, type ContextContract, type ContractQuery } from "./contract.js";
import { rankHybridCandidates, type RankableColumn, type RankableTable, type RankedCandidate } from "./ranker.js";
import {
  buildSuggestedSemanticQuery,
  classifyQueryIntent,
  scorePlanConfidence,
  type PlanConfidence,
  type QueryIntent,
} from "./intent.js";

/** Provenance stamped onto every context response. */
export interface SourceRef {
  release: string;
  snapshot: string;
  schemaFingerprint: string;
}

/** Slim column projection returned by get_entity in compact (default) mode. */
export interface CompactColumn {
  name: string;
  type?: string;
  semanticType?: string;
  /** For a JSONB/struct parent: number of nested leaf fields collapsed under it. */
  nestedFields?: number;
}

export interface EntityContext {
  entity: Entity;
  /** Total real columns on the table (before nested-leaf collapsing). */
  columnCount: number;
  /** Compact projections by default; full Entity records when `full` was set. */
  columns: CompactColumn[] | Entity[];
  relationships: Relationship[];
  savedQuestions: Asset[];
  /** True when columns/questions are the slim projection (default). */
  compact: boolean;
  source: SourceRef;
}

/** Lean table hit for search — drops databaseId/schema/id noise. */
export interface TableHit {
  name: string;
  qualifiedName: string;
  description?: string;
  columnCount?: number;
  denylisted?: boolean;
}
/** Lean column hit for search. */
export interface ColumnHit {
  name: string;
  qualifiedName: string;
  table?: string;
  type?: string;
  semanticType?: string;
}
/** Lean asset hit for search. */
export interface AssetHit {
  name: string;
  kind: Asset["kind"];
  metabaseId: number;
  tableRefs: string[];
  url?: string;
}

export interface SearchResponse {
  tables: TableHit[];
  columns: ColumnHit[];
  assets: AssetHit[];
  source: SourceRef;
}

export interface QueryPlanResponse {
  question: string;
  intent: QueryIntent;
  intentReasons: string[];
  confidence: PlanConfidence;
  confidenceReasons: string[];
  semanticMatches: SemanticMatch[];
  suggestedSemanticQuery?: SemanticQuery;
  rankedTables: RankedCandidate<RankableTable>[];
  rankedColumns: RankedCandidate<RankableColumn>[];
  recommendedTables: string[];
  recommendedColumns: string[];
  /** Shortest FK join paths connecting the recommended tables (from the primary table). */
  joinPaths: { from: string; to: string; hops: number; joins: Relationship[] }[];
  /** Ready-to-use `FROM <primary> JOIN …` SQL built from the join paths — copy into a query. */
  suggestedFrom?: string;
  savedQuestions: AssetHit[];
  requiresClarification: boolean;
  clarificationReason?: string;
  source: SourceRef;
}

export interface FreshnessReport {
  hasCurrent: boolean;
  release?: string;
  schemaFingerprint?: string;
  generatedAt?: string;
  metabaseInstance?: string;
  /** Whether the current snapshot matches the deployed release/commit, if provided. */
  matchesDeployed?: boolean;
  deployedRelease?: string;
  deployedCommit?: string;
  counts?: SnapshotManifest["counts"];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  executionMode: "raw" | "semantic";
  source: SourceRef;
}

export interface ContextServiceOptions {
  snapshotDir: string;
  queryRowLimit: number;
  queryTimeoutMs: number;
  /** Optional Metabase client — required only for read-only query execution. */
  metabaseClient?: MetabaseClient;
  /** Empty/undefined means all databases visible to the API key. */
  allowedDatabaseIds?: number[];
  /** Deployed release/commit to compare against for freshness. */
  deployedRelease?: string;
  deployedCommit?: string;
  /** Optional vendor-neutral contract used for reviewed cross-entity compilation. */
  contextContractFile?: string;
  /**
   * When false (default), refuse to execute SQL through Metabase.
   * Context search/compile/validate still work; users run SQL in Metabase.
   */
  allowQueryExecution?: boolean;
}

export class ContextService {
  private reader?: SnapshotReader;
  private manifest?: SnapshotManifest;
  private source?: SourceRef;
  private semanticDefinitions: SemanticDefinition[] = [];
  private relationships: Relationship[] = [];
  private joinGraph?: Map<string, { to: string; edge: Relationship }[]>;
  /** Set when pinned to an explicit release (no auto-reload). */
  private pinnedRelease?: string;
  /** Raw current.json contents last loaded, used to detect promotions. */
  private currentPointerRaw?: string;
  private readonly releaseManager: ReleaseManager;
  private readonly contextContract?: ContextContract;

  constructor(private readonly opts: ContextServiceOptions) {
    this.releaseManager = new ReleaseManager(opts.snapshotDir);
    if (opts.contextContractFile && existsSync(opts.contextContractFile)) {
      this.contextContract = parseContextContract(JSON.parse(readFileSync(opts.contextContractFile, "utf8")));
    }
  }

  /**
   * Open the active snapshot. With no argument, tracks the promoted `current`
   * pointer and auto-reloads whenever it changes (so a long-running server picks
   * up a promotion without a restart). With an explicit release, pins to it.
   */
  async open(explicitRelease?: string): Promise<SourceRef> {
    this.pinnedRelease = explicitRelease;
    this.currentPointerRaw = undefined;
    this.ensureFresh();
    return this.src();
  }

  /** Load a release's manifest + search reader synchronously. */
  private loadSync(release: string): { reader: SnapshotReader; manifest: SnapshotManifest; source: SourceRef; semantics: SemanticDefinition[] } {
    const paths = snapshotPaths(this.opts.snapshotDir, release);
    if (!existsSync(paths.manifest)) {
      throw new SnapshotError(`No manifest found for release "${release}".`);
    }
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as SnapshotManifest;
    const semantics = existsSync(paths.semantics)
      ? parseSemanticDefinitions(JSON.parse(readFileSync(paths.semantics, "utf8")))
      : [];
    let reader: SnapshotReader;
    try {
      reader = new SnapshotReader(paths.search);
    } catch (err) {
      throw new SnapshotError(
        `Could not open search index for release "${release}": ${(err as Error).message}`,
      );
    }
    return {
      reader,
      manifest,
      source: { release: manifest.release, snapshot: manifest.snapshot, schemaFingerprint: manifest.schemaFingerprint },
      semantics,
    };
  }

  private setActive(loaded: { reader: SnapshotReader; manifest: SnapshotManifest; source: SourceRef; semantics: SemanticDefinition[] }): void {
    if (this.reader && this.reader !== loaded.reader) this.reader.close();
    this.reader = loaded.reader;
    this.manifest = loaded.manifest;
    this.source = loaded.source;
    this.semanticDefinitions = loaded.semantics;
    this.relationships = loaded.reader.getAllRelationships();
    this.joinGraph = this.buildJoinGraphFromRelationships(this.relationships);
  }

  /**
   * Ensure the active reader reflects the intended snapshot. In pinned mode this
   * loads the pinned release once. In current-pointer mode it re-reads
   * current.json on every access and hot-swaps the reader if a promotion changed
   * it — so requests never observe stale context and no request mutates the
   * active snapshot as a side effect.
   */
  private ensureFresh(): void {
    if (this.pinnedRelease) {
      if (!this.reader) this.setActive(this.loadSync(this.pinnedRelease));
      return;
    }
    const p = currentPointerPath(this.opts.snapshotDir);
    const raw = existsSync(p) ? readFileSync(p, "utf8") : undefined;
    if (!raw) {
      if (this.reader) return; // pointer removed mid-run: keep serving last-known
      throw new NotFoundError(
        "No current snapshot promoted. Run `ctxd snapshot promote --release <r>` first.",
      );
    }
    if (raw === this.currentPointerRaw && this.reader) return;
    const pointer = JSON.parse(raw) as CurrentPointer;
    this.setActive(this.loadSync(pointer.release));
    this.currentPointerRaw = raw;
    logger.info("context service loaded current snapshot", { release: pointer.release });
  }

  /**
   * Read-only inspection of a specific release's metadata WITHOUT changing the
   * active served snapshot (fixes the global-mutation hazard).
   */
  async describeRelease(release: string): Promise<{ source: SourceRef; manifest: SnapshotManifest }> {
    const manifest = await readManifest(this.opts.snapshotDir, release);
    return {
      source: { release: manifest.release, snapshot: manifest.snapshot, schemaFingerprint: manifest.schemaFingerprint },
      manifest,
    };
  }

  private requireReader(): SnapshotReader {
    this.ensureFresh();
    if (!this.reader) throw new SnapshotError("Context service is not open. Call open() first.");
    return this.reader;
  }

  private src(): SourceRef {
    this.ensureFresh();
    if (!this.source) throw new SnapshotError("Context service is not open.");
    return this.source;
  }

  /**
   * Compact search across tables, columns, and saved questions (§7.6, FR-3).
   * Returns only the top matches per category to respect a token budget.
   */
  search(query: string, opts: { scope?: "all" | "tables" | "columns" | "assets"; limit?: number } = {}): SearchResponse {
    const reader = this.requireReader();
    const scope = opts.scope ?? "all";
    const limit = opts.limit ?? 8;
    const wantTables = scope === "all" || scope === "tables";
    const wantColumns = scope === "all" || scope === "columns";
    const wantAssets = scope === "all" || scope === "assets";
    // Project to lean hit shapes — search is a discovery surface, so it returns
    // only what an agent needs to pick a target (name + qualified name + type),
    // not full Entity records. This is the single biggest token lever on the hot
    // path; full detail is one get_entity call away.
    return {
      tables: wantTables
        ? reader.searchEntities(query, { kinds: ["table"], limit }).map((e) => ({
            name: e.name,
            qualifiedName: e.qualifiedName,
            ...(e.description ? { description: e.description } : {}),
            ...(e.columnCount != null ? { columnCount: e.columnCount } : {}),
            ...(e.denylisted ? { denylisted: true } : {}),
          }))
        : [],
      columns: wantColumns
        ? reader.searchEntities(query, { kinds: ["column"], limit }).map((e) => ({
            name: e.name,
            qualifiedName: e.qualifiedName,
            ...(e.table ? { table: e.table } : {}),
            ...(e.dataType ? { type: e.dataType } : {}),
            ...(e.semanticType ? { semanticType: e.semanticType } : {}),
            // Tables already report this; without it here an agent cannot tell a
            // masked column from an ordinary one and may plan a query around PII.
            ...(e.denylisted ? { denylisted: true } : {}),
          }))
        : [],
      assets: wantAssets
        ? reader.searchAssets(query, { limit }).map((a) => ({
            name: a.name,
            kind: a.kind,
            metabaseId: a.metabaseId,
            tableRefs: a.tableRefs,
            ...(a.url ? { url: a.url } : {}),
          }))
        : [],
      source: this.src(),
    };
  }

  /**
   * Full context for a single entity: columns, relationships, and saved questions.
   *
   * Compact by default (small token footprint): columns are projected to
   * name/type/semanticType and Metabase's expanded nested-JSONB leaves are
   * collapsed back into their parent field with a count. Pass `full: true` for
   * the complete Entity records and untruncated saved-question SQL.
   */
  getEntity(nameOrId: string, opts: { full?: boolean } = {}): EntityContext {
    const reader = this.requireReader();
    const entity = reader.getEntity(nameOrId);
    if (!entity) throw new NotFoundError(`No entity found matching "${nameOrId}".`);
    const tableName =
      entity.kind === "table" ? entity.qualifiedName : entity.table ?? entity.qualifiedName;
    const rawColumns = entity.kind === "table" ? reader.getColumnsOfTable(tableName) : [];
    const rawQuestions = reader.getAssetsReferencingTable(tableName);
    const full = opts.full === true;
    return {
      entity,
      columnCount: rawColumns.length,
      columns: full ? rawColumns : compactColumns(rawColumns),
      relationships: reader.getRelationships(tableName),
      savedQuestions: full ? rawQuestions : rawQuestions.map(compactAsset),
      compact: !full,
      source: this.src(),
    };
  }

  getRelationships(nameOrId: string): { relationships: Relationship[]; source: SourceRef } {
    const reader = this.requireReader();
    const entity = reader.getEntity(nameOrId);
    if (!entity) throw new NotFoundError(`No entity found matching "${nameOrId}".`);
    const tableName =
      entity.kind === "table" ? entity.qualifiedName : entity.table ?? entity.qualifiedName;
    return { relationships: reader.getRelationships(tableName), source: this.src() };
  }

  findSavedQuestions(query: string, limit = 10): { assets: Asset[]; source: SourceRef } {
    const reader = this.requireReader();
    return {
      assets: reader.searchAssets(query, { kinds: ["question", "model"], limit }),
      source: this.src(),
    };
  }

  /**
   * Resolve a natural-language question into compact, inspectable query inputs.
   * This deliberately does not invent business definitions or execute SQL.
   * Agents can use the result to generate SQL, or ask for clarification when
   * the indexed context does not contain a canonical saved question.
   */
  planQuery(question: string, limit = 8): QueryPlanResponse {
    const reader = this.requireReader();
    const candidateLimit = Math.max(limit * 3, 12);
    const candidates = this.search(question, { scope: "all", limit: candidateLimit });
    const semanticMatches = rankSemanticDefinitions(question, this.semanticDefinitions, limit);
    const intent = classifyQueryIntent(question, semanticMatches);
    const topScore = semanticMatches[0]?.score ?? 0;
    const metricIntent = intent.intent === "metric_only" || intent.intent === "metric_by_dimension";
    const rankingSemanticMatches = metricIntent || intent.intent === "definition"
      ? semanticMatches
      : semanticMatches.filter((match) => match.score >= 2);
    const semanticTables = rankingSemanticMatches
      .map((match) => reader.getEntity(match.definition.table))
      .filter((entity): entity is Entity => entity !== undefined && entity.kind === "table")
      .map((entity) => ({
        name: entity.name,
        qualifiedName: entity.qualifiedName,
        ...(entity.description ? { description: entity.description } : {}),
        ...(entity.columnCount != null ? { columnCount: entity.columnCount } : {}),
        ...(entity.denylisted ? { denylisted: true } : {}),
      }));
    const semanticColumns = rankingSemanticMatches
      .flatMap((match) => match.definition.columns)
      .map((column) => reader.getEntity(column))
      .filter((entity): entity is Entity => entity !== undefined && entity.kind === "column")
      .map((entity) => ({
        name: entity.name,
        qualifiedName: entity.qualifiedName,
        ...(entity.table ? { table: entity.table } : {}),
        ...(entity.dataType ? { type: entity.dataType } : {}),
        ...(entity.semanticType ? { semanticType: entity.semanticType } : {}),
      }));
    const ranked = rankHybridCandidates({
      question,
      intent: intent.intent,
      tables: uniqueByQualifiedName([...semanticTables, ...candidates.tables]),
      columns: uniqueByQualifiedName([...semanticColumns, ...candidates.columns]),
      semanticMatches: rankingSemanticMatches,
      relationships: this.relationships,
    });
    const rankedTables = ranked.tables.slice(0, limit);
    const rankedColumns = ranked.columns.slice(0, limit);
    const tableNames = rankedTables.map((rankedTable) => rankedTable.item.qualifiedName);
    const columnNames = rankedColumns.map((rankedColumn) => rankedColumn.item.qualifiedName);
    const savedQuestions = candidates.assets.filter(
      (asset) => asset.kind === "question" || asset.kind === "model",
    ).slice(0, limit);
    const tiedTop = semanticMatches.filter((match) => match.score === topScore && topScore > 0);
    const groupedQuestion = intent.intent === "metric_by_dimension";
    const closeSemanticCandidates = semanticMatches.length > 1
      ? topScore - (semanticMatches[1]?.score ?? 0) <= 2
      : topScore <= 2;
    const hasUsefulSemanticMatch = topScore >= 2;
    const lowConfidenceSemanticMatch = groupedQuestion && semanticMatches.length > 0 && closeSemanticCandidates && tableNames.length > 1 && savedQuestions.length === 0;
    const requiresClarification = tiedTop.length > 1 || lowConfidenceSemanticMatch || (semanticMatches.length === 0 && savedQuestions.length === 0 && tableNames.length > 1);
    const semanticTablesToRecommend = hasUsefulSemanticMatch && metricIntent
      ? semanticMatches.map((match) => match.definition.table)
      : [];
    const searchTablesToAdd = hasUsefulSemanticMatch && intent.intent === "metric_only"
      ? []
      : tableNames.slice(0, intent.intent === "metric_by_dimension" || intent.intent === "join_exploration" ? 3 : 2);
    // Prefer semantic-definition tables once the metric is identified. Search-hit
    // tables are added only when the question asks for grouping/dimensions or when
    // no useful semantic metric matched; otherwise unrelated "response"-like
    // tables leak into the join plan and small models over-join.
    const recommendedTables = [
      ...new Set([
        ...semanticTablesToRecommend,
        ...searchTablesToAdd,
      ]),
    ].slice(0, 4);

    // Precompute how the recommended tables join together, so the agent gets the
    // full join graph in ONE call instead of issuing separate join-path/search
    // requests. Paths run from the primary (first) table to each of the others.
    const joinPaths: QueryPlanResponse["joinPaths"] = [];
    let suggestedFrom: string | undefined;
    if (recommendedTables.length > 1) {
      const graph = this.joinGraph ?? this.buildJoinGraphFromRelationships(this.relationships);
      const primary = recommendedTables[0]!.toLowerCase();
      for (const other of recommendedTables.slice(1)) {
        const p = this.shortestJoinPath(graph, primary, other.toLowerCase());
        if (p && p.length) joinPaths.push({ from: recommendedTables[0]!, to: other, hops: p.length, joins: p });
      }
      suggestedFrom = this.buildFromClause(recommendedTables[0]!, joinPaths);
    }

    // Include the name-ish columns of every joined table so the agent doesn't have
    // to hunt for them (the biggest cause of thrash on join questions).
    const joinTables = new Set(joinPaths.flatMap((j) => j.joins.flatMap((e) => [e.fromTable, e.toTable])));
    const nameColumns: string[] = [];
    for (const t of joinTables) {
      for (const c of reader.getColumnsOfTable(t)) {
        if (/^(name|title|label|display_name)$/i.test(c.name)) nameColumns.push(c.qualifiedName);
      }
    }
    const recommendedColumns = [
      ...new Set([
        ...(semanticMatches.length ? semanticMatches.flatMap((m) => m.definition.columns) : columnNames.slice(0, 6)),
        ...nameColumns,
      ]),
    ];
    const suggestedSemanticQuery = buildSuggestedSemanticQuery(question, intent.intent, semanticMatches);
    const confidence = scorePlanConfidence({
      intent: intent.intent,
      semanticMatches,
      rankedTables,
      savedQuestionCount: savedQuestions.length,
      requiresClarification,
      hasSuggestedSemanticQuery: Boolean(suggestedSemanticQuery),
    });

    return {
      question,
      intent: intent.intent,
      intentReasons: intent.reasons,
      confidence: confidence.confidence,
      confidenceReasons: confidence.reasons,
      semanticMatches,
      ...(suggestedSemanticQuery ? { suggestedSemanticQuery } : {}),
      rankedTables,
      rankedColumns,
      recommendedTables,
      recommendedColumns,
      joinPaths,
      ...(suggestedFrom ? { suggestedFrom } : {}),
      savedQuestions,
      requiresClarification,
      ...(requiresClarification
        ? {
            clarificationReason:
              tiedTop.length > 1
                ? "Multiple semantic definitions match with equal confidence."
                : lowConfidenceSemanticMatch
                  ? "This grouped question has no canonical dimension and multiple physical entities match; choose the intended entity before querying."
                : "Multiple tables match and no canonical saved question defines the metric.",
          }
        : {}),
      source: this.src(),
    };
  }

  async runSemanticQuery(id: string, databaseId?: number): Promise<QueryResult> {
    const definition = this.semanticDefinitions.find((item) => item.id === id);
    if (!definition) throw new NotFoundError(`No semantic definition found for "${id}".`);
    return this.runReadonlyQuery(definition.sqlTemplate, this.resolveSemanticDatabaseId(definition, databaseId), "semantic");
  }

  compileSemanticQuery(query: SemanticQuery): { sql: string; source: SourceRef } {
    this.requireReader();
    return { sql: compileSemanticQuery(query, this.semanticDefinitions), source: this.src() };
  }

  compileContractQuery(query: ContractQuery): { sql: string; source: SourceRef } {
    this.requireReader();
    if (!this.contextContract) throw new NotFoundError("No context contract is configured. Set CONTEXT_CONTRACT_FILE.");
    return { sql: compileContractQuery(query, this.contextContract), source: this.src() };
  }

  async runCompiledSemanticQuery(query: SemanticQuery, databaseId?: number): Promise<QueryResult> {
    const compiled = this.compileSemanticQuery(query);
    const definition = this.semanticDefinitions.find((item) => query.measures.includes(item.id));
    return this.runReadonlyQuery(compiled.sql, definition ? this.resolveSemanticDatabaseId(definition, databaseId) : databaseId, "semantic");
  }

  private resolveSemanticDatabaseId(definition: SemanticDefinition, explicit?: number): number | undefined {
    if (explicit !== undefined) return explicit;
    if (definition.databaseName) return this.requireReader().getEntity(definition.databaseName)?.databaseId;
    return definition.databaseId;
  }

  /** Freshness / version-match report (FR-5). */
  async freshness(): Promise<FreshnessReport> {
    const current = await this.releaseManager.getCurrent();
    if (!current) return { hasCurrent: false };
    const manifest = await readManifest(this.opts.snapshotDir, current.release).catch(() => undefined);
    const matchesDeployed =
      this.opts.deployedCommit && current.gitCommit
        ? this.opts.deployedCommit === current.gitCommit
        : this.opts.deployedRelease
          ? this.opts.deployedRelease === current.release
          : undefined;
    return {
      hasCurrent: true,
      release: current.release,
      schemaFingerprint: current.schemaFingerprint,
      generatedAt: manifest?.generatedAt ?? current.promotedAt,
      metabaseInstance: manifest?.metabaseInstance,
      matchesDeployed,
      deployedRelease: this.opts.deployedRelease,
      deployedCommit: this.opts.deployedCommit,
      counts: manifest?.counts,
    };
  }

  /** Validate SQL is read-only without executing it (§7.6). */
  validateSql(sql: string): SqlValidationResult & { source: SourceRef } {
    return { ...validateReadOnlySql(sql), source: this.src() };
  }

  /**
   * Execute a validated read-only query through Metabase with row/time limits and
   * local audit (§7.6, §10, FR-6).
   */
  async runReadonlyQuery(sql: string, databaseId?: number, executionMode: "raw" | "semantic" = "raw"): Promise<QueryResult> {
    if (!this.opts.allowQueryExecution) {
      throw new QueryDisabledError();
    }
    const reader = this.requireReader();
    // Defense in depth: throws UnsafeSqlError if not a safe SELECT/WITH.
    assertReadOnlySql(sql);
    this.validateSqlReferences(sql, reader);
    if (!this.opts.metabaseClient) {
      throw new SnapshotError(
        "Read-only query execution requires Metabase credentials (set METABASE_URL and METABASE_API_KEY).",
      );
    }

    // Resolve which database to run against.
    const targetDb = databaseId ?? this.inferDatabaseId(reader);
    if (targetDb == null) {
      throw new SnapshotError(
        "Could not infer a target database id; pass databaseId explicitly.",
      );
    }
    const allowed = this.opts.allowedDatabaseIds;
    if (allowed && allowed.length > 0 && !allowed.includes(targetDb)) {
      throw new DatabaseAccessError(
        `Database ${targetDb} is not in the configured METABASE_DATABASE_IDS allowlist.`,
      );
    }

    const limited = enforceLimit(sql, this.opts.queryRowLimit);
    await this.audit({ sql: limited, databaseId: targetDb });

    const result = await this.opts.metabaseClient.runNativeQuery(targetDb, limited, {
      rowLimit: this.opts.queryRowLimit,
      timeoutMs: this.opts.queryTimeoutMs,
    });
    const rows = result.data?.rows ?? [];
    const columns = (result.data?.cols ?? []).map((c) => c.name);
    return {
      columns,
      rows,
      rowCount: result.row_count ?? rows.length,
      truncated: (result.row_count ?? rows.length) > rows.length,
      executionMode,
      source: this.src(),
    };
  }

  private validateSqlReferences(sql: string, reader: SnapshotReader): void {
    const refs = extractSqlReferences(sql);
    const physicalTables = new Set<string>();
    for (const table of refs.tables) {
      const entity = reader.getEntity(table);
      if (!entity || entity.kind !== "table") {
        const suggestions = this.referenceSuggestions(table, reader, "tables");
        throw new SchemaReferenceError(
          `Unknown table "${table}" in SQL.${suggestions ? ` Did you mean: ${suggestions}?` : ""}`,
        );
      }
      rejectIfDenylisted(entity);
      physicalTables.add(entity.qualifiedName.toLowerCase());
    }
    for (const ref of refs.columns) {
      const candidates = ref.table
        ? [ref.table]
        : [...physicalTables];
      const matches = candidates.filter((table) =>
        reader.getColumnsOfTable(table).some((column) => column.name.toLowerCase() === ref.column.toLowerCase()),
      );
      if (matches.length === 0) {
        const suggestions = this.referenceSuggestions(ref.column, reader, "columns");
        throw new SchemaReferenceError(
          `Unknown column "${ref.table ? `${ref.table}.` : ""}${ref.column}" in SQL.${suggestions ? ` Did you mean: ${suggestions}?` : ""}`,
        );
      }
      for (const table of matches) {
        const columnEntity = reader.getColumnsOfTable(table).find(
          (column) => column.name.toLowerCase() === ref.column.toLowerCase(),
        );
        if (columnEntity) rejectIfDenylisted(columnEntity);
      }
    }
  }

  private referenceSuggestions(query: string, reader: SnapshotReader, scope: "tables" | "columns"): string {
    const terms = query.split(/[._]/).filter(Boolean);
    const hits = reader.searchEntities(terms.join(" "), {
      kinds: scope === "tables" ? ["table"] : ["column"],
      limit: 3,
    });
    return hits.map((hit) => hit.qualifiedName).join(", ");
  }

  /** Pick a database id from the snapshot when the caller didn't specify one. */
  private inferDatabaseId(reader: SnapshotReader): number | undefined {
    const allowed = this.opts.allowedDatabaseIds;
    if (allowed?.length === 1) return allowed[0];
    const dbHit = reader.searchEntities("database", { kinds: ["database"], limit: 1 });
    if (dbHit[0]) return dbHit[0].databaseId;
    // Fall back to any entity's database id.
    const any = reader.getEntity("database");
    return any?.databaseId;
  }

  /** Append an executed-query record to a local audit log (§10). */
  private async audit(record: { sql: string; databaseId: number }): Promise<void> {
    try {
      const dir = path.join(this.opts.snapshotDir, "..", "audit");
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        release: this.source?.release,
        databaseId: record.databaseId,
        sql: record.sql,
      });
      await appendFile(path.join(dir, "queries.jsonl"), line + "\n", "utf8");
    } catch (err) {
      throw new AuditError(`Could not write query audit log: ${(err as Error).message}`);
    }
  }

  /**
   * Shortest FK join path between two tables (BFS over the FK graph). Returns the
   * ordered list of edges to join A to B, or null if unconnected. Treats FKs as
   * undirected for pathfinding (a join works in either direction).
   *
   * Memory-efficient: loads only the edge list (a few hundred rows) and does a
   * plain BFS — no full-model load, no recursion.
   */
  getJoinPath(tableA: string, tableB: string): { path: Relationship[]; hops: number; source: SourceRef } | { path: null; source: SourceRef } {
    const reader = this.requireReader();
    const a = reader.getEntity(tableA);
    const b = reader.getEntity(tableB);
    if (!a) throw new NotFoundError(`No entity found matching "${tableA}".`);
    if (!b) throw new NotFoundError(`No entity found matching "${tableB}".`);
    const start = (a.kind === "table" ? a.qualifiedName : a.table ?? a.qualifiedName).toLowerCase();
    const goal = (b.kind === "table" ? b.qualifiedName : b.table ?? b.qualifiedName).toLowerCase();
    const path = this.shortestJoinPath(this.joinGraph ?? this.buildJoinGraphFromRelationships(this.relationships), start, goal);
    if (path === null) return { path: null, source: this.src() };
    return { path, hops: path.length, source: this.src() };
  }

  /**
   * Build a ready-to-use `FROM <primary> JOIN …` clause from join paths, with a
   * deterministic alias per table. The agent copies this instead of reconstructing
   * joins from a data structure — which is where small models hallucinate.
   */
  private buildFromClause(primary: string, joinPaths: QueryPlanResponse["joinPaths"]): string | undefined {
    if (!joinPaths.length) return undefined;
    const alias = new Map<string, string>();
    const used = new Set<string>();
    const aliasFor = (table: string): string => {
      const existing = alias.get(table);
      if (existing) return existing;
      const base = (table.split(".").pop() ?? table).replace(/[^a-z0-9]/gi, "").slice(0, 3).toLowerCase() || "t";
      let a = RESERVED_SQL_ALIASES.has(base) ? `${base}_t` : base;
      let i = 1;
      while (used.has(a)) {
        const candidate = `${base}${++i}`;
        a = RESERVED_SQL_ALIASES.has(candidate) ? `${candidate}_t` : candidate;
      }
      used.add(a);
      alias.set(table, a);
      return a;
    };
    const parts = [`FROM ${primary} ${aliasFor(primary)}`];
    for (const jp of joinPaths) {
      for (const e of jp.joins) {
        // Emit the not-yet-joined side of this edge.
        const known = alias.has(e.fromTable) ? e.fromTable : e.toTable;
        const next = known === e.fromTable ? e.toTable : e.fromTable;
        if (alias.has(next)) continue;
        const ka = aliasFor(known);
        const na = aliasFor(next);
        const kCol = known === e.fromTable ? e.fromColumn : e.toColumn;
        const nCol = known === e.fromTable ? e.toColumn : e.fromColumn;
        parts.push(`JOIN ${next} ${na} ON ${ka}.${kCol} = ${na}.${nCol}`);
      }
    }
    return parts.join("\n");
  }

  /** Build an undirected FK adjacency map (lower-cased table names). Load once, reuse. */
  private buildJoinGraphFromRelationships(relationships: Relationship[]): Map<string, { to: string; edge: Relationship }[]> {
    const adj = new Map<string, { to: string; edge: Relationship }[]>();
    const link = (from: string, to: string, edge: Relationship) => {
      const l = from.toLowerCase();
      (adj.get(l) ?? adj.set(l, []).get(l)!).push({ to: to.toLowerCase(), edge });
    };
    for (const e of relationships) {
      link(e.fromTable, e.toTable, e);
      link(e.toTable, e.fromTable, e); // undirected — a join works either direction
    }
    return adj;
  }

  /** BFS shortest path over a prebuilt join graph. Returns [] for same node, null if unconnected. */
  private shortestJoinPath(
    adj: Map<string, { to: string; edge: Relationship }[]>,
    start: string,
    goal: string,
  ): Relationship[] | null {
    if (start === goal) return [];
    const prev = new Map<string, { from: string; edge: Relationship }>();
    const queue: string[] = [start];
    const seen = new Set([start]);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === goal) break;
      for (const { to, edge } of adj.get(cur) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        prev.set(to, { from: cur, edge });
        queue.push(to);
      }
    }
    if (!prev.has(goal)) return null;
    const path: Relationship[] = [];
    let node = goal;
    while (node !== start) {
      const step = prev.get(node);
      if (!step) return null;
      path.push(step.edge);
      node = step.from;
    }
    path.reverse();
    return path;
  }

  /** Read the changes.json diff for a release (schema drift between snapshots). */
  async getChanges(release?: string): Promise<{ release: string; changes: unknown; source: SourceRef }> {
    const rel = release ?? this.src().release;
    const p = snapshotPaths(this.opts.snapshotDir, rel).changes;
    if (!existsSync(p)) {
      throw new NotFoundError(`No changes.json for release "${rel}".`);
    }
    const changes = JSON.parse(readFileSync(p, "utf8"));
    return { release: rel, changes, source: this.src() };
  }

  /** Whether this service may execute SQL through Metabase (opt-in). */
  get allowsQueryExecution(): boolean {
    return this.opts.allowQueryExecution === true;
  }

  /** Snapshot directory this service reads from (used by the metrics recorder). */
  get snapshotDir(): string {
    return this.opts.snapshotDir;
  }

  /** Release of the currently active snapshot, if open. */
  get activeRelease(): string | undefined {
    return this.source?.release;
  }

  close(): void {
    this.reader?.close();
  }
}

/** Separator Metabase uses when it expands a nested JSONB/struct field. */
const NESTED_SEP = "→";
const SQL_PREVIEW_CHARS = 240;
const RESERVED_SQL_ALIASES = new Set([
  "all",
  "and",
  "any",
  "as",
  "asc",
  "by",
  "desc",
  "for",
  "from",
  "group",
  "in",
  "join",
  "on",
  "or",
  "order",
  "select",
  "table",
  "use",
  "user",
  "where",
  "with",
]);

/**
 * Project full column entities into slim, low-token records and collapse the
 * nested-JSONB leaves (e.g. "intake_form → requestedAmount") back under their
 * parent field, annotating the parent with a nestedFields count. This is the fix
 * that keeps get_entity compact on wide/JSONB-heavy tables.
 */
export function compactColumns(cols: Entity[]): CompactColumn[] {
  const nestedCountByParent = new Map<string, number>();
  const topLevel: Entity[] = [];
  for (const c of cols) {
    if (c.name.includes(NESTED_SEP)) {
      const parent = c.name.split(NESTED_SEP)[0]!.trim();
      nestedCountByParent.set(parent, (nestedCountByParent.get(parent) ?? 0) + 1);
    } else {
      topLevel.push(c);
    }
  }
  const seen = new Set(topLevel.map((c) => c.name));
  const out: CompactColumn[] = topLevel.map((c) => {
    const nested = nestedCountByParent.get(c.name);
    return {
      name: c.name,
      type: c.dataType,
      semanticType: c.semanticType,
      ...(nested ? { nestedFields: nested } : {}),
    };
  });
  // Any nested parent that wasn't itself a top-level column (rare) — synthesize.
  for (const [parent, count] of nestedCountByParent) {
    if (!seen.has(parent)) out.push({ name: parent, type: "jsonb", nestedFields: count });
  }
  return out;
}

/** Project an asset into a low-token record, truncating native SQL to a preview. */
export function compactAsset(a: Asset): Asset {
  if (!a.nativeSql || a.nativeSql.length <= SQL_PREVIEW_CHARS) return a;
  return { ...a, nativeSql: a.nativeSql.slice(0, SQL_PREVIEW_CHARS) + " …[truncated; use full=true]" };
}

function uniqueByQualifiedName<T extends { qualifiedName: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = item.qualifiedName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
