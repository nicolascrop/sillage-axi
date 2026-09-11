# Sillage project memory

- Local-only, single-report prototype, independent of Lavish. Do not introduce a real external provider or automatic network fetches without a separate privacy decision.
- Run/setup, scope, safety boundaries and diagram extension points: `README.md`. Public installer-facing agent workflow: `skills/sillage/SKILL.md`, generated from `src/guidance.js` with `npm run skill:generate`. Node.js 24+; `npm test` and `npm run check` are offline after `npm ci --ignore-scripts`.
- Semantic IDs and conservative revision reconciliation live in `src/render.js`; persistence/leases in `src/store.js`; the provider-neutral contract is `docs/agent-protocol.md`. Never replace the fail-unmatched policy with silent fuzzy reattachment.
- Product identity mapping and preserved compatibility surfaces are documented in `docs/migration-sillage-axi.md`; do not rename its listed v1 paths, variables, routes or identifiers.
- Default data is `.data/sillage.sqlite` (gitignored). Tests use disposable databases under `.data/test/`. Never commit reader reports, questions, database files or secrets.
- Active-local-agent lifecycle/stdio limits: `docs/local-agent.md`; workflow-owned browser live-revision updates: `README.md#live-report-updates`. No bundled inference; only one service per database.
- Validation evidence and known coverage limitations: `docs/acceptance.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
