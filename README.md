# ctxd

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

A vendor-neutral, release-aware context contract and MCP runtime for reliable
data agents. It gives Claude, Codex, and other clients compact metadata, reviewed
semantic definitions, approved join paths, and pre-execution validation.

The project deliberately does not replace Metabase, dbt, Cube, or a warehouse.
It is the contract, compiler, release gate, and evaluation layer between those
systems and an agent.

## Install

**From npm** (CLI + library; requires a C++ toolchain for `better-sqlite3`):

```bash
npm install ctxd
npx ctxd init
```

**From source** (recommended for development and contributions):

```bash
git clone https://github.com/thisis-gp/ctxd.git
cd ctxd
npm install   # or: corepack enable && yarn install
npm test
npx ctxd init
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev workflow. Report security
issues privately — see [SECURITY.md](SECURITY.md).

```
Agent question
    -> context search / plan / compile
    -> trusted SQL (validated, version-stamped)
    -> user runs SQL in Metabase (their own access)
```

By default ctxd does **not** execute production queries. It is the context and SQL
compiler for agents; Metabase remains the query surface.

It talks to Metabase **via the Metabase API for metadata ingest** (and optionally
for tech-bot query execution). No direct database credentials. Nightly `refresh`
uses a server-side API key; end users never see it.

## Who configures what (plug-and-play)

| Role | What they do | What they never need |
|------|--------------|----------------------|
| Tech team | Set Metabase URL/API key on the server, run `ctxd refresh`, run `ctxd serve --http` | Per-user Metabase logins for agents |
| Claude / Codex users | Add MCP URL + **their personal** token; get trusted SQL for Metabase | Metabase API keys, shared org token, running queries through ctxd |

**Default product mode is context-only:** ctxd helps the LLM find tables/joins/metrics and draft/validate SQL. Users (or Metabase) run the query. Query execution tools stay off unless `CTXD_ALLOW_QUERY=true` (tech bots only).

### Org quickstart (hosted + HTTPS)

```bash
# On the server (tech once)
npx ctxd init
# edit .env: METABASE_URL, METABASE_API_KEY, CTXD_ADMIN_TOKEN, CTXD_DOMAIN, ACME_EMAIL

