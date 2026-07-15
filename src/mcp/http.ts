/**
 * Remote MCP over Streamable HTTP + admin token dashboard.
 *
 * Plug-and-play org model:
 *   - Tech configures Metabase on the server and issues per-user connector tokens.
 *   - End users get their own Bearer token + MCP URL (no Metabase credentials).
 *   - Ctxd drafts/validates SQL by default; users run queries in Metabase.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ContextService } from "../context-service.js";
import { logger } from "../logger.js";
import { TokenStore, defaultTokenStorePath, generateRawToken } from "../auth/tokens.js";
import { buildMcpServer } from "./server.js";
import { renderAdminHtml } from "./admin-ui.js";

export interface HttpServeOptions {
  host: string;
  port: number;
  /** Admin secret for /admin dashboard and token APIs. */
  adminToken: string;
  /** Directory for tokens.json (default ./data). */
  dataDir?: string;
  path?: string;
}

function unauthorized(res: ServerResponse, message: string): void {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="ctxd", error="invalid_token"',
  });
  res.end(JSON.stringify({ error: message }));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Constant-time compare for admin token. */
export function authorizeAdmin(header: string | undefined, expected: string): boolean {
  if (!expected || !header) return false;
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!raw) return false;
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract bearer raw token (user or admin). */
export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim() || undefined;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

/**
 * Start Streamable HTTP MCP + /admin token dashboard.
 * Blocks until the process is stopped.
 */
export async function serveHttpMcp(service: ContextService, opts: HttpServeOptions): Promise<void> {
  const mcpPath = opts.path ?? "/mcp";
  if (!opts.adminToken || opts.adminToken.length < 16) {
    throw new Error("CTXD_ADMIN_TOKEN must be set (≥16 chars) for HTTP serve and the admin dashboard.");
  }

  const store = new TokenStore(defaultTokenStorePath(opts.dataDir ?? "./data"));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          service: "ctxd",
          release: service.activeRelease,
          mcp: mcpPath,
          allowQuery: service.allowsQueryExecution,
          auth: "per-user-bearer",
        });
        return;
      }

      // --- Admin UI + API (CTXD_ADMIN_TOKEN) ---
      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(renderAdminHtml());
          return;
        }
      }

      if (url.pathname.startsWith("/admin/api/")) {
        if (!authorizeAdmin(req.headers.authorization, opts.adminToken)) {
          unauthorized(res, "Admin token required (Authorization: Bearer CTXD_ADMIN_TOKEN).");
          return;
        }

        if (url.pathname === "/admin/api/tokens" && req.method === "GET") {
          json(res, 200, { tokens: await store.list() });
          return;
        }

        if (url.pathname === "/admin/api/tokens" && req.method === "POST") {
          const body = (await readJsonBody(req)) as { name?: string } | undefined;
          const issued = await store.create(body?.name ?? "");
          json(res, 201, {
            id: issued.id,
            name: issued.name,
            createdAt: issued.createdAt,
            token: issued.token,
            note: "Copy this token now — it is not shown again. Give it only to that user for Claude/Codex MCP.",
          });
          return;
        }

        const revokeMatch = url.pathname.match(/^\/admin\/api\/tokens\/([^/]+)\/revoke$/);
        if (revokeMatch && req.method === "POST") {
          const ok = await store.revoke(revokeMatch[1]!);
          json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "Token not found or already revoked" });
          return;
        }

        json(res, 404, { error: "Not found" });
        return;
      }

      // --- MCP ---
      if (url.pathname !== mcpPath) {
        json(res, 404, { error: "Not found" });
        return;
      }

      const raw = extractBearer(req.headers.authorization);
      const user = raw ? await store.verify(raw) : undefined;
      if (!user) {
        unauthorized(
          res,
          "Missing or invalid user token. Ask your admin to issue a per-user ctxd token (not a shared org secret).",
        );
        return;
      }

      const mcp = buildMcpServer(service);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcp.connect(transport);

      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await transport.handleRequest(req, res, body);

      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
    } catch (err) {
      logger.error("http mcp request failed", { message: (err as Error).message });
      if (!res.headersSent) {
        json(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      logger.info("ctxd MCP HTTP server listening", {
        url: `http://${opts.host}:${opts.port}${mcpPath}`,
        health: `http://${opts.host}:${opts.port}/health`,
        admin: `http://${opts.host}:${opts.port}/admin`,
        auth: "per-user Bearer tokens (admin dashboard issues them)",
        allowQuery: service.allowsQueryExecution,
      });
      resolve();
    });
  });

  await new Promise<void>(() => {});
}

/** @deprecated use generateRawToken / TokenStore — kept for CLI helpers */
export function generateConnectorToken(): string {
  return generateRawToken();
}

/** @deprecated shared-token auth removed — use TokenStore.verify */
export function authorizeBearer(header: string | undefined, expected: string): boolean {
  return authorizeAdmin(header, expected);
}
