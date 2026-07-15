/**
 * Nightly / auto refresh — ingest live Metabase without a manual release ceremony.
 *
 * Under the hood we still write an immutable snapshot + fingerprint and keep
 * `previous.json` for rollback. Operators only run `ctxd refresh` (or cron).
 */

import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { ReleaseManager } from "./release/manager.js";
import { buildSnapshot, checkDrift } from "./snapshot/builder.js";
import { currentPointerPath } from "./snapshot/paths.js";
import type { CurrentPointer, SnapshotManifest } from "./snapshot/types.js";

export interface RefreshOptions {
  /** Override auto-generated release id (default: nightly-YYYYMMDD-HHMMSSZ). */
  release?: string;
  /** Promote even when live fingerprint matches current (default: false = skip). */
  force?: boolean;
  /** Allow fewer tables than previous (default true for nightly; Metabase can shrink). */
  allowShrink?: boolean;
  /** Keep only the newest N auto/`nightly-*` snapshots after success (0 = keep all). */
  pruneKeep?: number;
  contractFile?: string;
}

export interface RefreshResult {
  skipped: boolean;
  reason?: string;
  release?: string;
  previousRelease?: string;
  manifest?: SnapshotManifest;
  current?: CurrentPointer;
  pruned?: string[];
}

/** UTC release id suitable for cron: nightly-20260715-033015Z */
export function makeNightlyReleaseId(now = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  // 20260715T033015Z -> nightly-20260715-033015Z
  return `nightly-${iso.slice(0, 8)}-${iso.slice(9)}`;
}

function isAutoRelease(name: string): boolean {
  return /^(nightly|auto)-/.test(name);
}

/**
 * Build → validate → publish → promote from live Metabase.
 * Skips when current fingerprint already matches live (unless force).
 */
export async function refreshFromMetabase(
  config: AppConfig,
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const manager = new ReleaseManager(config.snapshotDir);
  const current = await manager.getCurrent();
  const previousRelease = current?.release;

  if (!opts.force) {
    const drift = await checkDrift(config, previousRelease);
    if (!drift.drifted && previousRelease) {
      logger.info("refresh skipped — live Metabase matches current snapshot", {
        release: previousRelease,
        fingerprint: drift.liveFingerprint,
      });
      return {
        skipped: true,
        reason: "Live Metabase fingerprint matches current snapshot.",
        release: previousRelease,
        previousRelease,
      };
    }
  }

  const release = opts.release ?? makeNightlyReleaseId();
  const generatedAt = new Date().toISOString();

  logger.info("refresh: building snapshot from live Metabase", { release, previousRelease });
  const { manifest } = await buildSnapshot(
    config,
    {
      release,
      previousRelease,
      force: true,
      gitCommit: process.env.GIT_COMMIT || undefined,
    },
    generatedAt,
  );

  const report = await manager.validate(release, {
    previousRelease,
    allowShrink: opts.allowShrink !== false,
    contractFile: opts.contractFile,
  });
  if (!report.ok) {
    return {
      skipped: false,
      release,
      previousRelease,
      manifest,
      reason: report.problems.join("; "),
    };
  }

  await manager.publish(release);
  const pointer = await manager.promote(release);

  const pruned =
    opts.pruneKeep && opts.pruneKeep > 0
      ? await pruneAutoSnapshots(config.snapshotDir, opts.pruneKeep, pointer.release)
      : [];

  logger.info("refresh complete", { release, fingerprint: pointer.schemaFingerprint, pruned: pruned.length });
  return {
    skipped: false,
    release,
    previousRelease,
    manifest,
    current: pointer,
    pruned,
  };
}

/**
 * Delete older nightly/auto snapshot dirs, keeping the newest `keep` plus the
 * active release (even if it is not auto-named).
 */
export async function pruneAutoSnapshots(
  snapshotDir: string,
  keep: number,
  activeRelease: string,
): Promise<string[]> {
  if (keep < 1) return [];
  const entries = await readdir(snapshotDir, { withFileTypes: true });
  const autos = entries
    .filter((e) => e.isDirectory() && isAutoRelease(e.name))
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first (timestamp in name)

  const pruned: string[] = [];
  let kept = 0;
  for (const name of autos) {
    if (name === activeRelease) {
      kept += 1;
      continue;
    }
    if (kept < keep) {
      kept += 1;
      continue;
    }
    const root = path.join(snapshotDir, name);
    // Never delete whatever current.json points at.
    const curPath = currentPointerPath(snapshotDir);
    if (existsSync(curPath)) {
      const cur = JSON.parse(await readFile(curPath, "utf8")) as CurrentPointer;
      if (cur.release === name) continue;
    }
    await rm(root, { recursive: true, force: true });
    pruned.push(name);
    logger.info("pruned old auto snapshot", { release: name });
  }
  return pruned;
}