npx ctxd refresh --prune-keep 14   # must run on the SAME host/volume as serve
docker compose up -d --build       # Caddy HTTPS → ctxd
```

**Ops note:** Nightly refresh must run where the MCP server reads snapshots
(e.g. `docker compose run --rm refresh` on that host). A GitHub Action that only
uploads an artifact does **not** update the live server — that was the “ops gap.”

```cron
15 2 * * * cd /opt/ctxd && docker compose run --rm refresh >> /var/log/ctxd-refresh.log 2>&1
```

Open **https://$CTXD_DOMAIN/admin**, sign in with `CTXD_ADMIN_TOKEN`, and create
**one token per user**. Users paste into Claude/Codex:

```json
{
  "mcpServers": {
    "ctxd": {
      "url": "https://ctxd.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ctxd_USER_SPECIFIC_TOKEN"
      }
    }
  }
}
```

Health: `GET /health`. MCP: `POST /mcp` (per-user Bearer). Admin: `/admin`.

### Local developer (stdio)

```bash
npx ctxd serve
```

Register with a local command entry as in `examples/mcp-config.json` (`ctxd-local`).

## How it works

A snapshot build queries Metabase once and produces an immutable, per-release
snapshot directory:

```
snapshots/v8.19.0-0/
├── manifest.json          # release, git commit, fingerprint, counts, status
├── entities.jsonl         # databases / schemas / tables / columns (inspectable)
├── relationships.jsonl    # foreign-key edges
├── metabase-assets.jsonl  # questions / models / dashboards + query definitions
├── semantic-definitions.json # versioned metric definitions + SQL templates
├── search.sqlite          # FTS5 full-text index for sub-second retrieval
└── changes.json           # diff vs the previous snapshot
```

The MCP server then serves focused retrieval from the promoted `current` snapshot
instead of dumping the whole model into the conversation.

### Architecture

| Layer | Module | Responsibility |
|-------|--------|----------------|
| Adapter | `src/metabase/` | Only place that speaks the Metabase HTTP API |
| Metadata indexer | `src/indexer/metadata-indexer.ts` | Normalize DB structure into entities + FK relationships |
| Content indexer | `src/indexer/content-indexer.ts` | Normalize questions / models / dashboards |
| Snapshot | `src/snapshot/` | Deterministic fingerprint, JSONL + SQLite, manifest, diff |
| Release | `src/release/manager.ts` | `current` pointer lifecycle: validate → publish → promote → rollback |
| Retrieval | `src/context-service.ts` | Search, entity context, freshness, SQL validation, read-only exec |
| MCP | `src/mcp/server.ts`, `src/mcp/http.ts` | Fourteen `context_*` tools over stdio or remote HTTP |
| Adapters | `src/adapters/` | Import dbt, Cube, and MetricFlow JSON metadata into the same normalized model |
| Contract draft | `src/contract-draft.ts` | Generate a reviewable starting contract from a snapshot or adapter export |
| Evaluation | `src/benchmark.ts` | Compare direct-schema agent runs with context-layer runs on accuracy, tokens, calls, and time |

The adapter boundary is strict: nothing above `src/metabase/` sees a raw Metabase
response — everything consumes the normalized model in `src/model.ts`. Swapping
the data source later means rewriting only the adapter.

## Setup

```bash
yarn install
yarn build
node dist/cli.js init      # scaffolds .env from .env.example
# edit .env: set METABASE_URL and METABASE_API_KEY
```

## Building a snapshot

```bash
# Build, validate, publish, and promote a release snapshot.
node dist/cli.js snapshot build    --release v8.19.0-0 --git-commit "$(git rev-parse HEAD)"
node dist/cli.js snapshot validate --release v8.19.0-0
node dist/cli.js snapshot publish  --release v8.19.0-0
node dist/cli.js snapshot promote  --release v8.19.0-0   # advances `current`
```

Or run the whole pipeline (build → validate → publish → deploy/health → promote):

```bash
DEPLOY_SCRIPT=./scripts/deploy.sh HEALTHCHECK_SCRIPT=./scripts/healthcheck.sh scripts/release.sh v8.19.0-0 v8.18.0-0
```

Rollback restores the previous pointer:

```bash
node dist/cli.js snapshot rollback
```

## Querying from the terminal

```bash
node dist/cli.js search "active user subscriptions"
node dist/cli.js search "invoices" --scope tables
node dist/cli.js join-path public.claim_files public.benefits  # shortest FK join path
node dist/cli.js diff                                          # schema changes vs previous release
node dist/cli.js drift                                         # is the current snapshot stale vs live Metabase?
node dist/cli.js freshness
node dist/cli.js stats            # token/latency savings dashboard from recorded MCP usage
node dist/cli.js query "SELECT COUNT(*) AS claim_count FROM public.claims;"
```

## Importing other metadata tools

The core model is not Metabase-specific. Adapter inputs can be inspected or used
to draft a contract:

```bash
node dist/cli.js adapters list
node dist/cli.js adapters inspect dbt examples/dbt-manifest-mini.json
node dist/cli.js contract draft --adapter dbt --input examples/dbt-manifest-mini.json --project demo
```

Supported JSON importers:

| Adapter | Input |
|---------|-------|
| `dbt` | `manifest.json` models/sources + columns |
| `cube` | Cube schema JSON with cubes, dimensions, and measures |
| `metricflow` | MetricFlow semantic manifest JSON |

These importers create the same `NormalizedModel` that snapshots use, so new
connectors do not need a separate agent-facing contract.

## Serving to an agent

```bash
npx ctxd serve                 # local MCP stdio (developer laptop)
npx ctxd serve --http          # shared org MCP at http://HOST:8787/mcp
```

Register it with Claude Code / Codex (see `examples/mcp-config.json`).
For `--http`, users only need the URL and their **personal** Bearer token (issued at `/admin`) — not Metabase credentials.

### MCP tools

| Tool | Purpose |
|------|---------|
| `context_search` | Top-N tables, columns, and saved questions for a query |
| `context_plan_query` | Resolve a question into candidate tables, columns, saved questions, and ambiguity warnings |
| `context_compile_semantic_query` | Compile measures/dimensions/filters into SQL (no execution) |
| `context_compile_contract_query` | Compile reviewed-contract SQL (no execution) |
| `context_get_entity` | One table's columns, relationships, and referencing questions |
| `context_get_relationships` | FK edges touching a table |
| `context_get_join_path` | Shortest FK join path between two tables |
| `context_find_saved_questions` | Reusable Metabase questions/models before writing SQL |
| `context_get_changes` | Schema-change diff for a release |
| `context_get_release_context` | Inspect a specific release snapshot |
| `context_get_freshness` | Snapshot version, fingerprint, deployed-match status |
| `context_validate_sql` | Check a statement is read-only (no execution) |
| `context_run_*` | **Hidden by default.** Execute via Metabase only when `CTXD_ALLOW_QUERY=true` |

Every response embeds the source snapshot + release version.

### Context contract

`context.contract.json` is the vendor-neutral project contract. It records entity
grain, measures, dimensions, approved joins, fanout risk, and query policies.
The contract is reviewed like code and can be validated without credentials:

```bash
node dist/cli.js validate-contract context.contract.json
node dist/cli.js benchmark validate examples/benchmark.json examples/benchmark-observations.json
node dist/cli.js benchmark compare examples/benchmark.json examples/benchmark-direct-observations.json examples/benchmark-context-observations.json
node dist/cli.js snapshot validate --release v1.0.0-0 --contract context.contract.json
```

Cross-entity compilation uses only approved contract joins. Inferred foreign keys
remain useful for discovery, but they cannot silently become semantic truth.
High-fanout and many-to-many paths fail closed until explicitly modeled.

The benchmark format is intentionally model-neutral. Record each agent's
selected measures, dimensions, entities, calls, latency, and answer correctness,
then compare them against the same contract. This makes releases measurable on
correctness, wrong joins, round trips, latency, and cost instead of relying on
token estimates alone.

### Release gate

Use one command in CI to block a release when snapshot validation, contract
validation, or benchmark validation fails:

```bash
node dist/cli.js release-gate \
  --release v1.0.0-0 \
  --contract context.contract.json \
  --benchmark examples/benchmark.json \
  --observations examples/benchmark-observations.json
