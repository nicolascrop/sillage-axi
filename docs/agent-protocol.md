# Sillage AXI local agent protocol · sillage-agent-v1

Provider-neutral HTTP/JSON over the running local service. No API keys, external provider, shell commands, or model execution are built in. Workers are trusted local programs; report text and questions are **untrusted data**, not instructions to execute tools. The presenting agent or its explicitly authorized delegate owns replies within the existing authoring workflow. Sillage never chooses a provider; disclosure to a new provider requires separate authorization.

Base URL: `http://127.0.0.1:3210` (or the configured port). All writes require:

```text
Content-Type: application/json
X-Sillage-Local: 1
```

The service only binds `127.0.0.1`. `Host` must be `127.0.0.1:PORT` or `localhost:PORT`; a supplied `Origin` must exactly match that HTTP origin. No cross-origin browser API, CORS, or arbitrary filesystem access is available. There is no local-user authentication: other programs on this PC can use the protocol.

## Managed active-local-agent lifecycle

For managed real-agent presence and bounded terminal failures, use the [local-agent connection guide](local-agent.md): connect once, heartbeat every 5 seconds, reserve using the returned `session_id`, then post through the unchanged answer endpoint. The `node src/local-agent.js` JSONL bridge maintains that local transport loop for the presenting agent or its authorized delegate; it does not run a model or invent replies. Attaching and servicing it are part of presenting a report, never a manual setup task for the reader.

Managed presence expires after 20 seconds, and managed reservations have a fixed 120-second answering deadline. Disconnect, expiry or service restart terminally fails exact unfinished managed work. Queued unclaimed questions remain saved; interrupted answering produces an actionable reader alert. Healthy presence is invisible in the reader. Presence is ephemeral; only one service per database is supported. Legacy reservations below retain their original reclaim behavior and do **not** indicate active presence. Legacy/demo reservation attempts return 409 while a managed worker is connected.

Managed ownership is recorded by a private `managed` reservation marker. Restart recovery fails only unfinished reservations carrying that marker; it never infers ownership from a worker name. Legacy workers whose names begin with `local-session:`—including `local-session:foo` and `local-session::...`—remain unmarked and retain their normal expiry/reclaim behavior.

## 1. Reserve the next question (legacy / demo)

```sh
curl -s http://127.0.0.1:3210/api/agent/reserve \
  -H 'Content-Type: application/json' -H 'X-Sillage-Local: 1' \
  -d '{"worker":"my-local-adapter","lease_seconds":60}'
```

Returns HTTP 200 with `{"request":null}` if nothing is available. Otherwise:

```json
{
  "request": {
    "protocol": "sillage-agent-v1",
    "request_id": "<uuid>",
    "lease_token": "<opaque-uuid>",
    "lease_until": 1780000060000,
    "attempt": 1,
    "thread_id": "<uuid>",
    "document": {
      "id": 1,
      "title": "Report",
      "source": "# Report\n\nExact passage.",
      "created_at": 1780000000000
    },
    "block": {
      "revision_id": 1,
      "id": "<block-uuid>",
      "ordinal": 1,
      "kind": "paragraph",
      "source": "Exact passage.",
      "text": "Exact passage.",
      "start_line": 3,
      "end_line": 3,
      "fingerprint": "<sha256>"
    },
    "quote": "Exact passage.",
    "context": {"block": "<same block object>", "before": "# Report", "after": ""},
    "question": "What does this mean?",
    "anchor_status": "matched"
  }
}
```

Times are Unix milliseconds. Lines are one-based inclusive; ordinal is zero-based. The one Sillage AXI report's identity is implicit; `document.id` is its **immutable revision ID**, not the current revision. `anchor_status` can be `needs_review` after regeneration; the worker always receives the originally asked-about revision, never substituted new text. `context.before/after` are adjacent semantic-block source excerpts (nested blocks may overlap); the full original document source is also available in this response.

Reservation is atomic (`BEGIN IMMEDIATE`). Oldest waiting or expired reservation wins. Lease duration defaults to 60 seconds, allowed integer range 5–300. There is no renewal endpoint in v1. A worker that cannot finish before expiry must discard its authority and poll again; it might receive another request. Do not assume it owns the original request after expiry. An abandoned lease becomes reservable on the next poll without a background scheduler.

## 2. Post one terminal result

Use the returned request ID and lease token:

