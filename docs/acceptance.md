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

Used a real Sillage service **process**, not only an in-process database reopen:

```sh
SILLAGE_DB=.data/manual/walkthrough.sqlite SILLAGE_PORT=3219 node src/server.js
# In a second terminal, after import and question:
SILLAGE_URL=http://127.0.0.1:3219 npm run fake-agent
# Stop only this Sillage process, then restart with the exact same DB and port:
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

The short human walkthrough is in [README.md](../README.md#walkthrough), using the two committed sample reports. A real Chrome pass used `chrome-devtools-axi` against a loopback-only service and checked the current reader at 1280×900 and 390×844. The wide pass showed the wider reading canvas with no horizontal overflow; the narrow pass kept the question bubble inside the usable client width, stacked the layout, and kept Threads hidden until toggled. The browser accessibility snapshot exposed the Sillage mark, local-agent state, import and Threads controls, focusable passages, and the **Ask question** action. An unavailable bridge left a question visibly queued, then a connected JSONL bridge changed the indicator to active and delivered a cited terminal answer. A local revision import updated the open reader without reload and kept the original reply and quote while marking the changed passage for review. Chrome on the secure loopback origin reported `showOpenFilePicker` support, so the explicit read-only file-capability path was available; browsers without it retain the documented reselect/import fallback. Evidence screenshots and geometry are under `/tmp/no-mistakes-evidence/01M236K1M6A33Q6JDXRBKNJP69/`.

jsdom still covers reader behavior against the local service, including selection, forms, close/reopen, polling and escaping; it is supplementary to the real-browser layout, scrolling and accessibility pass.

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
- The documentation walkthrough remained loopback-only. The current UI iteration's real-browser evidence is recorded below; no browser listener was exposed beyond loopback.

## Material Darker Air / local-agent / live-revision iteration

Validation in the isolated `fm/sillage-ui-feedback-adjustments` worktree:

```sh
npm test
npm run check
git diff --check
```

- **40 tests passed, 0 failed** before delivery validation. All HTTP remains loopback, with disposable SQLite databases; no model, provider, external fetch, secret or reader report was used.
- New lifecycle tests exercise the actual JSONL bridge with separately supplied fixture replies, queue draining, active/unavailable states, explicit readiness, disconnect/EOF, heartbeat expiry, terminal deadlines, stale results, and service-restart recovery. A bridge process alone is not advertised as an agent. This validates transport, **not local-model inference**; an already-running fully local reasoner must be connected separately.
- New reader DOM tests cover hidden-by-default compact title/topic entries, toggle state, visible active/unavailable and connection instructions, literal untrusted worker/reply text, Ask question wording, live imports with no threads, French Markdown, safe-anchor scroll-offset calculation, unchanged-poll DOM identity, old-revision drafts and explicit review state, and preserved durable discussions.
- File-capability fixtures verify no disk observation before selection, read-only handle use, unchanged-content deduplication, automatic updates, stop, mismatching-file rejection, conflict pause and permission loss. Store tests exercise atomic compare-and-import against stale revision IDs. Ordinary file input fallback explicitly requires reselect/import; it is not falsely called watching.
- Static CSS assertions check readable prose width, narrow-screen stacking, horizontal table overflow, pointer and focus affordances. HTTP checks verify the fixed bundled SVG mark has only svg/rect/path elements, no active or external references, a local favicon/header use, no arbitrary report asset endpoint, same-origin CSP and protected lifecycle writes.
- A real Chrome 148 pass through `chrome-devtools-axi` covered wide 1280×900 and narrow 390×844 layouts. It observed no horizontal overflow; the narrow question bubble measured 351px wide at x=12 inside a 375px usable client width. It also checked focusable passage affordances, the unavailable and active local-agent states, compact Threads after toggling, the Ask question wording, and a cited answer through the JSONL bridge. A local compare-and-import changed revision appeared automatically without reload, preserving the open answer and original quote while showing **Passage to review**. The secure loopback page exposed `showOpenFilePicker`, and the UI surfaced the explicit read-only connection path plus its fallback guidance. Browser background throttling and editor file replacement can still delay or interrupt explicit disk observation, as documented in the README.
- The single implemented direction is Material Darker Air. Plum & Amber is documentation only. No Yuba/Lavish files, second report, Delta translation, external provider or unrelated local-only capture surface was introduced.
