/**
 * Context snapshot builder (§7.4).
 *
 * Orchestrates a full build: Metabase adapter -> metadata indexer -> content
 * indexer -> normalized model -> deterministic fingerprint -> on-disk snapshot
 * (JSONL sources + manifest + search.sqlite + changes diff).
 *
 * The result is compact, searchable, reproducible, and tied to a source
 * fingerprint. It contains metadata and query definitions only — never rows.
 */

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { AppConfig } from "../config.js";
import { Denylist } from "../denylist.js";
import { SnapshotError } from "../errors.js";
import { logger } from "../logger.js";
import type { NormalizedModel } from "../model.js";
import { ContentIndexer } from "../indexer/content-indexer.js";
import { MetadataIndexer } from "../indexer/metadata-indexer.js";
import { MetabaseClient } from "../metabase/client.js";
import { computeSchemaFingerprint } from "./fingerprint.js";
import {
  diffModels,
  readManifest,
  readSnapshotModel,
  writeChanges,
  writeSnapshotFiles,
} from "./manifest.js";
import { currentPointerPath, snapshotPaths } from "./paths.js";
import { SnapshotWriter } from "./store.js";
import type { CurrentPointer, SnapshotManifest } from "./types.js";
import { loadSemanticDefinitions, validateSemanticDefinitions } from "../semantic.js";

const BUILDER_VERSION = "0.1.0";

/** Throw if the release is published, current, or referenced by the current pointer. */
async function assertNotActive(snapshotDir: string, release: string): Promise<void> {
  const manifest = await readManifest(snapshotDir, release).catch(() => undefined);
  if (manifest && (manifest.status === "published" || manifest.status === "current")) {
    throw new SnapshotError(
      `Refusing to overwrite release "${release}" — its status is "${manifest.status}". ` +
        `Roll back or promote a different release first.`,
    );
  }
  const curPath = currentPointerPath(snapshotDir);
  if (existsSync(curPath)) {
    const pointer = JSON.parse(await readFile(curPath, "utf8")) as CurrentPointer;
    if (pointer.release === release) {
      throw new SnapshotError(
        `Refusing to overwrite release "${release}" — it is the current promoted snapshot.`,
      );
    }
  }
}

export interface BuildOptions {
  release: string;
  gitCommit?: string;
  /** Release id of a previous snapshot to diff against for changes.json. */
  previousRelease?: string;
  /** Overwrite an existing snapshot dir instead of failing. */
  force?: boolean;
}

export interface BuildResult {
  manifest: SnapshotManifest;
  model: NormalizedModel;
}

function countModel(model: NormalizedModel) {
  const tables = model.entities.filter((e) => e.kind === "table").length;
  const columns = model.entities.filter((e) => e.kind === "column").length;
  const databases = model.entities.filter((e) => e.kind === "database").length;
  return {
    databases,
    tables,
    columns,
    relationships: model.relationships.length,
    assets: model.assets.length,
  };
}

/**
 * Index live Metabase into a normalized model + fingerprint WITHOUT writing any
 * snapshot files. Shared by buildSnapshot and the drift check so both compute the
 * fingerprint identically. Read-only: no disk mutation, no `current` pointer touch.
 */
export async function computeLiveModel(
  config: AppConfig,
): Promise<{ model: NormalizedModel; fingerprint: string; counts: ReturnType<typeof countModel> }> {
  const client = new MetabaseClient({
    baseUrl: config.metabaseUrl,
    apiKey: config.metabaseApiKey,
    timeoutMs: config.queryTimeoutMs,
  });
  await client.ping();
  const denylist = new Denylist(config.denylist);
  const meta = await new MetadataIndexer(client, denylist).index(config.databaseIds);
  const content = await new ContentIndexer(client).index(meta.tableIdToQualified, config.databaseIds);
  const model: NormalizedModel = {
    entities: meta.entities,
    relationships: meta.relationships,
    assets: content.assets,
  };
  return { model, fingerprint: computeSchemaFingerprint(model), counts: countModel(model) };
}

export interface DriftReport {
  drifted: boolean;
  snapshotRelease?: string;
  snapshotFingerprint?: string;
  liveFingerprint: string;
  snapshotCounts?: SnapshotManifest["counts"];
  liveCounts: ReturnType<typeof countModel>;
  /** Human-readable count deltas (live minus snapshot). */
  countDelta?: Record<string, number>;
}

/**
 * Compare the live Metabase fingerprint against a promoted/target snapshot's
 * fingerprint. `drifted: true` means the deployed context is stale relative to
 * live Metabase — a signal to rebuild before agents trust it.
 */
