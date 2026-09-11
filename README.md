# Sillage AXI

A small **local-only Markdown report reader** with a passage-linked conversation panel and durable history. One reader, one PC, one report with multiple revisions. Sillage AXI uses **no external AI provider**, telemetry, accounts, or cloud services.

## Run

Requires **Node.js 24+** and npm. From this directory:

```sh
npm ci --ignore-scripts
npm start
```

Presenting a report includes supplying its Markdown/context and attaching the authoring agent (or its explicitly authorized delegate) through the local bridge before opening **http://127.0.0.1:3210**. The reader needs no import or connection setup. For a standalone fixture, use the explicit CLI import below with `examples/report.md`. Installing dependencies needs a registry connection once; running the app, fake agent, and tests afterward needs **no internet or secrets**. There are no CDN assets or external image requests.

For a separate deterministic transport demo, answer **one** queued question in another terminal while no managed agent is connected:

```sh
npm run fake-agent
```

Run it again for each question; an empty queue prints `{"status":"idle"}`. This is visibly labeled demo output, not an AI assessment. Nothing automatically selects or calls a model.

```sh
npm test        # offline: rendering, database, HTTP, fake CLI, and reader DOM tests
npm run check  # JavaScript syntax and generated-skill freshness checks
```

### Agent-facing CLI (AXI façade)

The package exposes `sillage-axi` as its primary command. The historical `sillage`
command and `node bin/sillage.js` path remain compatible aliases. From a preinstalled
checkout, every command works offline as `node /absolute/path/to/sillage-axi/bin/sillage-axi.js …`
or through the historical `node /absolute/path/to/sillage-axi/bin/sillage.js …` path. To expose
both executables on PATH, explicitly run `npm link --ignore-scripts` in that checkout;
there is no automatic installer, updater or registry check at runtime.

The skill keeps its established install path and public `/sillage` invocation; only
its product commands are shown below with the new primary name. See the
[rename migration guide](docs/migration-sillage-axi.md) for the complete mapping.

```sh
sillage-axi                         # finite read-only home, not server startup
sillage-axi --help
sillage-axi document                 # source preview; --full retrieves exact text
sillage-axi blocks --fields id,kind,ordinal
sillage-axi threads                  # bounded list plus total and derived counts
sillage-axi thread <id> --full
sillage-axi import --file examples/report.md --title Report --key import-1 --expected null

# The historical direct Node path and command remain valid:
node bin/sillage.js --help
sillage --help
```

Home identifies the executable, service/report/queue state and a few next commands.
It never creates a database, starts a service, installs hooks, reads a report file,
reserves work or launches inference. Start the service explicitly with `sillage-axi serve`
or the unchanged `npm start`. `sillage-axi demo` explicitly consumes one demo request;
`sillage-axi attach` explicitly switches to the **continuous JSONL** bridge. For the full
reply/citation contract, use `sillage-axi agent-help` or the connection guide below.
Every primary command also accepts the historical `sillage` executable alias.

Finite CLI results (observations and mutations) and errors use **TOON** on stdout;
version is a bare string.
Progress/diagnostics use stderr. Exit codes are 0 success/no-op, 1 runtime failure,
2 invalid usage; no command prompts. Every command has `--help`; `-v`, `-V`,
`--version` are side-effect-free. The historical Node scripts retain their launch
commands (including demo JSON and bridge JSONL); their help/version/unknown-input
paths now terminate without doing work. HTTP continues to speak JSON, not TOON.

Inspection matches the service's **canonical startup directory** with the current
directory. It does not search parent directories or discover other databases. Use
`--scope /absolute/service-directory` to select another scope deliberately, and
`--url http://127.0.0.1:3211` for another port. URL precedence: `--url`, `SILLAGE_URL`,
that scope's `.sillage/config.json`, then port 3210. A mismatch reveals no reader
content and refuses CLI writes; directory checks are not authentication against
other local processes. The existing v1 API remains available to old clients.

