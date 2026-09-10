# Prototype acceptance evidence

Original implementation validation: isolated `fm/sillage-mvp` worktree; Node.js **v24.18.1**, npm **11.16.0**. All implementation and test artifacts stayed in that worktree. That validation involved no Lavish changes, external provider, secrets, push, PR, or no-mistakes pipeline. The public-documentation follow-up is recorded below.

## Commands and results

```sh
npm ci --ignore-scripts --offline --cache .npm-cache --no-audit --no-fund
npm test
npm run check
git diff --check
npm audit --cache .npm-cache
```

- Reinstalled all 64 packages from the local install cache, without network access. Initial dependency installation populated that cache; it is not committed.
- **26 tests passed, 0 failed**, under Node's built-in test runner. Tests only access loopback HTTP and disposable `.data/test/` databases; no internet or secrets.
- JavaScript syntax checks and whitespace checks passed.
- Separate registry-backed dependency audit: **0 vulnerabilities** (including development dependencies). Audit is not part of the default demo/tests. The dev-only jsdom dependency emits a `whatwg-encoding` deprecation warning on installation.

Coverage:

| Area | Evidence |
| --- | --- |
| Semantic renderer / escaping | All required block kinds, unique DOM projections, TOC, raw HTML, malicious URLs, images, explicit Excalidraw fallback |
| Revision safety | Stable IDs through line shifts; changed, deleted, split, merged, duplicated, moved-section, changed-container and changed-reference-link cases; no later resurrection |
| Durable store | Close/reopen SQLite with a waiting question, active reservation and completed answer; original source/quote/citations/unread retained; unknown schema refused |
| Agent boundary | Actual fake-agent CLI subprocess; 8 competing HTTP pollers; two SQLite connections; lease expiry/reclaim/stale-token rejection; atomic invalid-citation rejection; terminal failures; same-answer retry vs conflicting duplicate |
| Reader behavior | jsdom with real local HTTP: import, exact selected quote, saved/waiting, fake answer, plain-text escaping, close/reopen, source navigation, unread handling, changed import, historical snapshot, closed-unmatched visibility, lost-response retry |
| Local HTTP safety | Foreign Origin, cross-site request metadata, DNS-rebinding Host, form CSRF, malformed/oversized input, private paths, CSP and no-CORS checks |

## Executed manual terminal walkthrough

Used a real Sillage AXI service **process**, not only an in-process database reopen:

```sh
SILLAGE_DB=.data/manual/walkthrough.sqlite SILLAGE_PORT=3219 node src/server.js
# In a second terminal, after import and question:
SILLAGE_URL=http://127.0.0.1:3219 npm run fake-agent
# Stop only this Sillage AXI process, then restart with the exact same DB and port:
SILLAGE_DB=.data/manual/walkthrough.sqlite SILLAGE_PORT=3219 node src/server.js
```

The manual API operations used `node --input-type=module` and built-in `fetch`, with `Content-Type: application/json` and `X-Sillage-Local: 1` on writes:

1. `POST /api/document` with `examples/report.md` → **revision 1, 21 passages, 5 TOC entries**.
2. `POST /api/questions`, targeting the deployment paragraph, quote `127.0.0.1`, question “What does local-only mean here?”, client key `manual-walkthrough` → **waiting**, exact quote saved.
3. `npm run fake-agent` → **answered**, with a persisted original-revision/block citation.
4. Sent SIGTERM to that service PID, waited for its exit, launched a new process against the same database. `GET /api/threads/THREAD_ID` → **2 messages, answered, unread=1, matched**; citation still quoted `127.0.0.1`.
5. `POST /api/document` with `examples/report-changed.md` → **revision 2**. Thread → **needs_review**, original quote `127.0.0.1`, **2 messages retained**. The unchanged checklist paragraph retained its block identity.
6. Another `npm run fake-agent` → **idle**; answered work was not offered again. Stopped the walkthrough service afterward. Artifacts are under ignored `.data/manual/`, not in Git.

The matching HTTP and DOM paths can be replayed automatically:

```sh
node --test test/http.test.js test/ui.test.js
```

## Browser walkthrough and limitations