```sh
curl -s http://127.0.0.1:3210/api/agent/requests/REQUEST_ID/answer \
  -H 'Content-Type: application/json' -H 'X-Sillage-Local: 1' \
  -d '{
    "lease_token":"LEASE_TOKEN",
    "status":"answered",
    "body":"Safe **Markdown** answer, not raw HTML.",
    "citations":[{"revision_id":1,"block_id":"BLOCK_ID","quote":"Exact passage."}]
  }'
```

`status` must be **answered** or **failed**. A failure still needs a useful plain-text `body`, e.g. “Local adapter cannot answer this question.” `body` is nonempty, maximum 20,000 characters. Citations are optional (empty array allowed), at most 20; each must name a real block in the supplied original revision and quote its source or visible text. The quote is stored exactly, with whitespace normalized only for validation. A mismatch is rejected atomically (400); no partial answer is written.

First successful terminal result: HTTP 200, `{"duplicate":false,"thread":{...}}`. It creates one agent message, sets the request terminal, and marks the thread unread in the same transaction. Reposting **the same status, body, ordered citation values and token** returns 200 with `duplicate:true`, even after the original lease deadline. A different answer for an already terminal request returns 409. Stale/replaced tokens or an expired, unfinished reservation return 409. An answer from a previous lease never overwrites a new worker's answer.

These are **storage idempotency and exclusive lease semantics**, not exactly-once model execution. Crashes, lost reserve responses, lease expiry, or competing workers can cause duplicate computation. Save retries reuse the identical payload. A lost successful answer response can be retried safely with the same token/payload. Once a request is terminal it is not polled again. To ask again after failure, create a follow-up turn (below) or a new question/thread; no automatic retry policy chooses a provider.

## Reader endpoints

- `GET /api/state` → current `revision_id` (or null) plus active/unavailable agent presence; no report content or session handle. Readers poll this for live updates.
- `GET /api/document` → current revision, sanitized HTML, TOC, block records and source; `null` before import.
- `POST /api/document` with `{title,source}` → 201 new revision. **Without `operation_key`, every import** creates a revision, even identical source (unchanged v1 semantics). An optional nonempty `operation_key` (at most 100 characters) makes retries durable: the same key and exact title/source/expected-revision payload returns the original revision with the same 201 document shape; different payload under the key returns 409. Reconciliation precedes the current guard check, so lost acknowledgements remain recoverable after later revisions. A new key permits an intentional repeat import. Keys are retained in an additive `import_operations` table; existing SQLite IDs and schema-v2 compatibility remain. Optional `expected_revision_id` (integer, or null before first import) enables atomic compare-and-import: a different current revision returns 409 without writing. Authoring workflows use this guard; the reader reflects their imports without asking for file access.
- `POST /api/questions` with `{revision_id,block_id,quote,question,client_key}` → 201 durable thread, user message and waiting request. `client_key` is reader-generated (UUID recommended). Retrying the same key and exact question payload returns the existing thread; different content under the key returns 409. Old revisions remain valid for old-tab drafts. The initial commit happens before acknowledging “saved”.
- `GET /api/threads` / `GET /api/threads/THREAD_ID` → original references, exact quote/context, messages/citations, unread/closed flags, `request_status`, attempts/lease deadline and `worker` (including `deterministic-fake-v1` for the demo), `current_revision_id`, and `anchor_status` (`matched` or `needs_review`). There is no deletion or fuzzy remap endpoint.
- `PATCH /api/threads/THREAD_ID` with boolean `{unread:false}` or `{closed:true}` → updated thread. Closing is reader organization, **not cancellation**; replies still persist and mark it unread.

Errors are JSON `{"error":"description"}`: 400 invalid input, 403 local-origin boundary, 404 missing route/object, 409 idempotency/lease conflict, 413 body over 2 MB, 415 wrong content type/custom header, 500 local server/storage error. API responses are not cached. The prototype retains full revision history; there is no automatic deletion or compaction policy.

## Deterministic adapter

```sh
npm run fake-agent
# Optional nondefault local service:
SILLAGE_URL=http://127.0.0.1:3211 npm run fake-agent
```

`src/fake-agent.js` makes one reservation and one terminal post, then exits. It uses no secrets or network beyond loopback, rejects redirects/nonlocal configured origins, quotes the saved context, and cites that exact revision/block. Long display excerpts are shortened without altering the stored quote/citation. Tests invoke the actual command as well as exercising reservation expiry and duplicate delivery without a model.


