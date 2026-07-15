/**
 * Snapshot + release manifest types (§7.4, §7.5).
 */

export type SnapshotStatus = "built" | "validated" | "published" | "current";

/** The manifest.json that sits at the root of every snapshot directory. */
export interface SnapshotManifest {
  /** Release tag or commit this snapshot represents, e.g. "v8.19.0-0". */
  release: string;
  /** Git commit the snapshot was generated at, if known. */
  gitCommit?: string;
  /** Directory name of the snapshot (usually === release). */
  snapshot: string;
  /** Which Metabase instance the data came from. */
  metabaseInstance: string;
  /** sha256 fingerprint of the normalized metadata (FR-5). */
  schemaFingerprint: string;
  /** ISO timestamp of generation. */
  generatedAt: string;
  status: SnapshotStatus;
  /** Roll-up counts, cheap to surface to agents. */
  counts: {
    databases: number;
    tables: number;
    columns: number;
    relationships: number;
    assets: number;
  };
  /** Tool version that produced the snapshot. */
  builderVersion: string;
}

/** The tiny `current.json` pointer file that names the promoted snapshot (§9). */
export interface CurrentPointer {
  release: string;
  snapshot: string;
  schemaFingerprint: string;
  promotedAt: string;
  gitCommit?: string;
}

/** changes.json — diff vs the previous snapshot (§7.4, Phase 5). */
export interface SnapshotChanges {
  previousRelease?: string;
  addedEntities: string[];
  removedEntities: string[];
  addedRelationships: string[];
  removedRelationships: string[];
  addedAssets: string[];
  removedAssets: string[];
}
