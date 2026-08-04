/**
 * MCP stdio server (§7.6).
 *
 * Exposes focused retrieval tools instead of dumping the whole snapshot into the
 * agent's context. Each tool returns compact JSON and every response embeds the
 * source snapshot + release so the agent always knows which version it's using.
 *
 * Transport is stdio (Claude/Codex compatible, §12). All diagnostics go to stderr
 * via the logger — stdout is reserved for the JSON-RPC protocol.
 *
 * We use the low-level Server API with explicit JSON Schemas (rather than the
 * high-level `server.tool()` helper) to keep the type-checker's generic inference
 * shallow, and validate arguments at runtime with Zod.
 */

import { VERSION } from "../version.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { ContextService } from "../context-service.js";
import { AgentContextError } from "../errors.js";
import { logger } from "../logger.js";
import { approxTokens, recordMetric } from "../metrics.js";
import { zSemanticQuery } from "../semantic.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const message =
    err instanceof AgentContextError
      ? `[${err.code}] ${err.message}`
      : (err as Error).message ?? String(err);
  logger.warn("mcp tool error", { message });
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

/** Tool definitions (JSON Schema for the wire) paired with Zod arg validators. */
interface ToolDef {
  tool: Tool;
  args: z.ZodTypeAny;
  handle: (args: any, service: ContextService) => Promise<ToolResult> | ToolResult;
}

