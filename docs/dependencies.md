# Runtime compatibility and dependency security

## Node support

The tested minimum is **Node 22.23.1**; Node 24 is also supported. Earlier Node 22
minors are not promised: SQLite must be available without extra flags. The existing
`node:sqlite` implementation, transactions, migrations, leases and exact citation
contracts are retained, not replaced by a native addon. Node 22 may emit SQLite's
experimental warning on stderr. CI runs the offline contracts on 22.23.1 and 24.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run test:no-service
npm audit --omit=dev
```

`test:no-service` refuses `net.Server.listen` and exercises rendering, SQLite,
revision/lease replay, conversion helpers and the respondent via in-memory transport.
It does not start Sillage. `npm test` is the full suite, including disposable
loopback HTTP listeners; do not run it when a no-service-start hold applies.

## Security refresh

The starting production audit contained **10 affected packages: 8 moderate and
2 high**, including transitive impact counts, not ten independent exploits. High
findings included lodash-es template-import code injection
[GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc) and nanoid
[GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv),
[GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8), and
[GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w).
Exploitability in this reader scenario was not established. The refreshed audit
also identifies Mermaid sanitization, prototype-pollution and availability fixes.

| Dependency | Resolution | Reason |
| --- | --- | --- |
| Mermaid | 11.12.1 → **11.17.2** | Patched 11.x, without taking the unrelated 12.x major |
| lodash-es | 4.17.21 → **4.18.1**, override | Pinned older transitive requirements otherwise retain vulnerable code |
| nanoid in Excalidraw | **3.3.19**, scoped override | Patched compatible 3.x branch |
| nanoid in mermaid-to-excalidraw | 4.0.2 → **5.1.16**, scoped override | 4.x has no patched version; converter uses the ESM `nanoid()` API, verified by native conversions |
| Excalidraw / converter / React | **0.18.1 / 2.2.2 / 18.3.1** retained | Preserve the editor/font contract; no forced downgrade or unrelated replacement |

The committed lockfile records exact resolved versions and registry integrity.
A clean Node 22 `npm ci --ignore-scripts` and `npm audit --omit=dev` returned **zero
reported vulnerabilities** for this candidate. This is a dated registry observation,
not a guarantee of safety or proof that malicious diagrams cannot exhaust resources.
Rerun the audit before first use and after updates. No `npm audit fix --force` or
suppressed severity threshold is used.

Mermaid now scopes SVG IDs by render ID. The old converter consequently fell back
to images for subgraph, class, ER and state fixtures. The build-only, fail-closed
adapter in `scripts/mermaid-compatibility.js` makes its temporary container queries
understand that exact prefix; `src/mermaid-container.js` **does not strip DOM IDs or
security configuration**, change semantic reconciliation, or mutate stored scenes.
The class parser's existing class-counter lookup also recognizes the exact render
prefix. Both patched upstream locations are checked at build time. A new converter
requires review and a fresh native-conversion probe, not a blind replacement.
See [whiteboards](whiteboards.md) for the unchanged sandbox/font protections.

## Mandatory first-start decision

The presenting agent must explain the old high advisories, the fresh production
audit result and the limits above, then ask for **explicit permission to start and
import**. This applies **even after all known findings are treated**. Do not treat
repository download, skill installation, package trust or “use Sillage” as this
approval. If the audit is unavailable or a risk choice exceeds the agent's authority,
stop and surface it. The skill owns this consent workflow; the historical CLI is
noninteractive and is not a security enforcement boundary against a local user.

No private report is required to audit or test. Never attach it to an issue, commit,
audit payload, test, screenshot or public validation artifact.
