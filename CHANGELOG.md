# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-14

### Added

- Metabase adapter, metadata/content indexers, immutable release snapshots with FTS5 search.
- MCP server with fourteen `context_*` tools for search, planning, semantic/contract compile, and read-only SQL execution.
- Semantic definitions (`semantics/definitions.json`) and vendor-neutral context contract (`context.contract.json`).
- Release gate CLI, benchmark harness, and dbt/Cube/MetricFlow metadata adapters.
- CI workflow for typecheck, build, and unit tests.
- Remote HTTP MCP with per-user Bearer tokens and `/admin` dashboard (`CTXD_ADMIN_TOKEN`).
- Context-only default: `CTXD_ALLOW_QUERY=false` hides `context_run_*` tools; agents draft SQL for Metabase.
- `ctxd refresh` for nightly Metabase ingest without manual release tags (fingerprint skip, prune, rollback retained).
- Docker Compose + Caddy HTTPS reverse proxy; cron/`docker compose run --rm refresh` on the host for live updates.

### Security

- Read-only SQL validation (parse fail-closed, reject `SELECT ... INTO`, row limits).
- Denylist enforcement at query validation time for tables and columns.
- Contract `policies.allowedSchemas` enforced at validate and compile time.
- HTTP connector auth is separate from Metabase; Metabase keys stay on the server.
- Query execution through ctxd is opt-in (`CTXD_ALLOW_QUERY`); default is context + SQL compile only.

[Unreleased]: https://github.com/YOUR_ORG/ctxd/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YOUR_ORG/ctxd/releases/tag/v0.1.0
