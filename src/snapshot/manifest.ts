/**
 * Manifest + JSONL + changes I/O for a snapshot directory (§7.4).
 *
 * JSONL files hold inspectable source records; manifest.json holds the release
 * fingerprint and roll-up counts. changes.json diffs against the previous
 * snapshot so releases can be reviewed and drift can be detected.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SnapshotError } from "../errors.js";
import type { Asset, Entity, NormalizedModel, Relationship } from "../model.js";
import { snapshotPaths } from "./paths.js";
import type { SnapshotChanges, SnapshotManifest } from "./types.js";

async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  await writeFile(file, body, "utf8");
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

/** Write manifest + all JSONL source records into a snapshot directory. */
export async function writeSnapshotFiles(
  snapshotDir: string,
  release: string,
  model: NormalizedModel,
  manifest: SnapshotManifest,
): Promise<void> {
  const p = snapshotPaths(snapshotDir, release);
  await mkdir(p.root, { recursive: true });
  await writeJsonl(p.entities, model.entities);
  await writeJsonl(p.relationships, model.relationships);
  await writeJsonl(p.assets, model.assets);
  await writeManifest(snapshotDir, release, manifest);
}

export async function writeManifest(
  snapshotDir: string,
  release: string,
  manifest: SnapshotManifest,
): Promise<void> {
  const p = snapshotPaths(snapshotDir, release);
  await mkdir(p.root, { recursive: true });
  await writeFile(p.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export async function readManifest(
  snapshotDir: string,
  release: string,
): Promise<SnapshotManifest> {
  const p = snapshotPaths(snapshotDir, release);
  if (!existsSync(p.manifest)) {
    throw new SnapshotError(`No manifest found for release "${release}" at ${p.manifest}`);
  }
  return JSON.parse(await readFile(p.manifest, "utf8")) as SnapshotManifest;
}

export async function readSnapshotModel(
  snapshotDir: string,
  release: string,
): Promise<NormalizedModel> {
  const p = snapshotPaths(snapshotDir, release);
  return {
    entities: await readJsonl<Entity>(p.entities),
    relationships: await readJsonl<Relationship>(p.relationships),
    assets: await readJsonl<Asset>(p.assets),
  };
}

/** Compute a set diff of ids between the new model and a previous release's model. */
export function diffModels(
  previous: NormalizedModel | undefined,
  next: NormalizedModel,
  previousRelease?: string,
): SnapshotChanges {
  const prevE = new Set(previous?.entities.map((e) => e.id) ?? []);
  const nextE = new Set(next.entities.map((e) => e.id));
  const prevR = new Set(previous?.relationships.map((r) => r.id) ?? []);
  const nextR = new Set(next.relationships.map((r) => r.id));
  const prevA = new Set(previous?.assets.map((a) => a.id) ?? []);
  const nextA = new Set(next.assets.map((a) => a.id));

  const diff = (prev: Set<string>, cur: Set<string>) => ({
    added: [...cur].filter((x) => !prev.has(x)),
    removed: [...prev].filter((x) => !cur.has(x)),
  });
  const e = diff(prevE, nextE);
  const r = diff(prevR, nextR);
  const a = diff(prevA, nextA);
  return {
    previousRelease,
    addedEntities: e.added,
    removedEntities: e.removed,
    addedRelationships: r.added,
    removedRelationships: r.removed,
    addedAssets: a.added,
    removedAssets: a.removed,
  };
}

export async function writeChanges(
  snapshotDir: string,
  release: string,
  changes: SnapshotChanges,
): Promise<void> {
  const p = snapshotPaths(snapshotDir, release);
  await mkdir(p.root, { recursive: true });
  await writeFile(p.changes, JSON.stringify(changes, null, 2) + "\n", "utf8");
}

export function snapshotDirFor(snapshotDir: string, release: string): string {
  return path.join(snapshotDir, release);
}