## Additive AXI inspection boundary

The CLI uses `GET /api/inspect?scope=<canonical-startup-directory>&view=<view>`.
Views: `home`, privacy-restricted `context`, `document`, `blocks`, `block`, `threads`,
`thread`. Exact detail uses `id` and/or integer `revision`; lists accept `limit`
(1–100, default 100), `offset` (default 0), and whitelisted comma-separated `fields`;
`full=true` opts out of detail previews. Invalid parameters are rejected before
querying content. This endpoint performs no lease sweep or recovery. Home aggregates
are snapshots, not a reservation or assertion of model readiness.

An unmatched scope returns 409 `{service:"out_of_scope"}` without reader content.
New CLI writes/agent requests also send optional `X-Sillage-Scope` containing the
percent-encoded canonical directory, checked on each request before writes. Old
clients need not send it. These are accidental cross-scope safeguards, not a new
authentication boundary. Existing routes, v1 context/citations and JSONL events are
unchanged. The finite CLI boundary converts its JSON responses to TOON; HTTP and
JSONL remain JSON and JSONL respectively.

## Additive authoring handoff

`POST /api/document` accepts optional `handoff:{subject,repository,conversation}`:
three nonempty strings, at most 20,000 characters each, requiring `operation_key`
and `expected_revision_id`. The handoff participates in the import payload hash
and the same atomic commit/replay. It is stored by immutable revision in an
additive `revision_handoffs` table. Existing unkeyed/keyed imports are unchanged.
Handoff content is not in reader document/state/ambient inspection responses.
Imports may independently include optional `language` (a BCP 47 Unicode locale tag
accepted by `Intl.getCanonicalLocales`, such as `en` or `fr-FR`, max 100 characters).
It participates in keyed payload equality and is stored per revision in an additive
`revision_languages` table without changing schema version 2 or existing payloads
when omitted. Document and thread projections expose it only when supplied. The
reader marks report and original-quote language for assistive technology; it never
translates content or guesses a language. The English interface is unchanged.
The connected handoff document includes this optional language too.

