#!/usr/bin/env node
// Generic OSS eval fixture: no private database, SSH host, or company schema.

import { rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { SnapshotWriter } from "../dist/snapshot/store.js";
import { writeSnapshotFiles, writeChanges, diffModels } from "../dist/snapshot/manifest.js";
import { computeSchemaFingerprint } from "../dist/snapshot/fingerprint.js";
import { snapshotPaths } from "../dist/snapshot/paths.js";
import { ReleaseManager } from "../dist/release/manager.js";
import { ContextService } from "../dist/context-service.js";

const dir = "./.generic-eval/snapshots";
const release = "generic-eval-1";

function table(name, description, columnCount) {
  return {
    id: `table:public.${name}`,
    kind: "table",
    name,
    qualifiedName: `public.${name}`,
    description,
    databaseId: 1,
    databaseName: "app",
    schema: "public",
    columnCount,
  };
}

function column(tableName, name, dataType, semanticType) {
  return {
    id: `column:public.${tableName}.${name}`,
    kind: "column",
    name,
    qualifiedName: `public.${tableName}.${name}`,
    databaseId: 1,
    databaseName: "app",
    schema: "public",
    table: `public.${tableName}`,
    dataType,
    ...(semanticType ? { semanticType } : {}),
  };
}

function fk(fromTable, fromColumn, toTable, toColumn = "id") {
  return {
    id: `fk:public.${fromTable}.${fromColumn}->public.${toTable}.${toColumn}`,
    kind: "fk",
    fromTable: `public.${fromTable}`,
    fromColumn,
    toTable: `public.${toTable}`,
    toColumn,
    databaseId: 1,
  };
}

const model = {
  entities: [
    { id: "database:1", kind: "database", name: "app", qualifiedName: "app", databaseId: 1, databaseName: "app" },
    table("customers", "Customers and accounts using the product", 4),
    column("customers", "id", "int8"),
    column("customers", "name", "varchar"),
    column("customers", "email", "varchar", "type/Email"),
    column("customers", "created_at", "timestamptz"),
    table("orders", "Customer ecommerce orders", 6),
    column("orders", "id", "int8"),
    column("orders", "customer_id", "int8", "type/FK"),
    column("orders", "status", "varchar"),
    column("orders", "total_amount", "numeric"),
    column("orders", "created_at", "timestamptz"),
    column("orders", "refunded_at", "timestamptz"),
    table("tickets", "Support tickets raised by customers", 7),
    column("tickets", "id", "int8"),
    column("tickets", "customer_id", "int8", "type/FK"),
    column("tickets", "status", "varchar"),
    column("tickets", "priority", "varchar"),
    column("tickets", "created_at", "timestamptz"),
    column("tickets", "csat", "jsonb", "type/SerializedJSON"),
    column("tickets", "assignee_id", "int8"),
    table("ticket_history", "Historical changes for support tickets", 5),
    column("ticket_history", "id", "int8"),
    column("ticket_history", "ticket_id", "int8", "type/FK"),
    column("ticket_history", "old_status", "varchar"),
    column("ticket_history", "new_status", "varchar"),
    column("ticket_history", "created_at", "timestamptz"),
    table("staged_orders", "Raw staged order import rows", 4),
    column("staged_orders", "id", "int8"),
    column("staged_orders", "payload", "jsonb"),
    column("staged_orders", "status", "varchar"),
    column("staged_orders", "created_at", "timestamptz"),
    table("products", "Product catalog", 3),
    column("products", "id", "int8"),
    column("products", "name", "varchar"),
    column("products", "category", "varchar"),
  ],
  relationships: [
    fk("orders", "customer_id", "customers"),
    fk("tickets", "customer_id", "customers"),
    fk("ticket_history", "ticket_id", "tickets"),
  ],
  assets: [
    {
      id: "question:101",
      kind: "question",
      metabaseId: 101,
      name: "Monthly order count",
      description: "Orders grouped by created month",
      queryType: "native",
      nativeSql: "SELECT date_trunc('month', created_at), count(*) FROM public.orders GROUP BY 1",
      databaseId: 1,
      tableRefs: ["public.orders"],
      url: "/question/101",
    },
  ],
};

const semantics = [
  {
    id: "tickets.count",
    name: "ticket count",
    synonyms: ["tickets", "support tickets", "how many tickets", "total tickets"],
    description: "Count support tickets.",
    table: "public.tickets",
    columns: [],
    definition: "COUNT(*) over public.tickets.",
    sqlTemplate: "SELECT COUNT(*) AS ticket_count FROM public.tickets;",
    measureExpression: "COUNT(*)",
    dimensions: {
      status: { name: "Ticket status", expression: "status", synonyms: ["status", "ticket status"] },
      priority: { name: "Ticket priority", expression: "priority", synonyms: ["priority", "severity"] },
      created_month: { name: "Created month", expression: "DATE_TRUNC('month', created_at)::date", synonyms: ["created month", "month"] },
    },
    databaseName: "app",
  },
  {
    id: "tickets.csat_responses",
    name: "CSAT responses",
    synonyms: ["CSAT", "customer satisfaction", "survey responses"],
    description: "Tickets with a non-empty CSAT response.",
    table: "public.tickets",
    columns: ["public.tickets.csat"],
    definition: "CSAT response is present when rating or feedback is populated.",
    sqlTemplate: "SELECT COUNT(*) AS csat_response_count FROM public.tickets WHERE csat IS NOT NULL AND csat <> '{}'::jsonb;",
    measureExpression: "COUNT(*)",
    defaultFilter: "csat IS NOT NULL AND csat <> '{}'::jsonb",
    dimensions: {
      status: { name: "Ticket status", expression: "status", synonyms: ["status", "ticket status"] },
      priority: { name: "Ticket priority", expression: "priority", synonyms: ["priority", "severity"] },
    },
    databaseName: "app",
  },
  {
    id: "orders.count",
    name: "order count",
    synonyms: ["orders", "how many orders", "total orders"],
    description: "Count customer orders.",
    table: "public.orders",
    columns: [],
    definition: "COUNT(*) over public.orders.",
    sqlTemplate: "SELECT COUNT(*) AS order_count FROM public.orders;",
    measureExpression: "COUNT(*)",
    dimensions: {
      status: { name: "Order status", expression: "status", synonyms: ["status", "order status"] },
      created_month: { name: "Created month", expression: "DATE_TRUNC('month', created_at)::date", synonyms: ["created month", "month"] },
    },
    databaseName: "app",
  },
];

const cases = [
  { name: "ticket count", question: "How many support tickets are there?", top: "public.tickets", intent: "metric_only", confidence: "high", semantic: true, measures: ["tickets.count"] },
  { name: "tickets by status", question: "Tickets by status", top: "public.tickets", intent: "metric_by_dimension", confidence: "high", semantic: true, measures: ["tickets.count"], dimensions: ["status"] },
  { name: "tickets by priority", question: "Support tickets by priority", top: "public.tickets", intent: "metric_by_dimension", confidence: "high", semantic: true, dimensions: ["priority"] },
  { name: "csat count", question: "How many CSAT responses did we receive?", top: "public.tickets", intent: "metric_only", confidence: "high", semantic: true, measures: ["tickets.csat_responses"] },
  { name: "csat by status", question: "CSAT responses by ticket status", top: "public.tickets", intent: "metric_by_dimension", confidence: "high", semantic: true, dimensions: ["status"] },
  { name: "order count", question: "How many orders are there?", top: "public.orders", intent: "metric_only", confidence: "high", semantic: true, measures: ["orders.count"] },
  { name: "orders by month", question: "Orders created by month", top: "public.orders", intent: "metric_by_dimension", confidence: "high", semantic: true, dimensions: ["created_month"] },
  { name: "ticket history", question: "Show ticket status history", top: "public.ticket_history", intent: "lookup", semantic: false },
  { name: "staged orders", question: "Show staged order import rows", top: "public.staged_orders", intent: "lookup", semantic: false },
  { name: "join exploration", question: "How do orders join to customers?", top: "public.orders", intent: "join_exploration", semantic: false },
  { name: "customer lookup", question: "Find customer records", top: "public.customers", intent: "lookup", semantic: false },
  { name: "product lookup", question: "Find product catalog records", top: "public.products", intent: "lookup", semantic: false },
  { name: "definition", question: "What does CSAT response mean?", top: "public.tickets", intent: "definition", semantic: false },
];

function assertCase(test, plan) {
  const failures = [];
  const top = plan.rankedTables[0]?.item.qualifiedName ?? null;
  if (test.top && top !== test.top) failures.push(`top=${top}, expected ${test.top}`);
  if (test.intent && plan.intent !== test.intent) failures.push(`intent=${plan.intent}, expected ${test.intent}`);
  if (test.confidence && plan.confidence !== test.confidence) failures.push(`confidence=${plan.confidence}, expected ${test.confidence}`);
  if (test.semantic === true && !plan.suggestedSemanticQuery) failures.push("expected suggested semantic query");
  if (test.semantic === false && plan.suggestedSemanticQuery) failures.push("did not expect suggested semantic query");
  for (const measure of test.measures ?? []) {
    if (!plan.suggestedSemanticQuery?.measures?.includes(measure)) failures.push(`missing measure ${measure}`);
  }
  for (const dimension of test.dimensions ?? []) {
    if (!plan.suggestedSemanticQuery?.dimensions?.includes(dimension)) failures.push(`missing dimension ${dimension}`);
  }
  return { top, failures };
}

await rm("./.generic-eval", { recursive: true, force: true });
const fp = computeSchemaFingerprint(model);
const manifest = {
  release,
  gitCommit: "generic",
  snapshot: release,
  metabaseInstance: "generic",
  schemaFingerprint: fp,
  generatedAt: new Date().toISOString(),
  status: "built",
  counts: { databases: 1, tables: 6, columns: model.entities.filter((e) => e.kind === "column").length, relationships: model.relationships.length, assets: model.assets.length },
  builderVersion: "0.1.0",
};
await writeSnapshotFiles(dir, release, model, manifest);
await writeFile(snapshotPaths(dir, release).semantics, JSON.stringify(semantics, null, 2) + "\n", "utf8");
const writer = new SnapshotWriter(snapshotPaths(dir, release).search);
writer.write(model);
writer.close();
await writeChanges(dir, release, diffModels(undefined, model));

const releaseManager = new ReleaseManager(dir);
const report = await releaseManager.validate(release);
if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
await releaseManager.publish(release);
await releaseManager.promote(release);

const service = new ContextService({ snapshotDir: dir, queryRowLimit: 1000, queryTimeoutMs: 15000 });
await service.open();
const rows = [];
for (const test of cases) {
  const start = performance.now();
  const plan = service.planQuery(test.question, 6);
  const ms = +(performance.now() - start).toFixed(2);
  const { top, failures } = assertCase(test, plan);
  if (plan.suggestedSemanticQuery) service.compileSemanticQuery(plan.suggestedSemanticQuery);
  rows.push({ name: test.name, pass: failures.length === 0, failures, ms, intent: plan.intent, confidence: plan.confidence, top, suggestedSemanticQuery: plan.suggestedSemanticQuery ?? null });
}
service.close();

const sortedMs = rows.map((row) => row.ms).sort((a, b) => a - b);
const summary = {
  total: rows.length,
  passed: rows.filter((row) => row.pass).length,
  failed: rows.filter((row) => !row.pass).length,
  avgMs: +(rows.reduce((sum, row) => sum + row.ms, 0) / rows.length).toFixed(2),
  p95Ms: sortedMs[Math.max(0, Math.ceil(rows.length * 0.95) - 1)],
};
console.log(JSON.stringify({ summary, rows }, null, 2));
await rm("./.generic-eval", { recursive: true, force: true });
if (rows.some((row) => !row.pass)) process.exit(1);
