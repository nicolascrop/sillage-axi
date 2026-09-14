# Mermaid whiteboards

Every fenced `mermaid` diagram in the **report** opens inline as a local Excalidraw
whiteboard. Nothing is installed or configured by the reader. Original Markdown,
Mermaid source, semantic block ID, and report revision remain authoritative.
Agent replies and direct `excalidraw` fences retain escaped source-only fallbacks;
arbitrary JSON scenes are not imported as report code.

## Reading, annotation and history

- Inline diagrams start in **view mode**. A parent click-catcher, inert iframe and
  disabled pointer events keep the canvas out of report scrolling and keyboard
  traversal. **Annotate** (or **Click to annotate**) explicitly enables the editor.
  **View / scroll** or Escape returns to reading; the source disclosure remains
  available for ordinary passage questions. Each diagram is a separate editor.
- **Enlarge** / **Fullscreen** expands the *same* iframe above the reader. There is
  no second editor racing its autosaves. Background controls become inert. Close
  flushes the scene before returning focus; a failed flush leaves the editor open
  with retry guidance. Report/Chat and collapsed Contents remain unchanged.
- Scenes autosave locally after an 800 ms debounce. The visible **Saved locally**
  indicator acknowledges SQLite, not an optimistic browser-only save. Keep the tab
  open after an error; **Retry save / reconnect** retains the exact failed operation
  before saving newer edits. The browser warns on departure while editing or with
  pending writes. Forced termination before acknowledgement can still lose unsaved
  edits; browser drafts are not a second durable store.
- **Whiteboard history**, above the report, opens exact historical diagram revisions
  for viewing or annotation. It lists the latest snapshot for the most recent 100
  saved revision/diagram pairs. Older immutable snapshots remain in SQLite and are
  retrievable by their snapshot ID. This is durable scene-version history; the
  editor's transient Undo/Redo stack itself is not persisted across reloads.
- Unchanged, unambiguous diagrams inherit saved annotations only through Sillage's
  existing conservative semantic ID reconciliation. The new snapshot records
  `derived_from`; a banner names the original revision. Similar-looking, changed,
  duplicated or ambiguous diagrams **never** inherit an old scene by index or fuzzy
  matching. This also applies to changed headings/containers.
- A report update during active annotation shows a stale-revision banner and pauses
  replacement of the displayed report. The entire editor and any feedback stay
  bound to the displayed **original revision**. Choose View / scroll and close any
  enlarged editor to show the current report. Non-editing updates flush before
  replacement; a failed flush pauses the update. The old scene remains in history.
  Choosing the new diagram converts new source; opening its historical counterpart
  keeps the old edits. No stale scene is silently merged or relabeled as current.

## What Send feedback delivers

**Send feedback** first saves the exact scene, then creates an ordinary durable
passage conversation/request in the existing local queue. No new agent, provider,
network service or inference path is added. A 2,000-character optional note explains
freehand intent, style changes or other visual meaning. Failed sends offer **Retry
same feedback**; the submitted note/scene stay fixed until acknowledgement rather
than silently substituting subsequent edits.

The request's `context.whiteboard` names the exact revision, semantic diagram block,
source SHA-256, immutable snapshot ID and optional `derived_from` snapshot. A
server-computed Lavish-style diff compares stable element IDs against the conversion
baseline: additions, deletions, relabels, moves/resizes and freehand-mark locations.
It includes at most **40 lines of 200 characters**, plus one omitted-changes line,
and counts. The chat exposes this same saved summary under a disclosure.

**The answering agent receives the bounded text/geometry summary and note, not scene
JSON, drawing pixels or a PNG.** Style-only edits, arrow rebinding, and the meaning
of a freehand mark may be missing. The delivery field says so explicitly. Ask for
clarification rather than claiming to see a drawing. The agent already receives the
exact original report, passage, neighbors and authorized handoff; normal follow-ups,
leases, citations and local JSONL delivery apply. A follow-up retains the whiteboard
snapshot reference. Scene JSON is available only by an explicit local snapshot API
read, not an arbitrary path, and is not automatically added to the agent envelope.
There is no screenshot export, scene-to-Mermaid reverse conversion, or automatic
report editing. Update **Mermaid source** only through separately authorized,
guarded authoring imports. Report text and annotations are data, never commands.

## Lavish implementation evidence and conversion matrix

Reference: Lavish AXI 0.1.45, exact inspected commit recorded in
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md). Inspection covered its
`AGENTS.md`, `src/artifact-sdk.js`, `src/chrome-client.js`, `src/chrome.css`,
`src/whiteboard-frame.js`, `src/whiteboard-core.js`, `src/mermaid-source.js`,
`src/whiteboard-store.js`, build script, package pins and whiteboard/browser tests.
The conversion, text-metric repair, persistence payload and bounded edit-summary
helpers are adapted from that MIT implementation, not a separate custom editor.

