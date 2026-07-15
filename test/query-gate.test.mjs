import { test } from "node:test";
import assert from "node:assert/strict";
import { listMcpTools } from "../dist/mcp/server.js";
import { QueryDisabledError } from "../dist/errors.js";
import { ContextService } from "../dist/context-service.js";

test("MCP hides execution tools when query execution is disabled", () => {
  const names = listMcpTools(false).map((t) => t.tool.name);
  assert.equal(names.includes("context_run_readonly_query"), false);
  assert.equal(names.includes("context_run_semantic_query"), false);
  assert.ok(names.includes("context_validate_sql"));
  assert.ok(names.includes("context_compile_semantic_query"));
  assert.ok(names.includes("context_search"));
});

test("MCP exposes execution tools when query execution is enabled", () => {
  const names = listMcpTools(true).map((t) => t.tool.name);
  assert.ok(names.includes("context_run_readonly_query"));
  assert.ok(names.includes("context_run_semantic_query"));
});

test("ContextService refuses execution when allowQueryExecution is false", async () => {
  const service = new ContextService({
    snapshotDir: "./snapshots",
    queryRowLimit: 100,
    queryTimeoutMs: 1000,
    allowQueryExecution: false,
  });
  await assert.rejects(
    () => service.runReadonlyQuery("SELECT 1"),
    (err) => err instanceof QueryDisabledError && err.code === "QUERY_DISABLED",
  );
});