The short human walkthrough is in [README.md](../README.md#walkthrough), using the two committed sample reports. A browser binary/`chrome-devtools-axi` was not available during the original implementation validation. **That initial pass did not include real-browser visual inspection.** jsdom exercised the reader's actual JavaScript against the local service, including selection, forms, close/reopen, polling and escaping, but cannot verify real layout/scroll geometry, CSP enforcement, or all accessibility behavior. The later UI delivery's accepted Chrome coverage and remaining limitations are recorded below.

Excalidraw is intentionally an explicit unsupported, source-preserving block; there is no editor or unsafe HTML/SVG embed. This is a prototype with conservative unmatched behavior, one question/reply per thread, and no automated reattachment or external provider policy.

## Public documentation follow-up

Validated in the isolated `fm/sillage-public-docs` worktree with Node.js **v24.18.1** and npm **11.16.0**. Implementation commit `fbecd79` was cherry-picked without content changes before adding the English README updates and [public agent skill](../skills/sillage/SKILL.md). No application code or dependency changes were needed.

```sh
npm ci --ignore-scripts --offline --cache .npm-cache --no-audit --no-fund
npm test
npm run check
node --check test/ui.test.js
git diff --check
```

- **26 tests passed, 0 failed.** The first run exposed a pre-existing jsdom teardown race: a database save was observed before its asynchronous UI refresh completed. `test/ui.test.js` now waits for the rendered result before closing the document. The two UI tests also passed **10 consecutive runs** without late asynchronous rejections.
- Offline reinstall from the worktree-local cache, JavaScript syntax checks, and whitespace checks passed. The initial install populated that cache via the registry; runtime validation used only loopback and committed demo reports, without external credentials or a provider.
- Checked the README and skill against `package.json`, `src/server.js`, `src/store.js`, `src/render.js`, `public/app.js`, and `src/fake-agent.js`. Existing README shell examples and safety-limit text are unchanged. The skill's request/answer examples use the implemented v1 routes, original revision/block IDs, custom write header, exclusive leases, and idempotent terminal results.
- Ad hoc documentation checks used installed PyYAML to parse the skill frontmatter, Markdown-it to parse Markdown and check local links/heading anchors, and `bash -n` for shell fences. JSON fences parsed successfully. No dedicated Markdown linter or documentation-check script is configured in the project.
- Executed the skill's actual `curl` examples against a separate loopback service process, substituting only the configured port and returned IDs/tokens. Verified import, passage lookup, question retry, reservation, cited answer, identical-answer retry, and empty queue. Restarted that process with the same database and verified persistence; imported `examples/report-changed.md` and verified `needs_review` with the original context intact. An old-revision question in a closed thread still received a labeled fake-agent answer citing the original revision; the next fake-agent invocation reported idle. A separate request stored an explicit terminal failure. The test service was stopped afterward; all private artifacts remain under ignored `.data/public-docs/`.
- `chrome-devtools-axi` was not available in that public-documentation lane or the inspected Windows host tool installation. **That follow-up added no real-browser validation**; it retained the initial browser coverage limitations. The listener was never exposed beyond loopback.

## Material Darker Air / local-agent / live-revision iteration

Validation in the isolated `fm/sillage-ui-feedback-adjustments` worktree:

```sh
npm test
npm run check
git diff --check
```

- **37 tests passed, 0 failed** before delivery validation. All HTTP remains loopback, with disposable SQLite databases; no model, provider, external fetch, secret or reader report was used.
- New lifecycle tests exercise the actual JSONL bridge with separately supplied fixture replies, queue draining, active/unavailable states, explicit readiness, disconnect/EOF, heartbeat expiry, terminal deadlines, stale results, and service-restart recovery. A bridge process alone is not advertised as an agent. This validates transport, **not local-model inference**; an already-running fully local reasoner must be connected separately.
- New reader DOM tests cover hidden-by-default compact title/topic entries, toggle state, visible active/unavailable and connection instructions, literal untrusted worker/reply text, Ask question wording, live imports with no threads, French Markdown, safe-anchor scroll-offset calculation, unchanged-poll DOM identity, old-revision drafts and explicit review state, and preserved durable discussions.
- File-capability fixtures verify no disk observation before selection, read-only handle use, unchanged-content deduplication, automatic updates, stop, mismatching-file rejection, conflict pause and permission loss. Store tests exercise atomic compare-and-import against stale revision IDs. Ordinary file input fallback explicitly requires reselect/import; it is not falsely called watching.
- Static CSS assertions check readable prose width, narrow-screen stacking, horizontal table overflow, pointer and focus affordances. HTTP checks verify the fixed bundled SVG mark has only svg/rect/path elements, no active or external references, a local favicon/header use, no arbitrary report asset endpoint, same-origin CSP and protected lifecycle writes.
- Initial implementation validation used jsdom and static CSS checks, but the subsequent accepted delivery evidence in [the merged UI change](https://github.com/nicolascrop/sillage-axi/pull/2) records a real Chrome wide/narrow pass using `chrome-devtools-axi`: report import, queued question/unavailable state, compact Threads, active local-agent presence, a supplied cited answer, and reopening the durable thread. Chrome exposed a narrow question-bubble overflow; the merged fix and regression test use the usable client width. The recorded post-fix geometry is `viewport=390, clientWidth=390, scrollWidth=390, bubbleRight=378, overflow=false, threadsHidden=true, questionAction=Ask question`.
- That accepted Chrome evidence does **not** establish native File System Access permissions, live-update scroll anchoring, comprehensive accessibility, browser CSP enforcement, or local-model inference. The corresponding jsdom geometry/file handles remain controlled fixtures. Browser background throttling and editor file replacement can delay or interrupt explicit disk observation, as documented in the README.
- The single implemented direction is Material Darker Air. Plum & Amber is documentation only. No Yuba/Lavish files, second report, Delta translation, external provider or unrelated local-only capture surface was introduced.

## UI delivery validation follow-up

The subsequent validation recorded in [the existing UI follow-up](https://github.com/nicolascrop/sillage-axi/pull/3) extended the earlier UI evidence above:

- **40 tests passed, 0 failed** before delivery validation, using loopback and disposable databases without a model, external provider, secret or reader report.
- A real Chrome 148 pass through `chrome-devtools-axi` covered wide 1280×900 and narrow 390×844 layouts. It observed no horizontal overflow; the narrow question bubble measured 351px wide at x=12 inside a 375px usable client width. It also checked focusable passage affordances, the unavailable and active local-agent states, compact Threads after toggling, the Ask question wording, and a cited answer through the JSONL bridge. A local compare-and-import changed revision appeared automatically without reload, preserving the open answer and original quote while showing **Passage to review**. The secure loopback page exposed `showOpenFilePicker`, and the UI surfaced the explicit read-only connection path plus its fallback guidance. Browser background throttling and editor file replacement can still delay or interrupt explicit disk observation, as documented in the README.
- The browser accessibility snapshot exposed the Sillage AXI mark, local-agent state, import and Threads controls, focusable passages, and the **Ask question** action. Evidence screenshots and geometry were recorded under `/tmp/no-mistakes-evidence/01M236K1M6A33Q6JDXRBKNJP69/` during that validation, not this merge reconciliation.
- File-picker API availability and the connection UI do not prove native file permission/observation behavior. The supplied bridge answers validate transport and citations, not local-model inference; comprehensive accessibility and browser CSP enforcement remain outside the recorded pass.

## Stdio launch-command follow-up

Validated in the isolated `fm/sillage-stdio-command-followup` worktree, based on the merged UI default branch, with Node.js **v24.18.1** and npm **11.16.0**:

```sh
node --test test/stdio-command.test.js test/relay.test.js test/ui.test.js
npm test
npm run check
node --check test/stdio-command.test.js
node --check test/relay.test.js
node --check test/ui.test.js
git diff --check
```

- **16 focused tests and all 44 repository tests passed, 0 failed**; syntax and whitespace checks passed. Dependency installation used `npm ci --ignore-scripts --no-audit --no-fund --cache .npm-cache`; the tests and syntax checks afterward were offline, using only loopback and disposable databases.
- The four new documentation-contract tests failed on the old instructions, then passed after all public attachment paths switched to `node src/local-agent.js`. README, connection-guide and UI examples include `SILLAGE_URL=http://127.0.0.1:3211 node src/local-agent.js` for a nondefault loopback port. The npm script is retained only as a human-invocation convenience; its normal banner-producing form is not advertised for raw JSONL attachment.
- The UI test checks both displayed command forms. The actual direct Node subprocess test uses an ephemeral loopback port via `SILLAGE_URL`, parses every stdout line as JSON, and now checks the complete readiness/connect/request/save/stop sequence through stdio close. Fixture replies still validate transport and original citations, not model inference. No runtime protocol or local-only boundary changed.
- A focused Chrome run was subsequently completed for this command/documentation follow-up through the isolated `chrome-devtools-axi` session: the updated connection panel was inspected at 1440px and 390px, with the direct Node command, stderr separation, npm-banner warning, nondefault loopback example and local-only cautions visible; both viewports reported `clientWidth === scrollWidth`. This extends visual evidence only to the updated connection panel and does not claim model inference or broader browser coverage.

## Standalone icon proposal board

Validated in the isolated `fm/sillage-icon-gallery` worktree with Node.js **v24.18.1** and Chrome **148**, using the isolated `chrome-devtools-axi` session `sillage-icon-gallery`. This evidence concerns only [`proposals/icons.html`](../proposals/icons.html), not the reader or its earlier browser-coverage limitations.

```sh
npm test
npm run check
git diff --check
# Open proposals/icons.html directly as a file:// URL in Chrome; no server needed.
```

- **44 tests passed, 0 failed.** Four deterministic jsdom tests check exactly ten distinct named/labeled SVG candidates, matching 16/24/32 px geometry, all ten exclusive selections, status/preview/clear behavior, reload and restored-page reset, and absence of storage, requests, external references or reader integration.
- Chrome screenshots were inspected at **1440×1080** (five columns, two rows) and **390×844** (one column, all ten cards). No horizontal overflow; an additional **320 px** width check also stayed within the viewport. Small-size artwork and selected preview render directly from inline geometry.
- Native Tab/arrow navigation selected Margin note with visible focus and exclusive highlighting. Pointer selection selected Mooring; Clear choice removed the highlight/preview and returned focus to the first radio. An actual browser reload (`PerformanceNavigationTiming.type === 'reload'`) reset selection to zero. The accessibility snapshot exposes ten named radios with rationale descriptions and the live selection status.
- The browser pass caught SVG-specific issues not modeled by jsdom: assigning `SVGElement.hidden` did not reveal the selected preview, and same-file `<use>` references produced a file-origin error. The board now toggles the hidden attribute explicitly and uses inline geometry, with matching regression assertions. Final Chrome console: **no messages**. Network panel: **only the local HTML file**, no service or external asset requests.
- Local evidence remains gitignored under `.data/icon-gallery/`: `wide.png`, `wide-selected.png`, `narrow-full.png`, `narrow-selected.png`, `narrow-card.png`, plus DOM, console, network and command logs. No production logo, favicon, route, reader link, application setting or persistence behavior was changed. Other browsers, a screen reader and forced-colors mode were not manually exercised.

## Existing-branch merge reconciliation

Reconciled `fm/sillage-ui-feedback-adjustments` with `main` at `673a2f9` in an isolated worktree. Kept the direct Node stdio instructions and stronger JSONL regression checks, the standalone icon proposal board and its tests, and both branches' validation history. The resolved application, tests, dependencies and CI workflow are identical to that main revision; the remaining content differences are documentation clarifications and the later UI evidence above.

```sh
npm ci --ignore-scripts --offline --cache .npm-cache --no-audit --no-fund
node --test test/stdio-command.test.js test/relay.test.js test/ui.test.js test/icon-proposals.test.js
npm test
npm run check
git diff --cached --check
git diff --check
```

- Node.js **v24.18.1**, npm **11.16.0**: **20 focused tests and all 48 repository tests passed, 0 failed**; syntax and whitespace checks passed. Installation used the worktree-local cache; tests remained offline apart from loopback HTTP and used disposable databases.
- Full coverage retains managed-marker migration/restart ownership, legacy lease compatibility, original citations, no-silent-remap revisions, durable threads, live-update/file-capability fixtures, narrow bubble containment, and local asset/HTTP safety. No runtime behavior, local-only boundary or unrelated main work was removed.
- This reconciliation performed no new Chrome pass and does not expand the recorded browser evidence above. Final remote CI is a separate delivery gate, not claimed by these local results.

## AXI façade and minimum audit corrections — 2026-09-10

Implemented on `fm/sillage-axi-audit`, based on `982fb5ab7b2f71b58ca42c5f8a1f9a0eb1982172`,
**before the product identity migration**. Reference: [AXI](https://axi.md/) detailed guidance at
`7626619a2d42d63e8c666e84bb93d20cc47170a7` (2026-09-09), TOON specification v4.1,
and Lavish practices at `ca4c59d5b3ef84ae7f6f7f93fcaa415ade8a9c73` (2026-09-07).
This records local candidate evidence, not a claim of green remote CI or certification.
The delivery pipeline validates the committed candidate; CI now records its exact
`GITHUB_SHA` in the job summary rather than attributing old results to a new revision.

```sh
npm ci --ignore-scripts --offline --cache .npm-cache --no-audit --no-fund
npm test
npm run check
git diff --check
```

Node **v24.18.1**, npm **11.16.0**: **67 tests passed, 0 failed**. `check` covers
JavaScript syntax across runtime, executable, scripts, tests and UI, plus generated
skill freshness; it is not represented as lint or type checking. Runtime/test
operations are offline apart from loopback. Scratch databases and installations
remain under gitignored `.data/`; no reader data is a deliverable.

| Finding | Correction and regression evidence |
| --- | --- |
| F01 — no finite CLI | Real `sillage` bin, read-only home with content/queue/agent state, unavailable/empty/foreign-directory results, explicit serve/demo/attach. Tests execute the binary and an offline local npm installation outside the checkout; probes do not create databases or reserve work. |
| F02 — mutating discovery | All four entrypoints reject unknown input and exit naturally for help/version even with queued work and invalid runtime configuration. Strict per-command validation, structured stdout errors, 0/1/2 exits. Bare version paths are compared with a same-process Node baseline and checked not to load business dependencies. Legacy JSON demo and continuous JSONL ready/connect/request/save/stop contracts remain tested. |
| F03 — unbounded observation | Additive scoped HTTP projections, 3–4-field paginated lists and independent totals/counts. Zero/one/105-thread cases; invalid fields/parameters; exact revision lookup; bounded source/context/body/citation previews with sizes and conditional hints; Unicode/quotes/newlines round-trip and exact `--full`; unmatched provenance and closure/answer aggregates. Existing full v1 payloads stay unchanged. |
| F04 — uncertain imports | Optional durable operation keys and original-revision replay, conflicting payload/guard refusal, lost-ack simulation across restart and later revisions, four concurrent processes, deliberate new-key imports, old unkeyed repeats, unchanged HTTP 201 document shape. |
| F05 — no ambient discovery | Explicit scoped setup for Claude Code/Codex/OpenCode, tested idempotence, removal, repair, verified PATH/fallback, third-party preservation and invalid/unmanaged/symlink refusal. Hook execution emits availability only and does not consume questions or expose another directory. No home configuration, model launch or transcript capture. |
| F06 — nonportable skill | 3.3 KB generated skill sharing CLI safety/discovery text, standard frontmatter with extension metadata, no parent-relative references, copied-only install and relocated runtime tests, stale generation detected. The frozen Lavish strict frontmatter validator additionally returned `valid:true, errors:[]`. |
| F07 — insufficient evidence | All new contracts run with the existing security/store/relay/UI suite in CI; syntax and skill freshness are mandatory. Actual installation and relative version-path checks supplement the previous 48 tests. |

A focused Chrome **148** smoke through `chrome-devtools-axi` used a disposable
current-branch service and public example fixtures: report renders; asking through
the UI saves a waiting question with **local agent unavailable**; explicit CLI demo
produces the labeled **not an AI answer** reply; a CLI import updates the open reader
to revision 2 while its changed thread retains the original snapshot and says
**Passage to review**, never silently reattaching. At 1440px and 390px, document
`scrollWidth` equaled `clientWidth`; the narrow bubble stayed horizontally within
the viewport. The tested flow loaded no external resource and logged no console
messages. The scratch tab/server were closed; shared Chrome was not stopped.

**Limits and deliberate local-only adaptations:** native Claude Code/Codex/OpenCode
sessions and Windows shells were not exercised. Tests execute generated shell hooks
and the OpenCode plugin callback, not model inference. Codex requires the user's
explicit hooks feature flag; setup reports but does not enable this user-home setting.
The hook is a privacy-restricted availability home, not an ambient private-report
feed. General transcript/file capture is deliberately excluded: the local durable
question/answer lifecycle is the relevant memory. Setup preflights malformed configs
and replaces each file atomically, but a multi-file disk/permission failure can leave
a partial installation requiring repair. No new native file-picker, accessibility,
resource-isolation or external-model evidence is claimed beyond prior limitations.
No global exactly-once guarantee is made for reserve/connect/disconnect or inference.

## Sillage AXI identity migration — 2026-09-10

Validated in the isolated `fm/sillage-axi-rename` worktree after confirming the
canonical remote `git@github.com:nicolascrop/sillage-axi.git` and a clean `main`
base. `gh-axi repo view nicolascrop/sillage-axi` and
`gh-axi repo view nicolascrop/sillage` both resolved to the renamed public
repository `nicolascrop/sillage-axi`; GitHub's historical URL is therefore an
active redirect rather than a second repository. No external provider, package
publication or network fetch was used by the application/tests.

The [migration guide](migration-sillage-axi.md) owns the compatibility map and
preserved v1 invariants. The migration tests execute both command paths from
another directory for
`--help`/`--version`, assert that probes create no database, verify both npm
installation bins offline, and retain the historical direct Node entrypoints.
The full suite also exercises the unchanged HTTP, JSONL, schema, loopback and
local-only contracts:

```sh
npm ci --ignore-scripts --offline --cache .npm-cache --no-audit --no-fund
node --test test/rename.test.js test/cli.test.js
npm test
npm run check
node --check bin/sillage-axi.js
npm run skill:check
git diff --check
```

The commands above are the executable examples for the rename; runtime tests
use only loopback and disposable `.data/test/` databases. This section records
validation scope, not npm publication or remote CI status.