const TOOLS: ToolDef[] = [
  {
    tool: {
      name: "context_search",
      description:
        "Search the database + Metabase context for tables, columns, and saved questions relevant to a query. Returns a compact top-N per category with the source snapshot version.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language or keyword query" },
          scope: {
            type: "string",
            enum: ["all", "tables", "columns", "assets"],
            description: "Restrict the search scope (default: all)",
          },
          limit: { type: "number", description: "Max results per category (default 8)" },
        },
        required: ["query"],
      },
    },
    args: z.object({
      query: z.string(),
      scope: z.enum(["all", "tables", "columns", "assets"]).optional(),
      limit: z.number().int().positive().max(50).optional(),
    }),
    handle: (a, s) => ok(s.search(a.query, { scope: a.scope, limit: a.limit })),
  },
  {
    tool: {
      name: "context_plan_query",
      description:
        "One-shot planner for a natural-language data question: returns semantic definitions, candidate tables and columns, the FK join paths connecting those tables, saved questions, and ambiguity warnings — everything needed to write the SQL in a single call. Does not execute SQL.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The business question to resolve" },
          limit: { type: "number", description: "Max candidates per category (default 8)" },
        },
        required: ["question"],
      },
    },
    args: z.object({ question: z.string(), limit: z.number().int().positive().max(50).optional() }),
    handle: (a, s) => ok(s.planQuery(a.question, a.limit)),
  },
  {
    tool: {
      name: "context_compile_semantic_query",
      description:
        "Compile a declarative semantic query into validated SQL without executing it. Paste the result into Metabase (ctxd does not run production queries by default).",
      inputSchema: {
        type: "object",
        properties: {
          measures: { type: "array", items: { type: "string" } },
          dimensions: { type: "array", items: { type: "string" } },
          filters: { type: "array", items: { type: "object" } },
          orderBy: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
        },
        required: ["measures"],
      },
    },
    args: zSemanticQuery,
    handle: (a, s) => ok(s.compileSemanticQuery(a)),
  },
  {
    tool: {
      name: "context_compile_contract_query",
      description: "Compile a query using only the project's reviewed context contract and approved join graph. Returns SQL to run in Metabase; rejects unapproved or high-fanout paths.",
      inputSchema: {
        type: "object",
        properties: {
          measures: { type: "array", items: { type: "string" } },
          dimensions: { type: "array", items: { type: "string" } },
          filters: { type: "array", items: { type: "object" } },
          limit: { type: "number" },
        },
        required: ["measures"],
      },
    },
    args: z.object({
      measures: z.array(z.string()).min(1),
      dimensions: z.array(z.string()).optional(),
      filters: z.array(z.object({ field: z.string(), operator: z.enum(["=", "!=", ">", ">=", "<", "<="]), value: z.union([z.string(), z.number(), z.boolean()]) })).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    }),
    handle: (a, s) => ok(s.compileContractQuery(a)),
  },
  {
    tool: {
      name: "context_run_semantic_query",
      description:
        "Execute a release-managed semantic metric through Metabase (only when CTXD_ALLOW_QUERY=true). Default org mode: use context_compile_semantic_query and run SQL in Metabase instead.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Semantic definition id" },
          databaseId: { type: "number", description: "Optional target Metabase database id" },
          query: { type: "object", description: "Declarative semantic query; use instead of id for grouped analytics" },
        },
        anyOf: [
          { required: ["id"] },
          { required: ["query"] },
        ],
      },
    },
    args: z.object({
      id: z.string().optional(),
      databaseId: z.number().int().optional(),
      query: zSemanticQuery.optional(),
    }).refine((value) => Boolean(value.id) !== Boolean(value.query), "Provide exactly one of id or query."),
    handle: async (a, s) => ok(a.query ? await s.runCompiledSemanticQuery(a.query, a.databaseId) : await s.runSemanticQuery(a.id!, a.databaseId)),
  },
  {
    tool: {
      name: "context_get_entity",
      description:
        "Get context for one table (or column): its columns, foreign-key relationships, and any saved Metabase questions that reference it. Columns are returned in a compact form by default (nested JSONB fields collapsed); set full=true for complete detail.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Qualified name, bare name, or entity id" },
          full: {
            type: "boolean",
            description: "Return full column records and untruncated SQL (default false = compact)",
          },
        },
        required: ["name"],
      },
    },
    args: z.object({ name: z.string(), full: z.boolean().optional() }),
    handle: (a, s) => ok(s.getEntity(a.name, { full: a.full })),
  },
  {
    tool: {
      name: "context_get_relationships",
      description: "List the foreign-key relationships touching a table, in either direction.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Qualified or bare table name" } },
        required: ["name"],
      },
    },
    args: z.object({ name: z.string() }),
    handle: (a, s) => ok(s.getRelationships(a.name)),
  },
  {
    tool: {
      name: "context_find_saved_questions",
      description:
        "Find existing Metabase questions/models relevant to a query, so a trusted query can be reused before generating new SQL.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What you want to compute" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    args: z.object({ query: z.string(), limit: z.number().int().positive().max(50).optional() }),
    handle: (a, s) => ok(s.findSavedQuestions(a.query, a.limit)),
  },
  {
    tool: {
      name: "context_get_release_context",
      description:
        "Inspect a specific release's snapshot metadata (version, fingerprint, counts) WITHOUT changing the server's active snapshot.",
      inputSchema: {
        type: "object",
        properties: { release: { type: "string", description: "Release tag or commit id" } },
        required: ["release"],
      },
    },
    args: z.object({ release: z.string() }),
    handle: async (a, s) => ok(await s.describeRelease(a.release)),
  },
  {
    tool: {
      name: "context_get_freshness",
      description:
        "Report the current snapshot version, fingerprint, generation time, and whether it matches the deployed release/commit.",
      inputSchema: { type: "object", properties: {} },
    },
    args: z.object({}),
    handle: async (_a, s) => ok(await s.freshness()),
  },
  {
    tool: {
      name: "context_validate_sql",
      description: "Check whether a SQL statement is a safe read-only query. Does NOT execute it — use before pasting into Metabase.",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string", description: "The SQL to validate" } },
        required: ["sql"],
      },
    },
    args: z.object({ sql: z.string() }),
    handle: (a, s) => ok(s.validateSql(a.sql)),
  },
  {
    tool: {
      name: "context_run_readonly_query",
      description:
        "Execute read-only SQL through Metabase (only when CTXD_ALLOW_QUERY=true). Default org mode hides this tool: draft SQL with ctxd, run it in Metabase under the user's own access.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "Read-only SQL (SELECT / WITH only)" },
          databaseId: { type: "number", description: "Target Metabase database id (inferred if omitted)" },
        },
        required: ["sql"],
      },
    },
    args: z.object({ sql: z.string(), databaseId: z.number().int().optional() }),
    handle: async (a, s) => ok(await s.runReadonlyQuery(a.sql, a.databaseId)),
  },
  {
    tool: {
      name: "context_get_join_path",
      description:
        "Find the shortest foreign-key join path between two tables (BFS over the FK graph). Returns the ordered join edges so an agent never has to guess how to join two tables.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "Qualified or bare source table name" },
          to: { type: "string", description: "Qualified or bare target table name" },
        },
        required: ["from", "to"],
      },
    },
    args: z.object({ from: z.string(), to: z.string() }),
    handle: (a, s) => ok(s.getJoinPath(a.from, a.to)),
  },
  {
    tool: {
      name: "context_get_changes",
      description:
        "Return the schema-change diff (added/removed tables, columns, relationships, assets) for a release vs its predecessor. Answers 'what changed between versions'.",
      inputSchema: {
        type: "object",
        properties: { release: { type: "string", description: "Release id (defaults to the active snapshot)" } },
      },
    },
    args: z.object({ release: z.string().optional() }),
    handle: async (a, s) => ok(await s.getChanges(a.release)),
  },
];

