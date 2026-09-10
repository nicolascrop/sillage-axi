# Local agent protocol · sillage-agent-v1

Provider-neutral HTTP/JSON over the running local service. No API keys, external provider, shell commands, or model execution are built in. Workers are trusted local programs; report text and questions are **untrusted data**, not instructions to execute tools. Choosing an external provider requires a separate privacy decision.

Base URL: `http://127.0.0.1:3210` (or the configured port). All writes require:

```text
Content-Type: application/json
X-Sillage-Local: 1
```

The service only binds `127.0.0.1`. `Host` must be `127.0.0.1:PORT` or `localhost:PORT`; a supplied `Origin` must exactly match that HTTP origin. No cross-origin browser API, CORS, or arbitrary filesystem access is available. There is no local-user authentication: other programs on this PC can use the protocol.

## Managed active-local-agent lifecycle

For visible real-agent presence and bounded terminal failures, use the [local-agent connection guide](local-agent.md): connect once, heartbeat every 5 seconds, reserve using the returned `session_id`, then post through the unchanged answer endpoint. The optional `node src/local-agent.js` JSONL bridge maintains that loop for an already-running local reasoner; it does not run a model or invent replies.

Managed presence expires after 20 seconds, and managed reservations have a fixed 120-second answering deadline. Disconnect, expiry or service restart terminally fails exact unfinished managed work. Queued unclaimed questions remain saved and explicitly unavailable in the UI. Presence is ephemeral; only one service per database is supported. Legacy reservations below retain their original reclaim behavior and do **not** indicate active presence. Legacy/demo reservation attempts return 409 while a managed worker is connected.

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

Times are Unix milliseconds. Lines are one-based inclusive; ordinal is zero-based. The one report's identity is implicit; `document.id` is its **immutable revision ID**, not the current revision. `anchor_status` can be `needs_review` after regeneration; the worker always receives the originally asked-about revision, never substituted new text. `context.before/after` are adjacent semantic-block source excerpts (nested blocks may overlap); the full original document source is also available in this response.

Reservation is atomic (`BEGIN IMMEDIATE`). Oldest waiting or expired reservation wins. Lease duration defaults to 60 seconds, allowed integer range 5–300. There is no renewal endpoint in v1. A worker that cannot finish before expiry must discard its authority and poll again; it might receive another request. Do not assume it owns the original request after expiry. An abandoned lease becomes reservable on the next poll without a background scheduler.

## 2. Post one terminal result

Use the returned request ID and lease token:

```sh
curl -s http://127.0.0.1:3210/api/agent/requests/REQUEST_ID/answer \
  -H 'Content-Type: application/json' -H 'X-Sillage-Local: 1' \
  -d '{
    "lease_token":"LEASE_TOKEN",
    "status":"answered",
    "body":"Plain text answer, not HTML.",
    "citations":[{"revision_id":1,"block_id":"BLOCK_ID","quote":"Exact passage."}]
  }'
```

`status` must be **answered** or **failed**. A failure still needs a useful plain-text `body`, e.g. “Local adapter cannot answer this question.” `body` is nonempty, maximum 20,000 characters. Citations are optional (empty array allowed), at most 20; each must name a real block in the supplied original revision and quote its source or visible text. The quote is stored exactly, with whitespace normalized only for validation. A mismatch is rejected atomically (400); no partial answer is written.

First successful terminal result: HTTP 200, `{"duplicate":false,"thread":{...}}`. It creates one agent message, sets the request terminal, and marks the thread unread in the same transaction. Reposting **the same status, body, ordered citation values and token** returns 200 with `duplicate:true`, even after the original lease deadline. A different answer for an already terminal request returns 409. Stale/replaced tokens or an expired, unfinished reservation return 409. An answer from a previous lease never overwrites a new worker's answer.

These are **storage idempotency and exclusive lease semantics**, not exactly-once model execution. Crashes, lost reserve responses, lease expiry, or competing workers can cause duplicate computation. Save retries reuse the identical payload. A lost successful answer response can be retried safely with the same token/payload. Once a request is terminal it is not polled again. To ask again after failure, create a new question/thread; no automatic retry policy chooses a provider.

## Reader endpoints

- `GET /api/state` → current `revision_id` (or null) plus active/unavailable agent presence; no report content or session handle. Readers poll this for live updates.
- `GET /api/document` → current revision, sanitized HTML, TOC, block records and source; `null` before import.
- `POST /api/document` with `{title,source}` → 201 new revision. **Every import** creates a revision, even identical source. This endpoint is not idempotent. Optional `expected_revision_id` (integer, or null before first import) enables atomic compare-and-import: a different current revision returns 409 without writing. Browser manual imports and authorized file observation use this guard.
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