Lists default to at most 100 rows with 3–4 fields, `--limit`/`--offset`, exact totals,
and validated `--fields`; detail text defaults to 1000 UTF-16 characters with
original size and a `--full` hint only when truncated. Lists never include bodies.
`document --revision <id>` and `block <id> --revision <id>` retrieve exact revisions;
`--full` returns original source, question/context and citation text without
truncating storage or changing the reasoner payload.

Imports require an explicit file, title, durable operation key and expected current
revision (`null` for empty). Reuse the **identical key and payload**, including the
guard, after an uncertain acknowledgement; a committed replay returns the original
revision even if a later revision exists. Different content/guard under the key
conflicts. A new intentional import uses a new key. `question --help` explains the
existing retry-safe client key; `close <id>` is an idempotent organizational action,
not cancellation. No automatic reserve/connect/disconnect retry is introduced.

### Optional session integration or installed skill

For ambient discovery, explicitly install a **project-scoped**, availability-only
hook in a harness you have configured for local-only reasoning:

```sh
sillage-axi setup --app claude --local-only
sillage-axi setup --app codex --local-only
sillage-axi setup --app opencode --local-only
# Remove only Sillage AXI-managed entries for the selected app:
sillage-axi setup --app claude --local-only --remove
```

Choose your app; you do not need all three. Hooks target POSIX shell/Node hosts;
Windows/native harness sessions are not validated (see acceptance limits).
Claude Code/Codex use native SessionStart
hooks; OpenCode uses ambient system-context injection. Codex also requires you to
explicitly enable `[features].hooks = true` in `~/.codex/config.toml`; setup reports
this prerequisite and **never modifies user-home configuration**. These adapters
are not proof that a named harness uses a local model. Setup requires your explicit
`--local-only` confirmation and never grants cloud disclosure permission.

Ordinary commands do not install anything. Setup records the selected loopback URL
in `.sillage/config.json`, preserves third-party entries, refuses invalid/unmanaged
files and symlink targets, and is a no-op when unchanged. It selects a PATH name only
when it resolves to this executable; otherwise it pins the absolute Node/script
paths. Rerun setup after relocation/reinstallation or PATH changes to repair paths.
Removal leaves scoped connection configuration intact. Keep generated machine-local
hook paths out of shared commits. Multi-file installation is not transactional:
permission/disk failures may require rerunning setup; individual writes are atomic.

At session start the hook calls `sillage-axi context`, a privacy-restricted home that
reports only availability/configuration, **never titles, IDs, counts, worker names,
report text, questions or citations**. Outside the exact selected directory it
reveals no report state. Hooks are bounded, do not reserve, infer or fetch externally.
No session-end transcript/file capture is installed: durable local question/answer
history is Sillage AXI's lifecycle memory. This is the deliberate local-only subset of
AXI's ambient-context recommendation. Existing hooks calling `sillage context` remain valid.

The [installable skill](skills/sillage/SKILL.md) is the on-demand alternative; either
hook or skill is sufficient for discovery. Copy only `skills/sillage/` into your
harness's skill directory. Its established `/sillage` invocation and install path
remain valid; it uses portable runtime guidance rather than links outside that
directory, and an existing local checkout is still required. `$ARGUMENTS` remains;
nonstandard argument hints live under `metadata` and may be ignored by a harness.
Generate with `npm run skill:generate`; CI checks freshness against the same static
discovery/safety text used by the CLI, so the skill has one source of instructions.

### Using a real local agent

Here **local** describes Sillage's storage and loopback transport, not a model or
provider requirement. The **authoring agent owns the handoff and answering loop**:
it supplies the report and the context it already has (subject, repository notes,
and prior conversation) as part of presenting the report, then keeps answering
itself or through its explicitly authorized sub-agent. The reader never reconstructs
context or manually attaches a separate reasoner. This is generic to every
agent-authored report, independent of repository, model and harness.

