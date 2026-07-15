# Security Policy

Report security issues privately to the repository maintainers. Do not include
API keys, database credentials, production rows, or customer data in a public
issue.

The runtime uses a least-privilege Metabase API key **on the server only** for
snapshot ingest (and optionally for tech-bot query execution when
`CTXD_ALLOW_QUERY=true`). Keep secrets in the environment or a secret manager.

Operators hold `CTXD_ADMIN_TOKEN` for the `/admin` dashboard and issue **per-user**
connector tokens. Do not use one shared user token, and do not distribute Metabase
API keys to Claude/Codex users.

By default ctxd does not execute production queries — it drafts and validates SQL
for users to run in Metabase. Review denylist settings (denylisted tables and
columns are indexed but rejected at validation time), and treat snapshots as
metadata artifacts that may still reveal schema names.
