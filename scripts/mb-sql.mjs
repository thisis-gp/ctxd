// Direct staging-Metabase SQL runner — the "no context layer" baseline tool.
// Runs arbitrary read-only SQL against the app database (id 2) via the Metabase
// dataset API. No snapshot, no ctx, no schema knowledge — an agent must discover
// everything itself (information_schema, sampling). Prints columns + rows as JSON.
//
// Usage: node scripts/mb-sql.mjs "SELECT ..."
import { MetabaseClient } from "../dist/metabase/client.js";
import { loadConfig } from "../dist/config.js";

const sql = process.argv.slice(2).join(" ").trim();
if (!sql) {
  console.error("usage: node scripts/mb-sql.mjs \"<SQL>\"");
  process.exit(1);
}
const cfg = loadConfig();
const client = new MetabaseClient({ baseUrl: cfg.metabaseUrl, apiKey: cfg.metabaseApiKey, timeoutMs: 20000 });
try {
  const res = await client.runNativeQuery(2, sql, { rowLimit: 2000, timeoutMs: 20000 });
  const columns = (res.data?.cols ?? []).map((c) => c.name);
  const rows = res.data?.rows ?? [];
  process.stdout.write(JSON.stringify({ columns, rows }) + "\n");
} catch (err) {
  process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
  process.exit(1);
}