/** Tools that execute SQL through Metabase — hidden unless CTXD_ALLOW_QUERY=true. */
const QUERY_EXECUTION_TOOLS = new Set(["context_run_readonly_query", "context_run_semantic_query"]);

export function listMcpTools(allowQueryExecution: boolean): ToolDef[] {
  return allowQueryExecution ? TOOLS : TOOLS.filter((t) => !QUERY_EXECUTION_TOOLS.has(t.tool.name));
}

export function buildMcpServer(service: ContextService): Server {
  const tools = listMcpTools(service.allowsQueryExecution);
  const server = new Server(
    { name: "ctxd", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const def = tools.find((t) => t.tool.name === req.params.name);
    if (!def) {
      if (QUERY_EXECUTION_TOOLS.has(req.params.name) && !service.allowsQueryExecution) {
        return fail(
          new Error(
            `[QUERY_DISABLED] ${req.params.name} is not available. Ctxd drafts and validates SQL; run it in Metabase. Set CTXD_ALLOW_QUERY=true only for trusted tech bots.`,
          ),
        );
      }
      return fail(new Error(`Unknown tool: ${req.params.name}`));
    }
    const t0 = performance.now();
    try {
      const parsed = def.args.parse(req.params.arguments ?? {});
      const res = await def.handle(parsed, service);
      // Record actuals for the savings dashboard (best-effort, non-blocking).
      const text = res.content?.[0]?.text ?? "";
      void recordMetric(service.snapshotDir, {
        at: new Date().toISOString(),
        tool: def.tool.name,
        tokensApprox: approxTokens(text),
        latencyMs: Math.round((performance.now() - t0) * 100) / 100,
        release: service.activeRelease,
        outcome: "ok",
      });
      return res;
    } catch (err) {
      void recordMetric(service.snapshotDir, {
        at: new Date().toISOString(),
        tool: def.tool.name,
        tokensApprox: 0,
        latencyMs: Math.round((performance.now() - t0) * 100) / 100,
        release: service.activeRelease,
        outcome: "error",
        errorCode: err instanceof AgentContextError ? err.code : "UNEXPECTED_ERROR",
      });
      return fail(err);
    }
  });

  return server;
}

/** Start the MCP server on stdio and block until the transport closes. */
export async function serveMcp(service: ContextService): Promise<void> {
  const server = buildMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("ctxd MCP server listening on stdio");
}
