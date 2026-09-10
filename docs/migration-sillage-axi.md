# Sillage → Sillage AXI migration

Sillage AXI is the product name introduced after the AXI F01–F07 facade was
accepted. This is an additive identity migration, not a data or protocol
migration. The package remains private and local-only; no npm publication is
part of this change.

## Repository URLs

- Canonical repository: <https://github.com/nicolascrop/sillage-axi>
- Historical repository URL: <https://github.com/nicolascrop/sillage>

GitHub currently reports `nicolascrop/sillage-axi` for both repository URLs;
the historical URL redirects to the canonical repository. Verify the active
mapping with `gh-axi repo view nicolascrop/sillage-axi` and
`gh-axi repo view nicolascrop/sillage`. The checkout remote is the canonical SSH
URL `git@github.com:nicolascrop/sillage-axi.git`.

## Compatibility map

| Existing surface | Sillage AXI surface | Compatibility guarantee |
| --- | --- | --- |
| npm package `sillage` | private package `sillage-axi` | `private: true`, version, Node floor, scripts, dependencies and lockfile remain coherent; the package is not published |
| `sillage` executable | primary `sillage-axi` executable | Both npm bins are installed; `sillage` remains an alias |
| `node bin/sillage.js` | `node bin/sillage-axi.js` | The historical Node path remains executable; the new path delegates to the same CLI |
| `sillage <command>` | `sillage-axi <command>` | Every finite CLI command and its TOON/error behavior are available under both names |
| `skills/sillage/SKILL.md` | Sillage AXI instructions at the established skill path | `/sillage`, the install path and one generated source of instructions remain; no duplicate skill is introduced |
| `Sillage` UI/service label | `Sillage AXI` | Public labels and new help/examples use the product name; compatibility identifiers below do not change |
| `/sillage.svg` | `/sillage.svg` | Existing HTTP asset route and icon path remain unchanged |
| `npm start`, `npm run fake-agent`, `npm run local-agent` | unchanged scripts | Existing scripts and direct Node entrypoints remain valid |

## Invariants deliberately preserved

- `SILLAGE_DB`, `SILLAGE_PORT`, `SILLAGE_URL`, `.sillage/config.json` and the
  default `.data/sillage.sqlite` path are unchanged.
- Revision IDs, block UUIDs, request/thread UUIDs, the SQLite schema and its
  existing migrations are unchanged. No database rename or schema migration is
  required.
- HTTP routes, JSON/JSONL v1 wire formats, `sillage-agent-v1`,
  `X-Sillage-Local` and `X-Sillage-Scope` are unchanged.
- Existing ESM imports from `src/` and historical `bin/sillage.js`,
  `src/server.js`, `src/fake-agent.js` and `src/local-agent.js` continue to
  work.
- The loopback-only boundary, strict host/origin checks, no-cloud/local-only
  rule, finite help/version probes and no-database side-effect guarantee remain
  in force.
- Existing fixtures and compatibility clients do not need a key, path, header,
  protocol or identifier rewrite.

## Safe rollout

1. Install or link the private checkout normally. Prefer `sillage-axi`; keep
   existing hooks, scripts and agents on `sillage` until convenient.
2. For new setup hooks, run `sillage-axi setup --app <app> --local-only`.
   Existing managed hooks using `sillage context` continue to work. Setup still
   writes only project-scoped configuration and never changes user-home config.
3. Keep the same working directory and `SILLAGE_DB` when restarting the local
   service. Do not copy or rename the database for this product rename.
4. Use `sillage-axi agent-help` for the unchanged v1 lifecycle. Use
   `node src/local-agent.js` for the unchanged direct JSONL attachment.

The generated skill is checked by `npm run skill:check`; edit its shared source
in `src/guidance.js` and regenerate rather than maintaining a second instruction
copy. Migration examples and both command names are covered by the rename tests.
