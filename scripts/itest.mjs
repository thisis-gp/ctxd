// Ad-hoc integration test of the read path (no live Metabase required).
// Builds a snapshot from a fabricated model, promotes it, then exercises search,
// entity context, relationships, freshness, and SQL validation.
import { SnapshotWriter } from "../dist/snapshot/store.js";
import { writeSnapshotFiles, writeChanges, diffModels } from "../dist/snapshot/manifest.js";
import { computeSchemaFingerprint } from "../dist/snapshot/fingerprint.js";
import { snapshotPaths } from "../dist/snapshot/paths.js";
import { ReleaseManager } from "../dist/release/manager.js";
import { ContextService } from "../dist/context-service.js";
import { rm as rmrf } from "node:fs/promises";
import { writeFile } from "node:fs/promises";

const dir = "./.itest/snapshots";
const release = "v1.0.0-0";
await rmrf("./.itest", { recursive: true, force: true });

const model = {
  entities: [
    { id: "database:1", kind: "database", name: "appdb", qualifiedName: "appdb", databaseId: 1, databaseName: "appdb" },
    { id: "table:public.users", kind: "table", name: "users", qualifiedName: "public.users", description: "Application users", databaseId: 1, databaseName: "appdb", schema: "public", columnCount: 2 },
    { id: "column:public.users.id", kind: "column", name: "id", qualifiedName: "public.users.id", databaseId: 1, databaseName: "appdb", schema: "public", table: "public.users", dataType: "int8" },
    { id: "column:public.users.email", kind: "column", name: "email", qualifiedName: "public.users.email", databaseId: 1, databaseName: "appdb", schema: "public", table: "public.users", dataType: "varchar", semanticType: "type/Email" },
    { id: "table:public.orders", kind: "table", name: "orders", qualifiedName: "public.orders", description: "Customer orders", databaseId: 1, databaseName: "appdb", schema: "public", columnCount: 2 },
    { id: "column:public.orders.id", kind: "column", name: "id", qualifiedName: "public.orders.id", databaseId: 1, databaseName: "appdb", schema: "public", table: "public.orders", dataType: "int8" },
    { id: "column:public.orders.user_id", kind: "column", name: "user_id", qualifiedName: "public.orders.user_id", databaseId: 1, databaseName: "appdb", schema: "public", table: "public.orders", dataType: "int8", semanticType: "type/FK" },
  ],
  relationships: [
    { id: "fk:public.orders.user_id->public.users.id", kind: "fk", fromTable: "public.orders", fromColumn: "user_id", toTable: "public.users", toColumn: "id", databaseId: 1 },
  ],
  assets: [
    { id: "question:42", kind: "question", metabaseId: 42, name: "Active users by month", description: "MAU trend", queryType: "native", nativeSql: "SELECT count(*) FROM public.users", databaseId: 1, tableRefs: ["public.users"], url: "/question/42" },
  ],
};

const fp = computeSchemaFingerprint(model);
const manifest = {
  release, gitCommit: "abc123", snapshot: release, metabaseInstance: "test",
  schemaFingerprint: fp, generatedAt: new Date().toISOString(), status: "built",
  counts: { databases: 1, tables: 2, columns: 4, relationships: 1, assets: 1 }, builderVersion: "0.1.0",
};

await writeSnapshotFiles(dir, release, model, manifest);
await writeFile(snapshotPaths(dir, release).semantics, "[]\n", "utf8");
const w = new SnapshotWriter(snapshotPaths(dir, release).search);
w.write(model);
w.close();
await writeChanges(dir, release, diffModels(undefined, model));

const relmgr = new ReleaseManager(dir);
const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } else console.log("PASS:", msg); };

const report = await relmgr.validate(release);
assert(report.ok, "snapshot validates");
await relmgr.publish(release);
const ptr = await relmgr.promote(release);
assert(ptr.release === release, "promote sets current pointer");

const svc = new ContextService({ snapshotDir: dir, queryRowLimit: 1000, queryTimeoutMs: 15000 });
await svc.open();
assert(svc.search("users").tables.some((t) => t.qualifiedName === "public.users"), "search finds users table");
assert(svc.search("active month").assets.some((a) => a.metabaseId === 42), "search finds saved question");
// Compact-search: hits must be lean (no id/databaseId/schema noise) but keep qualifiedName.
const tHit = svc.search("users").tables.find((t) => t.qualifiedName === "public.users");
assert(tHit && tHit.id === undefined && tHit.databaseId === undefined && tHit.databaseName === undefined, "search table hits are lean (no id/databaseId)");
const cHit = svc.search("email", { scope: "columns" }).columns[0];
assert(cHit && cHit.qualifiedName && cHit.id === undefined && cHit.databaseId === undefined, "search column hits are lean but keep qualifiedName");
const orders = svc.getEntity("public.orders");
assert(orders.columns.length === 2, "orders has 2 columns");
assert(orders.relationships.length === 1, "orders has 1 fk relationship");
const users = svc.getEntity("public.users");
assert(users.savedQuestions.some((a) => a.metabaseId === 42), "users surfaces referencing saved question");
const jp = svc.getJoinPath("public.orders", "public.users");
assert(jp.path && jp.hops === 1, "join-path orders->users is 1 hop");
const plan = svc.planQuery("orders by user");
assert(plan.joinPaths.some((j) => j.joins.length === 1 && j.joins[0].toTable === "public.users"), "plan_query returns orders->users join path in one call");
const jpSame = svc.getJoinPath("public.orders", "public.orders");
assert(jpSame.path && jpSame.hops === 0, "join-path to self is 0 hops");
const jpNone = svc.getJoinPath("public.users", "public.orders");
assert(jpNone.path && jpNone.hops === 1, "join-path is undirected (users->orders also 1 hop)");
const fr = await svc.freshness();
assert(fr.hasCurrent && fr.release === release && fr.schemaFingerprint === fp, "freshness reports current + fingerprint");
assert(svc.validateSql("delete from users").ok === false, "validateSql rejects delete");
assert(svc.getEntity("public.users").source.release === release, "responses stamp source release");
svc.close();

let metabaseCalls = 0;
const guarded = new ContextService({
  snapshotDir: dir,
  queryRowLimit: 1000,
  queryTimeoutMs: 15000,
  metabaseClient: { runNativeQuery: async () => { metabaseCalls++; return { data: { rows: [], cols: [] }, row_count: 0 }; } },
  allowedDatabaseIds: [1],
});
await guarded.open();
try {
  await guarded.runReadonlyQuery("SELECT organization_name FROM public.accounts");
  console.error("FAIL: unknown schema references should be rejected");
  process.exit(1);
} catch (err) {
  assert(err.code === "SCHEMA_REFERENCE_ERROR", "unknown schema references rejected before Metabase");
}
assert(metabaseCalls === 0, "invalid schema query never reached Metabase");
guarded.close();

// Rollback should fail cleanly when there is no previous pointer.
try {
  await relmgr.rollback();
  console.error("FAIL: rollback should have thrown with no previous pointer");
  process.exit(1);
} catch {
  console.log("PASS: rollback with no previous pointer throws NotFound");
}

await rmrf("./.itest", { recursive: true, force: true });
console.log("\nALL READ-PATH CHECKS OK");
