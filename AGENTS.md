# Sillage project memory

- Local-only, single-report prototype, independent of Lavish. Do not introduce a real external provider or automatic network fetches without a separate privacy decision.
- Run/setup, scope, safety boundaries and diagram seam: `README.md`. Node.js 24+; `npm test` and `npm run check` are offline after `npm ci --ignore-scripts`.
- Semantic IDs and conservative revision reconciliation live in `src/render.js`; persistence/leases in `src/store.js`; the provider-neutral contract is `docs/agent-protocol.md`. Never replace the fail-unmatched policy with silent fuzzy reattachment.
- Default data is `.data/sillage.sqlite` (gitignored). Tests use disposable databases under `.data/test/`. Never commit reader reports, questions, database files or secrets.
- Validation evidence and known coverage limitations: `docs/acceptance.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
