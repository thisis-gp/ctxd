/**
 * Filesystem layout helpers for snapshots and the `current` pointer.
 *
 * Layout (§9):
 *   <snapshotDir>/
 *     current.json                 -> pointer to the promoted release
 *     <release>/
 *       manifest.json
 *       entities.jsonl
 *       relationships.jsonl
 *       metabase-assets.jsonl
 *       search.sqlite
 *       changes.json
 */

import path from "node:path";

export interface SnapshotPaths {
  root: string;
  manifest: string;
  entities: string;
  relationships: string;
  assets: string;
  search: string;
  changes: string;
  semantics: string;
}

export function snapshotPaths(snapshotDir: string, release: string): SnapshotPaths {
  const root = path.join(snapshotDir, release);
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    entities: path.join(root, "entities.jsonl"),
    relationships: path.join(root, "relationships.jsonl"),
    assets: path.join(root, "metabase-assets.jsonl"),
    search: path.join(root, "search.sqlite"),
    changes: path.join(root, "changes.json"),
    semantics: path.join(root, "semantic-definitions.json"),
  };
}

export function currentPointerPath(snapshotDir: string): string {
  return path.join(snapshotDir, "current.json");
}