The [handoff contract](docs/local-agent.md#presenting-an-agent-authored-report) provides
an atomic import plus readiness handshake, or a durable import followed by attachment
of a delegate to that exact revision. Attachment automatically delivers the exact
report and its supplied context, then polls continuously. **The existing authoring
workflow must actually consume requests and return answers** before presenting the
reader as ready; a bridge process alone is not an answering agent. Keep that owner
and its streams alive after opening the reader, or hand over to an authorized delegate.

Sillage adds no arbitrary filesystem reads, transcript capture, model selection,
model launch or autonomous provider. Authorization stays with the original workflow;
this transport does not grant disclosure permission to a new provider or delegate.

The presenting agent or its authorized delegate owns the managed HTTP lifecycle or this local JSONL bridge:

```sh
node src/local-agent.js
# Nondefault loopback port:
SILLAGE_URL=http://127.0.0.1:3211 node src/local-agent.js
```

Use Node directly for machine attachment; keep stderr separate from JSONL stdout.
The bridge polls continuously and maintains heartbeats after the workflow's ready
handshake. Normal listening is invisible in the reader. Lost presence, a failed reply,
or the 120-second deadline produces an actionable alert and retains the saved question.
Return to the original authoring conversation to resume answering, then send a follow-up
if a turn already failed. Unclaimed questions stay queued. The separate demo command
never advertises managed presence; its supplied replies remain labeled **not AI**.
See the [v1 protocol](docs/agent-protocol.md) for leases, citations and idempotency.

### Local configuration

```sh
SILLAGE_DB=.data/demo.sqlite SILLAGE_PORT=3211 npm start
SILLAGE_URL=http://127.0.0.1:3211 npm run fake-agent
```

The default durable store is `.data/sillage.sqlite` relative to the working directory. Restart from the **same directory with the same database path**. **Run only one service per database.** Stop with Ctrl+C; restarting `npm start` restores the report, questions, replies, citations, and unread state. An unfinished managed reservation is failed during restart recovery; legacy reservations remain durable and reclaimable after their lease expires. Data is not encrypted: it has your OS account's privacy boundary. The service creates private data directories/files; `.data/` is gitignored. To back up, stop Sillage AXI and copy its SQLite file (do not copy only the main file while WAL writes are active).

## Walkthrough

1. Ask the agent that produced your report to present it with Sillage. It supplies its existing report/context and owns listening before opening the reader; there is no manual respondent setup for you. Contents starts collapsed at every width, without a persisted preference. The report stays central; chat fills the right edge below the header on wide screens. Each pane scrolls independently. On narrow screens, **Report / Chat** switches between full-height panes without discarding drafts or reading positions; the report opens first.
2. Click a passage (or focus it and press Enter), or select part of a paragraph across inline formatting. A short quote narrows the question without losing the full passage, neighbors or original revision. Send **Ask question**: a visible **Question saved · View conversation** confirmation links to the durable question without moving the report automatically. Close an unsent draft with × or Escape directly, with no confirmation.
3. The agent's reply appears as safe Markdown beneath your question. Choose another conversation from the one-line dropdown or **Find a conversation** for full questions and passage previews. The activity line distinguishes queued questions, a reply in progress, saved replies and failures, with the next step beside the composer. You can draft while waiting; the **Send message** arrow icon (or Ctrl/⌘ + Enter) becomes available once the turn finishes. Enter alone adds a new line. The compact **Quoted passage**, **Citation** and **Report details** disclosures keep original revisions and source snapshots available on demand, not in the main chat labels. Follow-ups retain that quote and carry prior turns to the respondent. Expanded citations and reading position survive new turns; **View latest reply** lets you catch up without being pulled away from the report. **New reply** opens a saved reply and acknowledges the displayed turns; opening the Chat pane alone does not clear it, and a racing unseen reply stays indicated. The compact **Go to passage** icon explicitly navigates and focuses the source (switching to Report on narrow screens), never silently replacing it. Send and passage icons have accessible names, hover titles and visible keyboard focus; a failed save changes the send action to **Retry message** without losing its payload.
4. Restart the same service/database: reports, conversation turns, citations, unread state and original snapshots remain. A local draft is temporary; saved conversations are not. **Actions → Close conversation** is organization, not deletion or cancellation; it remains selectable.
5. The authoring workflow can publish a guarded new revision through the same API/CLI. Changed or ambiguous passages say **Passage to review** and retain their original snapshot, rather than linking to similar-looking text. A follow-up still refers to that original revision. To discuss new wording, start a question on the new passage.

The existing v1 one-question/one-reply threads remain intact as individual turns.
An additive conversation grouping powers continuous chat; existing CLI thread inspection
can still inspect each turn independently. There is no provider-driven auto-editing or
report switching. Any revision must come from the authorized authoring workflow.

## Live report updates

Open readers check the local service every two seconds and display workflow imports,
**even with no conversations yet**. No reload button or WebSocket is required. Unchanged
polls do not rebuild the report. A safe semantic reading anchor keeps its viewport offset;
otherwise approximate scroll position is retained with a notice. Open chats and drafts
keep their exact original revision and quote; changed or ambiguous context is never remapped.

The reader does not request disk access or observe browser file inputs. The authoring
workflow already owns its report file/context capability and explicitly sends changed
Markdown through `POST /api/document` (or the compatible keyed CLI import when no handoff context is needed). Use a new
operation key and the current expected revision for each intentional update; retry an
uncertain acknowledgement with the identical payload/key. A conflict must be inspected,
not overwritten. Include updated handoff context with each workflow revision when needed;
Sillage never guesses context or reads a path mentioned in it. Readers reflect authorized
imports automatically; polling is not a claim that Sillage watches arbitrary files.

UTF-8 French Markdown is supported without translation or a second-report feature.
The author can supply optional `language: "fr"` (or another BCP 47 Unicode locale tag)
in the HTTP import/ready presentation to mark report and original-quote pronunciation
for assistive technology. Language is revision-bound, never guessed from text;
the interface stays English. Existing imports may omit it.
Yuba, Lavish and any other report-authoring repository remain independent and unchanged.

## Visual direction

**Material Darker Air** is the one implemented direction: anthracite/slate surfaces,
restrained indigo, airy hierarchy and spacing, a wider canvas for code/tables, and
prose capped at 76ch. Inspired by the [Zed workspace reference](https://zed.dev/img/agentic/posters/review-poster.webp),
the edge-to-edge chat has no rounded card, inset margin or shadow. The report's
vertical scrollbar sits immediately to its left. Neither pane scrolls the other
or the page; the chat's quote, snapshot and messages share one scroll region with
a pinned composer. At 600px viewport height or less, the **whole chat** becomes its
single scroll region so context, status and composer remain reachable rather than
being clipped. The report still scrolls independently. Short question bubbles may
also need scrolling to reach the question action.

At 700px width or less, **Report / Chat** explicitly selects the visible full-height
pane; hidden content is outside the keyboard order. On intermediate widths Contents
opens as an overlay; choose a heading or press Escape to close it. Contents starts
collapsed everywhere. English remains the interface language, with author-supplied
language metadata retained for report/quote pronunciation.

Compact context, distinct question cards, unboxed Markdown replies and on-demand
provenance keep the conversation legible. The composer stays available for drafts
while the agent replies; activity reflects saved request states, not invented tool
steps or streamed reasoning. Saved-question confirmations and real listening-loss
alerts remain above the workspace. Duplicate chrome/document titles are avoided
without changing semantic passages. Wide tables keep readable columns inside a
keyboard-focusable horizontal region. The small locally bundled Sillage AXI mark
uses no remote asset or font. **Plum & Amber** remains a documented future
alternative only, not a second theme or switch.

### Standalone icon proposals

Open [`proposals/icons.html`](proposals/icons.html) directly in a browser (a local `file://` URL, no server required). This separate Material Darker Air board contains **exactly ten inline-SVG proposals**, each with a name, rationale and small-size previews. Click a card or use Tab and arrow keys to highlight one; note its number and name for a later integration decision.

The highlight is **temporary**: reload clears it. The board uses no browser storage, service requests, external assets or application settings. It is not linked from the reader UI or served by the Sillage AXI app, and it changes neither the current logo nor the favicon. Choosing here does not integrate an icon; that is a separate task.

## How anchors and revisions work

`src/render.js` uses Markdown-it's semantic tokens and source line maps, **not DOM selectors**, to produce app-owned UUIDs. DOM IDs (`b-<uuid>`) are navigation projections of those stored identities. Source text, original revision, exact quote, neighboring context, and block coordinates are saved with every question. Short rendered selections are checked against the passage's visible text/source (whitespace-normalized for validation only); the supplied quote is stored verbatim.

A revision carries an ID forward **only** when its fingerprint occurs exactly once in both the immediately previous revision and the new revision. Fingerprints include block kind, exact normalized source, resolved safe rendering, section heading path, and enclosing container sources. This notices changed reference-link destinations and avoids attaching unchanged-looking children after their list/quote container changes. CRLF/LF normalization is intentional; all original full source is also retained.

Changed, deleted, split, merged, or ambiguous blocks get fresh IDs. Unmatched threads never automatically reconnect, even if identical text reappears in a later revision. Matching is deliberately conservative: editing a heading or any part of a list/quote can mark its unchanged children for review. There is no fuzzy matching or manual reassignment of a thread to another passage. Historic questions can still be submitted from an old tab and will show the appropriate review state.

## Safety and extension points

- **Rendering:** Markdown-it with raw HTML disabled, then a strict sanitize-html allowlist. Agent replies use the same Markdown-it and sanitize-html pipeline, without report passage IDs. Questions and citation quotes use DOM `textContent`. Images are explicit text placeholders, not network fetches. Relative file links are inert; generated Contents links work. Raw HTML, SVG, and arbitrary embeds do not execute.
- **Local boundary:** hard-bound to IPv4 loopback, strict Host/Origin checks, no CORS, JSON plus a required custom write header, restrictive CSP, and no filesystem-serving endpoint. Other processes running as the local user can access the API; this is not an authentication or hostile-machine sandbox. Do not reverse-proxy or expose it to a LAN/public interface.
- **Storage/protocol:** `src/store.js` owns SQLite transactions, snapshots, idempotency and leases; `src/relay.js` owns the managed local-agent lifecycle; and `src/server.js` exposes the local HTTP boundary. See [the v1 agent protocol](docs/agent-protocol.md) before writing an adapter. Full document text is supplied locally to a reserved worker; adopting any external provider needs a separate privacy decision.
- **Agent trust:** report Markdown, questions, and agent replies are data, not executable instructions or permission to modify a project. Preserve the original revision and passage references; never silently move a thread to regenerated text. Do not put secrets in reports, questions, replies, or citations.
- **Diagrams:** an `excalidraw` code fence becomes an explicit **Unsupported diagram · Excalidraw** figure with preserved, escaped source. The extension points are `codeRenderer` in `src/render.js` and `[data-diagram="excalidraw"]` in the reader. A future read-only, locally bundled established Excalidraw-compatible component can consume validated scene JSON there. It must preserve the enclosing block identity, bound scene complexity, and prevent remote images/fonts/links from auto-loading. No custom diagram editor or unsafe SVG/HTML fallback is included.
- **UI:** plain JavaScript/CSS, Material Darker Air palette; no build, WebSockets, streaming, shell execution, vector search, or provider SDK.
- **Limits:** 1,000,000 source characters / 20,000 lines / 5,000 passages per import, 2 MB API payloads, 4,000-character questions, 2,000-character UI selections. The local prototype migrates schema v1 to v2 for the managed reservation marker and refuses unknown future schema versions; handoffs and conversation groups use additive tables without changing v1 records or schema version. Resource isolation for very large/malicious documents remains out of scope.

See [acceptance evidence](docs/acceptance.md) for commands, observed results, and validation limitations. The repository is [nicolascrop/sillage-axi](https://github.com/nicolascrop/sillage-axi).
