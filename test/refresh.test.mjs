import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeNightlyReleaseId, pruneAutoSnapshots } from "../dist/refresh.js";

test("makeNightlyReleaseId is sortable UTC nightly id", () => {
  const id = makeNightlyReleaseId(new Date("2026-07-15T02:15:30.000Z"));
  assert.equal(id, "nightly-20260715-021530Z");
});

test("pruneAutoSnapshots keeps newest N and never deletes active", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ctxd-prune-"));
  try {
    for (const name of [
      "nightly-20260710-010000Z",
      "nightly-20260711-010000Z",
      "nightly-20260712-010000Z",
      "nightly-20260713-010000Z",
      "v1.0.0",
    ]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "manifest.json"), "{}");
    }
    await writeFile(
      path.join(root, "current.json"),
      JSON.stringify({ release: "nightly-20260713-010000Z", snapshot: "x", schemaFingerprint: "a", promotedAt: "t" }),
    );
    const pruned = await pruneAutoSnapshots(root, 2, "nightly-20260713-010000Z");
    assert.ok(pruned.includes("nightly-20260710-010000Z"));
    assert.ok(pruned.includes("nightly-20260711-010000Z"));
    assert.equal(pruned.includes("nightly-20260713-010000Z"), false);
    assert.equal(pruned.includes("v1.0.0"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