```

The example GitHub Actions workflow in `.github/workflows/release.yml` runs this
after snapshot build and before publish/promote.

### Demo

Open `docs/demo.html` for a static overview of the workflow and copyable
commands. It does not require credentials or a dev server.

### Declarative semantic queries

Agents should prefer semantic queries when a registered metric exists. They declare
the measure and optional dimensions/filters; the layer owns the table, canonical
formula, default filters, row cap, and read-only execution.

```json
{
  "measures": ["claims.csat_responses"],
  "dimensions": [],
  "limit": 100
}
```

Use `context_compile_semantic_query` to get generated SQL, validate with
`context_validate_sql`, then run it in Metabase. Cross-table measures are rejected
until a reviewed join graph is registered. (`context_run_semantic_query` exists only
when `CTXD_ALLOW_QUERY=true`.)

## Safety

- API keys come only from env / secret manager, are never logged, and are never
  written into a snapshot.
- **Default: no query execution through ctxd.** Agents get context + drafted SQL;
  users run queries in Metabase under their own access. Set `CTXD_ALLOW_QUERY=true`
  only for trusted tech bots.
- When execution is enabled, SQL must start with `SELECT`/`WITH`, parse as a
  single SELECT (fail closed), reject `SELECT ... INTO`, enforce row/time limits,
  and validate table/column references against the active snapshot.
- Sensitive tables/fields can be denylisted (`DENYLIST` env) — they stay indexed
  but carry no descriptions and cannot be referenced in validated/executed SQL.
- Reviewed semantic and contract definition files may contain raw SQL expressions;
  treat those files like code.
- Snapshots store metadata and query *definitions* only, never production rows.
- When execution is enabled, every executed query is appended to `audit/queries.jsonl`.

## Status

Implements the Metabase adapter, indexers, SQLite snapshot + FTS search, MCP
server, semantic + contract compilation, release versioning, release gate,
benchmark harness, and multi-source metadata adapters (dbt/Cube/MetricFlow).
Incremental snapshot refresh (Phase 5 in the BRD) is not yet implemented.