export async function checkDrift(config: AppConfig, snapshotRelease?: string): Promise<DriftReport> {
  const live = await computeLiveModel(config);
  let snapshotFingerprint: string | undefined;
  let snapshotCounts: SnapshotManifest["counts"] | undefined;
  let release = snapshotRelease;
  if (!release) {
    const curPath = currentPointerPath(config.snapshotDir);
    if (existsSync(curPath)) {
      release = (JSON.parse(await readFile(curPath, "utf8")) as CurrentPointer).release;
    }
  }
  if (release) {
    const manifest = await readManifest(config.snapshotDir, release).catch(() => undefined);
    snapshotFingerprint = manifest?.schemaFingerprint;
    snapshotCounts = manifest?.counts;
  }
  const countDelta = snapshotCounts
    ? {
        databases: live.counts.databases - snapshotCounts.databases,
        tables: live.counts.tables - snapshotCounts.tables,
        columns: live.counts.columns - snapshotCounts.columns,
        relationships: live.counts.relationships - snapshotCounts.relationships,
        assets: live.counts.assets - snapshotCounts.assets,
      }
    : undefined;
  return {
    drifted: snapshotFingerprint ? snapshotFingerprint !== live.fingerprint : true,
    snapshotRelease: release,
    snapshotFingerprint,
    liveFingerprint: live.fingerprint,
    snapshotCounts,
    liveCounts: live.counts,
    countDelta,
  };
}

export async function buildSnapshot(
  config: AppConfig,
  opts: BuildOptions,
  generatedAtIso: string,
): Promise<BuildResult> {
  const paths = snapshotPaths(config.snapshotDir, opts.release);
  if (existsSync(paths.root)) {
    if (!opts.force) {
      throw new SnapshotError(
        `Snapshot for release "${opts.release}" already exists at ${paths.root}. Use --force to overwrite.`,
      );
    }
    // Even with --force, never clobber an active snapshot: one that is published,
    // promoted to current, or referenced by the current pointer. Rebuilding it
    // would silently drop a live snapshot back to "built" status.
    await assertNotActive(config.snapshotDir, opts.release);
    logger.warn("overwriting existing (inactive) snapshot", { release: opts.release });
    await rm(paths.root, { recursive: true, force: true });
  }

  const client = new MetabaseClient({
    baseUrl: config.metabaseUrl,
    apiKey: config.metabaseApiKey,
    timeoutMs: config.queryTimeoutMs,
  });

  logger.info("verifying Metabase connectivity");
  await client.ping();

  const denylist = new Denylist(config.denylist);
  const semanticDefinitions = await loadSemanticDefinitions(config.semanticDefinitionsFile);

  logger.info("indexing database metadata");
  const metadataIndexer = new MetadataIndexer(client, denylist);
  const meta = await metadataIndexer.index(config.databaseIds);

  logger.info("indexing Metabase content");
  const contentIndexer = new ContentIndexer(client);
  const content = await contentIndexer.index(meta.tableIdToQualified, config.databaseIds);

  const model: NormalizedModel = {
    entities: meta.entities,
    relationships: meta.relationships,
    assets: content.assets,
  };
  validateSemanticDefinitions(semanticDefinitions, model);

  const fingerprint = computeSchemaFingerprint(model);
  const counts = countModel(model);

  const manifest: SnapshotManifest = {
    release: opts.release,
    gitCommit: opts.gitCommit,
    snapshot: opts.release,
    metabaseInstance: config.metabaseInstance,
    schemaFingerprint: fingerprint,
    generatedAt: generatedAtIso,
    status: "built",
    counts,
    builderVersion: BUILDER_VERSION,
  };

  // Write inspectable JSONL sources + manifest.
  await writeSnapshotFiles(config.snapshotDir, opts.release, model, manifest);
  await writeFile(paths.semantics, JSON.stringify(semanticDefinitions, null, 2) + "\n", "utf8");

  // Build the search index.
  const writer = new SnapshotWriter(paths.search);
  try {
    writer.write(model);
  } finally {
    writer.close();
  }

  // Diff against the previous snapshot for changes.json.
  let previousModel: NormalizedModel | undefined;
  if (opts.previousRelease && existsSync(snapshotPaths(config.snapshotDir, opts.previousRelease).manifest)) {
    previousModel = await readSnapshotModel(config.snapshotDir, opts.previousRelease);
  }
  const changes = diffModels(previousModel, model, opts.previousRelease);
  await writeChanges(config.snapshotDir, opts.release, changes);

  logger.info("snapshot build complete", {
    release: opts.release,
    fingerprint,
    ...counts,
  });

  return { manifest, model };
}
