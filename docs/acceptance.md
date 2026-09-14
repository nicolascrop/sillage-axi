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

That original version kept Excalidraw as an explicit unsupported, source-preserving block. Direct `excalidraw` fences still do; report Mermaid now uses the local editor described in the whiteboard evidence below and [whiteboard contract](whiteboards.md). No unsafe raw HTML/SVG embed was added. See the [current reader walkthrough](../README.md#walkthrough) and [continuous conversation contract](agent-protocol.md#additive-continuous-conversations) for the additive chat model, conservative unmatched behavior and provider policy.

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

## Context handoff and reader chat — browser recovery

Validated in the isolated `fm/sillage-reader-chat-context-browser` worktree with
Node **v24.18.1** and local Headless Chrome **153**, through `chrome-devtools-axi` attached
to the existing loopback Chrome. The preserved implementation patch and handoff
suite were restored only after their SHA-256 checks passed; the browser correction
is a separate follow-up, not a replacement of that implementation.

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test test/ui.test.js
npm test
npm run check
git diff --check
```

- **75 tests passed, 0 failed.** Runtime tests use loopback and disposable SQLite
  databases. Existing HTTP/JSON/JSONL v1, lease/timeout/restart, semantic-ID,
  historical executable/variable/route aliases, CLI scripts, input limits and
  local-boundary suites remain passing. Additive handoff/conversation tests cover
  revision-bound context, guarded replay, continuous polling and follow-up history.
- Chrome reproduced an idle-poll defect: unchanged polling replaced native thread
  options and redundantly mutated labels, highlighting and alert attributes every
  two seconds, invalidating even freshly captured accessibility references. An
  actual `MutationObserver` recorded eight mutations in an otherwise unchanged
  draft. Rendering now preserves unchanged conversation UI and independently
  updates real presence alerts. The new executable DOM regression failed before
  the fix and passes afterward, checking option identity, focus, draft retention
  and real listening-loss alerts. Chrome subsequently measured **zero idle
  mutations**, with the same option node retained.
- Real screenshots and accessibility snapshots cover **1440×1000** wide and
  **390×844** narrow: distinct right-hand chat (stacked below on narrow), Markdown
  heading/bold/list/code, native one-line thread dropdown and keyboard choice,
  follow-up chronology, explicit citation navigation, and Contents expanded and
  collapsed at both widths. Native controls were driven from a new snapshot before
  each interaction, never by reusing a reference after a DOM/page change.
- Targeted browser `Range` selections crossed inline bold formatting: the saved
  quote `water for young trees` retained revision 1, paragraph lines 7–7, full
  passage/neighbors and original block ID. A narrow draft quoted `young trees
  during dry weeks`. Closing populated local drafts by × and Escape was silent
  and created no additional conversation. Selection was controlled through the
  browser DOM; this does not claim native touch-selection coverage.
- Wide document `clientWidth === scrollWidth === 1425`; narrow both **375** (the
  scrollbar reduces usable width). Narrow bubble x=12, width=351, right=363:
  no horizontal overflow. Native thread menu screenshots and the selected
  four-message conversation confirm actual thread switching, not just markup.
- A supplied synthetic orchard fixture performed the real JSONL ready/context/
  connected/request/answer/saved loop, including a second request with original
  handoff and previous turns. A stopped/reopened service on the same database
  retained two conversations, three v1 turns, six messages, quotes, citations and
  handoff. Ending the fixture respondent's input while leaving the service alive
  produced the actionable “Replies are paused” alert; normal presence was hidden.
- Before intentional lifecycle interruption, Chrome console had **no messages**;
  all 259 recorded browser requests used the same `127.0.0.1` origin. No external
  model, cloud, secret, telemetry, WebSocket or LAN listener was added. Supplied
  answers prove transport/context delivery, **not inference or understanding** by
  a real model. Touch input, screen readers and exhaustive browser/CSP behavior
  remain outside this pass.

Evidence stays gitignored under `.data/chat-evidence/`: wide/narrow reader,
Markdown, native menu, quote, Contents and listening-loss PNGs; snapshots and
geometry; before/after poll diagnostics; JSONL logs and SQLite reopen observations;
full tests/check logs. `preserved/` retains the earlier partial browser evidence
without treating it as this pass's proof. No reader database/report is committed.

## C.L.E.A.R. reader corrections and author-owned handoff — 2026-09-11

Candidate implementation in `fm/sillage-uiux-clear-review-retry`, based on
`374e11f88ae4d22191e1397c87939c8da4d1ec17`. The separate visual review reproduced
crushed table columns, an off-screen question action, and off-screen save feedback
at 1440×1000 and 390×844. The selected product choices are **English UI** and
**Contents initially collapsed on narrow screens**, without a saved preference.

```sh
npm test
npm run check
git diff --check
# Optional real layout regression; configure chrome-devtools-axi with an existing
# local Chrome and an installed local MCP first. No browser install is performed.
CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9223 \
CHROME_DEVTOOLS_AXI_SESSION=your-verified-session npm run test:browser
```

- **84 tests passed, 0 failed**, using Node 24 and disposable local databases.
  New DOM regressions execute the real reader against loopback HTTP: narrow
  initial Contents state, visible empty selection, actual-height dialog placement,
  explicit saved-question navigation without silent report scrolling, readable
  quote presentation with byte-preserved source, full-question conversation
  selection, and author-supplied content language across revisions. Initial
  narrow-state, dialog-placement and readable-quote assertions failed before
  their fixes. Existing idle-poll identity, retries, safe anchors, close/reopen,
  failure/deadline, persistence and compatibility tests remain passing.
- The authoring agent or its explicitly authorized delegate owns the local bridge
  as part of presenting any report; no separate reader-configured reasoner is
  required. The actual JSONL handoff test delivers repository, subject, prior
  conversation **and the exact report before the first reader question**, answers
  two successive turns, and reattaches a delegate to the original revision after
  a later import. Model/provider selection and transcript/file capture are absent.
  Earlier references above to a separately configured fully local reasoner are
  historical; the current provider-agnostic ownership contract is in
  [the connection guide](local-agent.md).
- Optional `language` metadata is validated, guarded by keyed import equality,
  durable and revision-bound. Missing language is not guessed or translated.
  The English interface, exact source/citations, v1 route names and schema version
  remain unchanged; metadata uses an additive table.
- `npm run test:browser` is an **opt-in executable geometry regression**, not a
  source/CSS string check and not part of offline `npm test`. It uses only
  `chrome-devtools-axi`, lists pages, creates its own disposable report page and
  explicitly selects its ID before snapshots/interactions. It cleans up its own
  page/server and leaves shared Chrome alone. A local run passed at **1440×1000,
  390×844 and 320×844**, checking readable horizontally scrolling table cells,
  whole-dialog and send-button visibility, on-screen confirmation/navigation,
  one scrolling history with a visible wide follow-up, page-only narrow history,
  citations, Escape/Enter/close behavior, and an on-screen real listening-loss
  alert while scrolled into the report. Healthy presence is hidden.
- PNG evidence was inspected under `.data/test/clear-browser-4166891/` and earlier
  `.data/test/clear-browser-4097412/`: wide answer/start/composer, narrow first
  reading screen, table, full question form and listening-loss alert. These are
  disposable synthetic fixtures, not reader data or model inference. The optional
  test generates its own new evidence directory each run.

Limitations: layout checks exercise real Chrome but some interactions are DOM
clicks through DevTools, not a touch device. The visual viewport handler also has
controlled resize coverage; a physical virtual keyboard, screen readers, forced
colors, exhaustive zoom/browser coverage and model understanding are not claimed.
The generated skill remains under its 5,000-character installation contract.
No external provider, automatic remote fetch or new filesystem authority is added.
Remote delivery/CI validation is a later, separate gate.

## Focused agent-chat clarity — 2026-09-11

Candidate work in isolated `fm/sillage-agentic-chat-ux`. The supplied
[Zed reference](https://zed.dev/img/agentic/posters/review-poster.webp) was visually
inspected in Chrome: side-by-side reading, clear turns, compact context and an
obvious composer informed the hierarchy, not branding, editor tools or providers.

```sh
npm test
npm run check
git diff --check
CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9223 \
CHROME_DEVTOOLS_AXI_SESSION=your-verified-session npm run test:browser
```

- **92 tests passed**, including 25 executable reader DOM tests against real
  loopback HTTP. New regressions cover waiting/reserved/failed/answered guidance,
  editable waiting drafts, terminal-only keyboard submission, exact retry/history
  and original revision context. New turns append without replacing previous
  messages, open citations, table positions or focused source controls.
- Two regressions were run against the previous reader and failed: it replaced
  existing message nodes (losing disclosure/focus state), and answer arrival
  scrolled a narrow reader away from the report. They pass with this change.
  Automatic page navigation now requires the latest turn to be visible and no
  active report draft/passage focus; otherwise **View latest reply** is explicit.
- The expanded opt-in browser test passed in local Chrome 153 via
  `chrome-devtools-axi` at **1440×1000, 1280×720, 390×844 and 320×844**. It checks
  no horizontal page overflow, narrow Contents initially collapsed, visible
  question/save actions, one wide history scroll, page scrolling in narrow/short
  windows, expanded-context containment, citations, retained focus, native
  Ctrl+Enter submission and continuous turns. A supplemental 1280×720 inspection
  reproduced an expanded-context/composer overflow; flexible context and the
  short-window page-scrolling fallback keep the controls reachable.
- Browser fixtures now own the real JSONL ready/context/connected/request/answer/
  saved loop. Each width sends a question and a follow-up, verifies the exact
  handoff, prior turns, quote and revision delivered to the respondent, and keeps
  a waiting draft until the reply finishes. Disconnecting during a final turn
  produces an honest saved failure and author-owned recovery guidance; reopening
  the page retains all six messages of that conversation and original context.
  These are supplied synthetic replies, **not model inference** or reader setup.
- Screenshots were inspected under `.data/test/chat-browser-1186812/`; baseline
  reference/reader evidence and command logs are in `.data/agentic-chat/`. Final
  Chrome console was empty; the recorded post-reopen network list contains only
  same-origin loopback resources. These ignored artifacts contain fixtures only.
  No production protocol, storage schema, configuration, aliases, provider,
  telemetry, WebSocket or exposure boundary changed.

Limitations remain: no physical touch keyboard, screen-reader session, exhaustive
zoom/browser coverage or model-understanding claim. The optional Chrome test is
not part of offline `npm test`. Remote delivery and CI are separate later gates.

## Delta edge-to-edge workspace recovery

Candidate implementation on `fm/sillage-delta-presentation-recovery`, in an isolated
worktree. The supplied partial patch was reviewed and applied to the current
HTML/CSS, then completed with reader navigation, scroll ownership, icon state and
notification behavior. The [Zed reference](https://zed.dev/img/agentic/posters/review-poster.webp)
was inspected through `chrome-devtools-axi`; its split workspace informed the
layout, not its tools, provider controls or branding.

```sh
npm test
npm run check
git diff --check
CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9223 \
CHROME_DEVTOOLS_AXI_SESSION=your-verified-session npm run test:browser
```

The current layout supersedes the page-scrolling narrow/short fallback described
in earlier evidence above. Chat now meets the header, viewport bottom and right
edge without an inset card. The report scrollbar borders it directly. Narrow
screens explicitly switch Report / Chat; short screens scroll the entire chat
rather than clipping its composer. English UI and initially collapsed Contents
are retained, now at every width. Original revisions, exact source snapshots and
citations remain available in disclosures, not repetitive primary labels.

- Executable reader DOM regressions cover pane switching, resize/focus behavior,
  Contents and skip-link navigation, source icons, retained drafts, icon accessible
  names and saving/retry feedback. Existing exact-history/retry/error, conservative
  revision and idle-poll identity tests remain in place.
- New reply acknowledgement uses the existing v1 per-turn PATCH route, only for
  immutable agent turns in the displayed snapshot. An executable race test saves
  another answer during acknowledgement and verifies it stays indicated. Opening
  the Chat pane alone never marks a reply read. Reload preserves acknowledged state.
- Chrome exposed that a hidden report returns `scrollTop === 0`, even when it
  restores the prior position on ordinary view switching. A workflow update while
  hidden would therefore discard that position. The reader now keeps its saved
  offset explicitly; a controlled DOM regression models this real browser behavior.

Browser results and remaining limitations are recorded with the final candidate
validation below. All runtime fixtures use disposable SQLite and loopback
HTTP/JSON/JSONL, without a model or any change to provider ownership, persistence,
configuration names, historical aliases, routes or exposure boundaries. Temporary
artifacts remain gitignored under `.data/`; no reader data is committed.

Final local candidate validation used Node **24.18.1** and existing loopback
Chrome **153**, via an isolated `chrome-devtools-axi` session:

- **96 tests passed**, including **29 reader DOM tests**. `npm run check` and
  `git diff --check` passed. These commands remain offline after dependency setup.
- `npm run test:browser` passed at **1440×1000, 1280×720, 390×844, 320×844 and
  844×390**. Geometry asserts chat top equals header bottom, chat bottom/right
  equal viewport edges, zero radius/shadow, no global overflow, and adjacent
  report/chat boundaries when wide. At 1440px the boundary is **x=1008** and the
  chat extends to **x=1440**, from **y=113** to **y=1000**. Report/chat scroll
  independence is checked in both directions; native PageDown scrolls only chat.
- The same browser flow covered report-first save confirmation, narrow pane/scroll
  retention, the then-current visible 44px send icons with accessible names,
  actual Ctrl+Enter submission, safe original citations, expanded-context
  containment, retained disclosures/focus across replies, and
  queued/draft/failed/reloaded history via the real author-owned JSONL handoff.
  The unified-composer follow-up below records the current 32px send target.
  Short-window question bubbles scroll to their action; short-window chat
  scrolls to its composer with no page movement.
  Visible and hidden report revisions retain safe/approximate positions without
  moving chat. Final browser console was empty; recorded requests were loopback.
- Screenshots and geometry were inspected in
  `.data/test/chat-browser-1879786/`, including wide/narrow answers, 320px
  report-first layout, short-window composer and live revisions. A supplemental
  final-code pass at **2560×1000, 800×900 and 320×480** verified edge bounds,
  no global overflow, intermediate Contents overlay/Escape and keyboard-reachable
  send controls while replies were paused. Its screenshots and geometry are in
  `.data/delta/`; console was empty. No shared browser or reader service was stopped.

These are synthetic transport/layout fixtures, **not model inference**. Native
PageDown, Ctrl+Enter and Escape supplement DOM-driven clicks; physical touch,
virtual keyboards, screen readers, forced colors, exhaustive zoom and other
browsers remain unverified. Chrome validation is opt-in, not part of offline CI's
`npm test`. No publication, remote CI or merge is claimed by this local evidence;
the committed branch proceeds through the separate no-mistakes delivery path.

## Inline Mermaid / Excalidraw whiteboards — 2026-09-14

Candidate implementation on isolated `fm/sillage-excalidraw-flowcharts`. Lavish
AXI **0.1.45** at `7c64184adce8b2b18c1cb072779305303b8079d9` was inspected before
implementation: SDK embedding, chrome/fullscreen teardown, frame conversion,
font repair, source extraction, sidecar persistence, build/pins and browser tests.
The [whiteboard contract](whiteboards.md) records the exact conversion matrix and
Sillage's SQLite/provenance, opaque-frame and bounded-agent-delivery adaptations.

```sh
npm test
npm run check
git diff --check
# Existing, authorized loopback Chrome; no browser download or reader setup.
CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9223 \
CHROME_DEVTOOLS_AXI_SESSION=your-verified-session npm run test:whiteboards:browser
```

- Node **24.18.1**, npm **11.16.0**: **122 tests passed, zero failed**. Build, unit,
  integration, SQLite reopen, HTTP, JSONL and executable reader DOM checks run
  offline after dependency installation, with disposable databases. Syntax and
  generated-skill freshness checks pass. Existing v1 aliases, lease/retry, exact
  source/citations, conservative semantic reconciliation, report/chat and
  initially collapsed Contents checks remain passing.
- New deterministic checks cover exact diagram token/block identity; changed and
  ambiguous-source rejection; immutable baseline and historical snapshots;
  optimistic concurrency; durable operation-key retries (including view-only
  writes); original-revision feedback and follow-ups; bounded summaries; font
  repair ordering/expansion; duplicate edge IDs; scene size/type/resource limits;
  rejected frame/API spoofing; and narrowly allowlisted opaque-origin font assets.
- Real **Chrome 153.0.8010.36**, through `chrome-devtools-axi`, passed the synthetic
  author-owned JSONL presentation/request/answer/saved flow. Every fixture report
  fence gets an inline scene. Subgraph flowchart, parallel edges, sequence, class,
  ER and state diagrams produced native shapes, not image regressions; Mermaid
  node `A` remained stable even with duplicate upstream edge IDs. Pie produced a
  clearly labeled local image that accepted a real text annotation, saved and
  reloaded. Its image-fallback disclosure remains present after adding shapes.
  Malformed input instead keeps escaped original source and an explicit failure.
- Browser interactions cover the initial inert view/scroll mode; pointer
  hit-testing outside the iframe; independent report/chat scrolling; native
  PageDown; explicit annotation; real Excalidraw text editing; enlarged editing;
  Escape from inside the frame returning to locked reading after flush; save and
  reload; historical scene reopening; and feedback/citation identities checked
  against SQLite and the actual authorized JSONL request. Feedback contains the
  original report/block/source hash, immutable snapshot and bounded summary, not
  scene JSON or pixels. Fixture replies are supplied text, **not model inference**.
- A workflow import during annotation keeps the original editor with a visible
  stale-revision banner. Finishing annotation converts the changed source into a
  separate scene; the old edits remain in history and the original cited thread
  becomes **passage to review**, never silently reattached.
- Screenshots were inspected at **1440×1000**, **390×844** and **320×844**. Narrow
  Report/Chat behavior is preserved; document width equals scroll width, inline
  frames remain inside the reader, and enlarged surfaces fill exactly 390/320 by
  844 pixels with annotation/feedback/close controls available. Explicit viewport
  emulation is necessary because headed Linux Chrome clamps native window width.
- Browser offline emulation leaves the editor usable and exposes failed autosaves.
  **Retry save / reconnect** persists the exact pending edits after reconnection.
  The real iframe rejects same-service parent DOM access with **SecurityError**.
  The paginated retained network log for the final offline/reconnect fixture
  contains only loopback requests, including local bundle/font bytes. Its console
  contains expected offline failures plus browser deprecation/form-field issues,
  not remote-font fallback failures. This is not an exhaustive hostile-document
  CSP audit, nor a claim that Chrome's own background traffic is application traffic.

Final browser evidence is gitignored under `.data/test/whiteboard-browser-229568/`:
wide/narrow/enlarged, stale/history, conversion matrix, image-annotation reload and
pending-save screenshots; `result.json`, network and console observations; synthetic
SQLite. The preceding full pass is in `.data/test/whiteboard-browser-189282/`.
The script selects its unique fixture page freshly before actions and cleans up
its own page/service, never shared Chrome. Hardware wheel/touch gestures are not
claimed: report scrolling uses the documented DevTools `eval` path and native
PageDown because the AXI scroll wrapper is unavailable. Screen readers, physical
virtual keyboards, other browsers, font coverage for every glyph and model
understanding remain unverified. Browser validation is opt-in, not part of offline
CI. No publication, remote CI or merge is claimed by this local candidate evidence;
delivery follows the separate no-mistakes gate.
## Unified question composers and single conversation finder — 2026-09-14

Candidate on isolated `fm/sillage-delta-live-presentation`, based on `10e9f87`.
The review explicitly requested **caret-only textarea focus**, with no replacement
border or halo. This applies to both the initial-question popover and the chat
follow-up, not to buttons, report passages or navigation focus indicators.

```sh
node --test test/ui.test.js
npm test
npm run check
git diff --check
CHROME_DEVTOOLS_AXI_BROWSER_URL=http://127.0.0.1:9223 \
CHROME_DEVTOOLS_AXI_SESSION=your-verified-session npm run test:browser
```

- **98 tests passed**, including **31 executable reader DOM tests** against real
  loopback HTTP. The new finder/initial-composer regressions failed before the
  change: duplicate select/Actions controls remained, and initial questions lacked
  the shared accessible send state. They pass afterward. Keyboard shortcuts now
  work within either form, including a focused retry button when the exact saved
  payload locks its textarea; plain textarea Enter and IME composition do not send.
- The single **Find a conversation** disclosure occupies the right side of the Chat
  header. Full questions, passage previews and the current choice remain available;
  selecting returns keyboard focus to the finder. Escape dismisses it. Idle polls
  preserve its choices/focus. A regression opens a historically closed conversation
  and verifies unchanged messages/context/closed status: removing reader closure
  controls does not remove or mutate the existing CLI/API storage capability.
- Initial and follow-up forms share typography, spacing, dark surfaces, a **16px
  send icon in a transparent 32px target**, accessible name/title, required input,
  Ctrl/⌘+Enter, saving/disabled/retry states, and exact-payload retry semantics.
  Source snapshots, original citations, unread race handling and independent
  report/chat scrolling remain covered by the existing behavioral suites.
- Real Chrome layout checks passed at **1440×1000, 1280×720, 390×844, 320×844 and
  844×390**. Added assertions inspect *computed styles and actual geometry*, not
  CSS source strings: caret color, absent textarea outline and textarea/form borders/halos,
  identical composer font/spacing/colors, small transparent send targets, and
  unclipped finder placement. Native Enter/Tab/Enter operates the header finder;
  native Ctrl+Enter sends both initial and follow-up questions. The first parity
  check exposed inherited 21.6px versus 20.4px line-height; shared composer font
  sizing fixes it. Screenshots confirm the restrained treatment at wide/narrow
  sizes, while the full existing geometry/history/handoff regression also passes.

Fixtures are synthetic and use disposable `.data/test/` databases; browser control
uses only `chrome-devtools-axi` with an explicitly selected existing local Chrome.
No reader report/database or screenshots are committed. The captain closed the
separate live Delta presentation before this implementation validation; it was not
restarted or used as a test fixture. No runtime provider, API/schema, historical
alias, or loopback boundary changed. Physical touch/virtual keyboards, screen-reader
sessions, forced colors and comprehensive accessibility certification are not
claimed. Remote publication/CI are separate no-mistakes gates, not these local tests.

## Compact Contents disclosure — 2026-09-14

- `npm test`: Node's test runner reported **tests 125, pass 125, fail 0**; `npm run check`
  and `git diff --check` pass. The count includes generated/parameterized cases,
  rather than only top-level test declarations.
  The Contents DOM regression exercises stable labelling, synchronized expanded/
  hidden state, polling, unchanged report nodes, Escape focus return and heading
  navigation across both responsive breakpoints. It failed on the original UI's
  missing icons before the change.
- `test-support/contents-browser.js`, also called by `npm run test:browser`, checks
  actual geometry, the accessibility tree, the state-dependent chevron, native
  Tab/Enter/Space/Escape, a 44px-high target, and side-panel versus overlay layout.
  Viewport emulation avoids headed Chrome's minimum window width masking mobile
  regressions. The check failed against the original UI's absent chevron.
- This pass ran that helper in the approved local Chrome against a synthetic
  `file://` fixture executing the reader's HTML, CSS and JavaScript with stubbed
  read-only API responses; no second Sillage service was started. Checks passed at
  **1440×1000, 1000×720, 901×844, 900×844, 701×844, 700×844, 390×844, 320×844 and
  844×390**. Local screenshots/logs remain gitignored in
  `.data/test/contents-preview/`. The full HTTP-backed browser suite was not rerun
  for this pass; physical touch and screen-reader sessions are not claimed.
