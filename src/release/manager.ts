/**
 * Release manifest manager (§7.5, §8).
 *
 * Records which snapshot belongs to which release and owns the `current` pointer
 * lifecycle: validate -> publish -> promote, plus rollback. The current pointer
 * is only advanced after a snapshot is validated (and, in the release pipeline,
 * after deploy health checks), and rollback restores the previous pointer.
 */

import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { NotFoundError, SnapshotError } from "../errors.js";
import { logger } from "../logger.js";
import { readManifest, readSnapshotModel, writeManifest } from "../snapshot/manifest.js";
import { currentPointerPath, snapshotPaths } from "../snapshot/paths.js";
import { SnapshotReader } from "../snapshot/store.js";
import type { CurrentPointer, SnapshotManifest } from "../snapshot/types.js";
import { parseSemanticDefinitions } from "../semantic.js";
import { loadContextContract, validateContextContract } from "../contract.js";

function previousPointerPath(snapshotDir: string): string {
  return path.join(snapshotDir, "previous.json");
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(tempPath, contents, "utf8");
    try {
      await rename(tempPath, filePath);
    } catch (err) {
      // Windows does not replace an existing destination with rename().
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw err;
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

export interface ValidationReport {
  ok: boolean;
  release: string;
  problems: string[];
  counts: SnapshotManifest["counts"];
}

export class ReleaseManager {
  constructor(private readonly snapshotDir: string) {}

  /**
   * Validate a built snapshot before it can be published/promoted (§8).
   * Fails when the search DB cannot open, the snapshot is empty, or it is
   * materially smaller than the previous snapshot without an override.
   */
  async validate(
    release: string,
    opts: { previousRelease?: string; allowShrink?: boolean; shrinkThreshold?: number; contractFile?: string } = {},
  ): Promise<ValidationReport> {
    const manifest = await readManifest(this.snapshotDir, release);
    const paths = snapshotPaths(this.snapshotDir, release);
    const problems: string[] = [];

    // 1. Search index must open and expose expected tables.
    if (!existsSync(paths.search)) {
      problems.push(`search.sqlite missing at ${paths.search}`);
    } else {
      try {
        const reader = new SnapshotReader(paths.search);
        try {
          if (!reader.healthCheck()) problems.push("search.sqlite missing expected tables");
          const c = reader.counts();
          if (c.entities === 0) problems.push("snapshot contains zero entities");
        } finally {
          reader.close();
        }
      } catch (err) {
        problems.push(`cannot open search.sqlite: ${(err as Error).message}`);
      }
    }

    // 2. Non-empty metadata.
    if (manifest.counts.tables === 0) problems.push("snapshot contains zero tables");

    // 3. Semantic definitions are part of the release contract.
    if (!existsSync(paths.semantics)) {
      problems.push(`semantic-definitions.json missing at ${paths.semantics}`);
    } else {
      try {
        parseSemanticDefinitions(JSON.parse(await readFile(paths.semantics, "utf8")));
      } catch (err) {
        problems.push(`invalid semantic definitions: ${(err as Error).message}`);
      }
    }

    // 4. Optional vendor-neutral contract must match this release's physical model.
    if (opts.contractFile && existsSync(opts.contractFile)) {
      try {
        const contract = await loadContextContract(opts.contractFile);
        const contractReport = validateContextContract(contract, await readSnapshotModel(this.snapshotDir, release));
        problems.push(...contractReport.problems.map((problem) => `context contract: ${problem}`));
      } catch (err) {
        problems.push(`invalid context contract: ${(err as Error).message}`);
      }
    }

    // 5. Not materially smaller than the previous snapshot.
    if (opts.previousRelease && !opts.allowShrink) {
      const prevManifestPath = snapshotPaths(this.snapshotDir, opts.previousRelease).manifest;
      if (existsSync(prevManifestPath)) {
        const prev = await readManifest(this.snapshotDir, opts.previousRelease);
        const threshold = opts.shrinkThreshold ?? 0.5;
        if (
          prev.counts.tables > 0 &&
          manifest.counts.tables < prev.counts.tables * threshold
        ) {
          problems.push(
            `snapshot has ${manifest.counts.tables} tables vs previous ${prev.counts.tables} ` +
              `(< ${threshold * 100}% of previous); pass --allow-shrink to override`,
          );
        }
      }
    }

    const ok = problems.length === 0;
    if (ok) {
      await writeManifest(this.snapshotDir, release, { ...manifest, status: "validated" });
      logger.info("snapshot validated", { release });
    } else {
      logger.warn("snapshot validation failed", { release, problems });
    }
    return { ok, release, problems, counts: manifest.counts };
  }

  /** Mark a validated snapshot as published (immutable, ready to promote). */
  async publish(release: string): Promise<void> {
    const manifest = await readManifest(this.snapshotDir, release);
    if (manifest.status === "built") {
      throw new SnapshotError(`Release "${release}" must be validated before publishing.`);
    }
    await writeManifest(this.snapshotDir, release, { ...manifest, status: "published" });
    logger.info("snapshot published", { release });
  }

  /**
   * Promote a published snapshot to `current`. The prior pointer is backed up to
   * previous.json so {@link rollback} can restore it. Should be called only after
   * deploy + health checks succeed in the release pipeline (§8).
   */
  async promote(release: string): Promise<CurrentPointer> {
    const manifest = await readManifest(this.snapshotDir, release);
    if (manifest.status !== "validated" && manifest.status !== "published") {
      throw new SnapshotError(
        `Release "${release}" has status "${manifest.status}"; validate/publish before promoting.`,
      );
    }
    const curPath = currentPointerPath(this.snapshotDir);
    // Back up the existing pointer for rollback.
    if (existsSync(curPath)) {
      await writeAtomic(
        previousPointerPath(this.snapshotDir),
        await readFile(curPath, "utf8"),
      );
    }
    const pointer: CurrentPointer = {
      release,
      snapshot: manifest.snapshot,
      schemaFingerprint: manifest.schemaFingerprint,
      promotedAt: manifest.generatedAt,
      gitCommit: manifest.gitCommit,
    };
    await writeAtomic(curPath, JSON.stringify(pointer, null, 2) + "\n");
    // The pointer is the activation record. Keep the manifest immutable after
    // validation/publication so a partial failure cannot disagree with it.
    logger.info("snapshot promoted to current", { release });
    return pointer;
  }

  /** Restore the previously-current pointer (§8 rollback). */
  async rollback(): Promise<CurrentPointer> {
    const prevPath = previousPointerPath(this.snapshotDir);
    if (!existsSync(prevPath)) {
      throw new NotFoundError("No previous pointer to roll back to.");
    }
    const curPath = currentPointerPath(this.snapshotDir);
    await writeAtomic(curPath, await readFile(prevPath, "utf8"));
    await rm(prevPath, { force: true });
    const pointer = JSON.parse(await readFile(curPath, "utf8")) as CurrentPointer;
    logger.info("rolled back current pointer", { release: pointer.release });
    return pointer;
  }

  /** Read the current pointer, or undefined if nothing is promoted yet. */
  async getCurrent(): Promise<CurrentPointer | undefined> {
    const curPath = currentPointerPath(this.snapshotDir);
    if (!existsSync(curPath)) return undefined;
    return JSON.parse(await readFile(curPath, "utf8")) as CurrentPointer;
  }
}
