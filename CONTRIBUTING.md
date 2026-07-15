# Contributing

Thanks for helping improve ctxd. This project is MIT-licensed OSS.

## Development setup

```bash
git clone <your-repo-url>
cd ctxd
npm install          # or: corepack enable && yarn install
npm test             # builds + runs unit tests (27 cases)
npm run test:integration   # optional; needs METABASE_URL + METABASE_API_KEY in .env
```

CI runs `yarn typecheck`, `yarn build`, and `yarn test` on every push and pull
request (see `.github/workflows/ci.yml`).

## Pull requests

1. Open an issue for large contract or protocol changes before coding.
2. Keep diffs focused; match existing TypeScript style (`strict`, no inline imports).
3. Add or update tests for behavior changes — especially fail-closed paths (SQL
   validation, denylist, contract joins, semantic compile).
4. Do **not** commit `.env`, snapshots, `audit/`, or production data.
5. Update [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for user-visible changes.

## Design rules

- Keep the core independent of Metabase-specific response shapes.
- Treat inferred metadata as discovery evidence, not business truth.
- Never silently select an ambiguous metric or join.
- Never execute non-read-only SQL.
- Keep MCP responses compact and machine-readable.
- Denylisted entities must stay blocked at query validation time, not only at index time.

## Testing expectations

| Change touches | Add tests in |
|----------------|--------------|
| SQL validation | `test/validate.test.mjs` |
| Denylist / access control | `test/denylist.test.mjs` |
| Contract / semantic compile | `test/contract.test.mjs`, `test/semantic.test.mjs` |
| Compact MCP projections | `test/compact.test.mjs` |

Use fixtures under `examples/` for contract and benchmark work.

## Security

See [SECURITY.md](SECURITY.md). Never include API keys, credentials, or production
rows in issues or PRs.