| Mermaid input | Lavish / Sillage conversion |
| --- | --- |
| flowchart / graph, including subgraphs | Editable Excalidraw shapes |
| sequenceDiagram | Editable shapes |
| classDiagram | Editable shapes |
| erDiagram | Editable shapes |
| stateDiagram / stateDiagram-v2 | Editable shapes |
| other types supported by Mermaid (for example pie) | Locally rendered **image** inside the whiteboard; draw and annotate on top, no original node identity |
| parse/conversion failure, unknown syntax, source above 100,000 characters | Explicit failure; original escaped Mermaid source remains available, never unsafe raw SVG/HTML |

The converter may itself fall back to an image when a supported type cannot be
parsed natively. The frame reports that mode honestly; the pinned native matrix is
also exercised in a real browser so a dependency upgrade cannot silently turn
supported diagrams into images. Preserve `@excalidraw/excalidraw` **0.18.1**,
`@excalidraw/mermaid-to-excalidraw` **2.2.2**, `mermaid` **11.12.1**, React / React DOM
**18.3.1**. Lavish documents native-conversion regressions with newer Mermaid
internals. Dependency upgrades require a fresh native-conversion probe, not merely
an npm range change. The lockfile pins the complete installation graph.

`regenerateIds: false` preserves Mermaid node/edge identity. Unlike Lavish's
whole-scene randomization for upstream parallel-edge collisions, Sillage suffixes
only colliding IDs; unambiguous node IDs remain stable. Labels are materialized a
second time **after fonts load**, as in Lavish, to prevent fallback-font clipping.
Theme is passed only through the Excalidraw component prop; persisted appState
never carries theme or a dark canvas background (which would double-invert it).

### Deliberate Sillage boundary adaptations

Lavish recovers sources from an artifact file and keys scenes by diagram position
in disk sidecars. Sillage instead uses Markdown tokens and immutable SQLite source
coordinates, revision/block identities, append-only scene snapshots, operation-key
reconciliation and optimistic concurrency. A competing editor gets a 409 and cannot
overwrite saved history. A scene hash must match that exact revision's source; the
conversion baseline cannot be replaced by later edits. Pre-feature report revisions
are recognized from their original token coordinates without rewriting their IDs.

Lavish's inline frames are grandchildren, so it authenticates signed frame tokens
through its chrome. Sillage directly owns each child iframe and binds its
WindowProxy plus a fresh random channel nonce to a fixed revision/diagram. Frames
cannot select API routes or revisions. All HTTP writes occur in the parent.
The enlarged view uses CSS on the same frame rather than destroying/recreating an
inline/overlay pair. Lavish's re-convert/keep-stale choice becomes an explicit
current-diagram/historical-revision choice here, consistent with fail-unmatched.
Lavish queues exported scene/PNG paths for its agent; Sillage sends a bounded summary
through its existing provider-neutral protocol instead, with explicit disclosure.

## Local build and security boundary

`npm ci --ignore-scripts` installs exact dependencies once. `npm start`,
`sillage-axi serve` and the historical server entry build the bundled editor/fonts
**locally**, without fetches; `npm run build` is also explicit. `npm test` builds in
its pretest step. `dist/` is ignored; there is no committed reader data or CDN bundle.
A source checkout needs its installed dependencies to serve the reader.

All font families, **including Xiaolai**, are vendored. The build sets the asset path
before editor module evaluation and replaces the pinned Excalidraw CDN font fallback
with the same local path. A changed fallback implementation fails the build. CSP is
still the final boundary, including when a local asset is unavailable.

The opaque iframe has only `allow-scripts` (also enforced through CSP sandbox), no
same-origin, popups, downloads, forms, top navigation, nested frames or server API
access. Its CSP allows scripts/styles/fonts solely from the bundled asset route,
inline editor styles and embedded data/blob images. `connect-src` is restricted to
the packaged assets, never APIs or remote URLs. Report resources cannot auto-load
from URLs. Editor links are disabled, embeddables rejected and remote scene file
URLs refused. No telemetry, sockets, collaboration/cloud controls, model selection,
LAN listener or arbitrary-file endpoint is added.

Only **GET allowlisted static bundle/font bytes** have public CORS headers for the
opaque frame; they contain no reader content. API Host/Origin/custom-header guards,
SILLAGE_* settings and legacy aliases are unchanged. Static assets use no-cache so
an unversioned URL cannot retain an obsolete bundle. Local-account access is still
the security boundary, not authentication against other programs on the PC.

Scene writes alone accept up to **20 MB**, 5,000 elements, 128 embedded images,
20,000 characters per text element and 20,000 points per stroke. Other APIs retain
2 MB. No automatic history deletion/compaction is introduced. Very large or
malicious diagrams can still exhaust browser/parser resources; this prototype is
not a hostile-document availability sandbox. Conversion-library audit advisories
are not erased by a compatibility pin: keep the sandbox/local-resource boundary,
and re-probe supported shapes before changing the pinned Mermaid internals.

See [agent protocol](agent-protocol.md#whiteboard-api-and-feedback) for endpoints and
[acceptance evidence](acceptance.md) for executed checks and browser limitations.
