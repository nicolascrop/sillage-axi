# Local report: Sillage trial

A report is a place to read first, and ask only when a passage needs explanation.

## Deployment

Deployment remains local: the reader listens on `127.0.0.1` and keeps questions in SQLite on this PC.

The review checklist stays separate from the report's prose.

- Import a Markdown report.
- Ask about a precise passage.
- Reopen the durable thread later.

> A temporary bubble is a view of a conversation, not its storage location.

## Evidence

| Capability | First slice |
| --- | --- |
| Rendering | Markdown-it and sanitize-html |
| Storage | SQLite, immutable revisions |
| Agent | Deterministic local fake |

```js
const policy = { network: "loopback only", provider: null };
```

## Diagram integration seam

This scene is preserved as an unsupported diagram, not executed as an editor or HTML.

```excalidraw
{"type":"excalidraw","version":2,"source":"local-demo","elements":[],"appState":{},"files":{}}
```

## Privacy

No report images, scripts, fonts, or external agent requests are loaded automatically.