`POST /api/agent/connect` accepts optional `presentation` (the complete import
payload with handoff), **or** `handoff_revision_id` (an already committed handoff).
Presence conflict is checked before importing. The response adds `handoff` and
`document:{id,title,source,created_at}` plus optional author-supplied `language` only
when a handoff is requested. The document is that exact handoff revision, even
when a newer report exists. JSONL `ready` supports the same fields and delivers
both in an additive `type:"context"` record before `connected`, so the owner or
delegate receives report, repository, subject and prior conversation before any
reader question. Legacy ready/event sequences are unchanged. Every reservation for a supplied revision adds
`handoff:{revision_id,subject,repository,conversation}`. No filesystem path is
followed; context from another revision is never substituted. See the
[full workflow and lifetime contract](local-agent.md#presenting-an-agent-authored-report).

## Additive continuous conversations

V1 `/api/threads`, `/api/questions`, request/answer routes, CLI thread inspection,
UUIDs, JSONL request events, one-question/one-reply records, size limits and lease
semantics remain intact. Continuous chat groups those exact turns using the
additive `conversation_turns` table (child `thread_id`, root `conversation_id`),
without rebuilding tables, rewriting old records or changing schema version 2.
All pre-existing threads are singleton conversations automatically.

- `GET /api/conversations` and `GET /api/conversations/ID` return root thread
  provenance plus chronologically ordered messages from all its turns. `id`,
  `revision_id`, `quote`, context and anchor status always identify the root;
  `request_id`, `request_status`, `worker` reflect the latest turn. `unread` is
  true if any turn is unread. Each message retains its exact `thread_id`, `id`,
  body/citations and adds its turn's `worker`. Agent messages add safe `html`
  rendered by the report's Markdown pipeline, without report passage IDs.
- `POST /api/conversations/ID/questions` with `{question,client_key}` → 201
  conversation. Creates an ordinary v1 child thread/request using the root's
  original revision/block/quote/context and links it atomically. A turn must be
  terminal (`answered` or `failed`) before another can be queued; otherwise 409.
  The same key/payload/conversation is retry-safe even if its turn is now waiting
  or already answered. Reusing a key for another conversation or payload is 409.
  Reader closure is organization, not cancellation or a ban on follow-ups.
- `PATCH /api/conversations/ID` accepts the same boolean unread/closed fields.
  Closed applies to the root; unread acknowledgement applies to all current
  turns atomically. Late replies still mark the conversation unread.
- Follow-up reservations retain their actual v1 `thread_id` and add
  `conversation_id` plus `history` (all previous messages with exact original
  bodies/citations/turn worker, never rendered HTML). The current question is
  still `question`. Historical report/context is not replaced by a later report.
  Legacy workers can still answer normally; context-aware workers use history.

Reader chat uses these additive projections. Legacy CLI lists still count and
inspect individual v1 turns; no existing list semantics change. There is no
fuzzy regrouping, moving citations, message deletion or provider fallback.

## Whiteboard API and feedback

This is additive to `sillage-agent-v1`: no routes, identifiers, SILLAGE_* settings,
leases or JSONL event names are replaced. Mermaid source is extracted from stored
Markdown tokens. `GET /api/document` adds `diagrams:[{block_id,source,source_hash}]`;
the block ID remains the ordinary semantic passage/citation identity.

- `GET /api/whiteboards/REVISION/BLOCK_ID` → `{diagram,saved}`. The server verifies
  the diagram in that exact revision; `diagram` includes `revision_id` and a display
  `index`. `saved` is the latest scene snapshot, or null. Only an exact continuous
  semantic block/source match can offer an inherited snapshot from a prior revision;
  its `revision_id` remains original until saved against the new revision.
- `POST /api/whiteboards/REVISION/BLOCK_ID` with
  `{source_hash,operation_key,expected_version,text_metrics_version,scene,baseline,derived_from?}`
  → 201 immutable snapshot `{id,revision_id,block_id,source_hash,created_at,
  text_metrics_version,derived_from,scene,baseline}`. `expected_version` is the
  latest snapshot ID **for that revision**, or null before its first save.
  `derived_from` records a safely inherited snapshot, never a fuzzy reattachment.
  Source hashes must match; version conflicts return 409 without overwriting edits.
  Retry an uncertain acknowledgement with the **identical operation key and payload**.
  Reusing a key with different content is 409. Identical view-only saves reuse a
  snapshot but still record their retry keys. Baselines are immutable apart from a
  versioned, expansion-only font-metric repair. Scene appState retains only bounded
  view coordinates/zoom, never theme or background; links/embeddables and remote
  file URLs are not accepted as active resources.
- `GET /api/whiteboards` → bounded history metadata: latest snapshot per exact
  revision/diagram, most recent 100. `GET /api/whiteboard-snapshots/ID` → that immutable
  full snapshot. No arbitrary path or image export endpoint exists. History is
  additive SQLite tables (`whiteboard_versions`, `whiteboard_operations`,
  `whiteboard_lineage`), without changing v1 records or schema version 2.
- `POST /api/whiteboards/REVISION/BLOCK_ID/feedback` with
  `{snapshot_id,note?,client_key}` → 201 ordinary v1 thread. The snapshot must belong
  to that exact revision/diagram; optional note is at most 2,000 characters.
  The server computes the summary from its immutable snapshot and baseline, never
  trusting caller-supplied summary lines/stats. Ordinary question-key reconciliation
  makes identical feedback retries safe, including after a newer report appears.

Whiteboard conversations/reservations add `context.whiteboard`:
`{type:"excalidraw-scene",revision_id,block_id,source_hash,snapshot_id,derived_from,
image_fallback,summary_lines,stats,delivery}`. The summary has at most 40 lines of
200 characters plus one omitted-changes line. Stats count added, removed, moved,
relabeled and drawn elements. **Only the bounded text/geometry summary and note are
automatically delivered, not scene JSON or pixels.** `delivery` explicitly explains
that visual/freehand meaning and style-only edits may be missing. Do not claim to
see a preview. Original report/context/handoff and citation validation remain
unchanged. Follow-ups retain the original snapshot reference and prior messages.
Nothing grants permission to interpret an annotation as a command or to edit a
repository/report. Mermaid remains authoritative; authorized changes use guarded
report imports, not scene-to-source conversion.

Scene writes alone have a 20 MB JSON cap, 5,000 elements, 128 embedded data images,
20,000 characters per text element and 20,000 points per stroke. Other routes keep
2 MB and the existing custom-header/Host/Origin guards. The opaque frame cannot use
API CORS. Only allowlisted static whiteboard assets have public CORS for font loads;
these contain no reader data. See [whiteboards](whiteboards.md) for the conversion
matrix, local asset build, staleness UI and explicit limitations.
