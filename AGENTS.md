## Learned User Preferences

- Prefer simple plug-and-play org rollout: end users should not configure Metabase credentials; tech configures Metabase once on the server.
- Default product mode is context-only: LLM builds/validates SQL via ctxd; users run queries in Metabase. Query execution is opt-in via CTXD_ALLOW_QUERY.
- Hosted auth uses per-user connector tokens issued from an admin dashboard (not one shared org token).

## Learned Workspace Facts

- The project is being named `ctxd` (context daemon).
- Ctxd reduces token use and schema-query hallucinations by serving curated, versioned Metabase context to AI agents through MCP.
- The intended operational model is that a technical team ingests schema context while other users connect through MCP; SQL is drafted for Metabase rather than executed by default.
- Preferred hosted ingest is `ctxd refresh` on a nightly cron on the same host/volume as the MCP server (GitHub Action artifacts alone do not update live Docker data).
- HTTPS is terminated by Caddy in front of `ctxd serve --http`.
- BRD.md is internal planning and is gitignored for the public repo.
