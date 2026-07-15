/**
 * Deterministic schema fingerprinting (FR-4, FR-5, §12 "deterministic builds").
 *
 * The fingerprint is a sha256 over a *canonical* serialization of the normalized
 * model: entities and relationships sorted by id, with only structure-defining
 * fields included (names, types, relationships) — NOT volatile fields like
 * descriptions or timestamps. Two runs against identical schema metadata must
 * produce the same fingerprint, which is what lets us detect real schema drift
 * and dedupe snapshots.
 */

import { createHash } from "node:crypto";
import type { NormalizedModel } from "../model.js";

function canonicalEntities(model: NormalizedModel): unknown[] {
  return model.entities
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      qualifiedName: e.qualifiedName,
      dataType: e.dataType ?? null,
      semanticType: e.semanticType ?? null,
    }));
}

function canonicalRelationships(model: NormalizedModel): unknown[] {
  return model.relationships
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => ({
      id: r.id,
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
    }));
}

/** Compute the `sha256:...` schema fingerprint for a normalized model. */
export function computeSchemaFingerprint(model: NormalizedModel): string {
  const canonical = JSON.stringify({
    entities: canonicalEntities(model),
    relationships: canonicalRelationships(model),
  });
  const hash = createHash("sha256").update(canonical).digest("hex");
  return `sha256:${hash}`;
}
