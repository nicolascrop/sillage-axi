import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { renderReport, mermaidDiagrams } from '../src/render.js';
import { validateScene } from '../src/whiteboard-store.js';
import { temporaryDb } from '../test-support/helpers.js';
const source = '# Review\n\n```mermaid\nflowchart TD\n A[Start] --> B[End]\n```\n\nExact context.';
const shape = (id, x = 0) => ({ id, type: 'rectangle', x, y: 0, width: 100, height: 40 });
const payload = (doc, changes = {}) => ({ source_hash: doc.diagrams[0].source_hash, operation_key: 'conversion',
  expected_version: null, text_metrics_version: 1, scene: { elements: [shape('A'), shape('B')], files: {}, appState: {} },
  baseline: { elements: [shape('A'), shape('B')] }, ...changes });
function fixture(t) {
  const path = temporaryDb(t); const store = new Store(path); t.after(() => store.close());
  const doc = store.importReport({ title: 'Review', source });
  return { path, store, wb: store.whiteboards, doc, id: doc.diagrams[0].block_id };
}

test('Mermaid token source and diagram identity preserve semantic provenance, never ordinal/fuzzy reattachment', () => {
  const first = renderReport(source);
  const diagrams = mermaidDiagrams(source, first.blocks);
  assert.equal(diagrams[0].source, 'flowchart TD\n A[Start] --> B[End]');
  assert.match(first.html, /class="language-mermaid"/);
  assert.equal(first.html.includes('<iframe'), false, 'stored Markdown stays inert; only the reader creates local frames');
  assert.equal(diagrams[0].block_id, first.blocks.find(b => b.kind === 'code').id);
  const same = renderReport(source + '\n\nOther paragraph.', first.blocks);
  assert.equal(mermaidDiagrams(source + '\n\nOther paragraph.', same.blocks)[0].block_id, diagrams[0].block_id);
  const changed = source.replace('Start', 'Different');
  assert.notEqual(mermaidDiagrams(changed, renderReport(changed, first.blocks).blocks)[0].block_id, diagrams[0].block_id);
  const duplicate = source + '\n\n```mermaid\nflowchart TD\n A[Start] --> B[End]\n```';
  assert.ok(mermaidDiagrams(duplicate, renderReport(duplicate, first.blocks).blocks).every(d => d.block_id !== diagrams[0].block_id));
  const inert = renderReport('```mermaid\nflowchart TD\n A["<script>bad()</script>"]\n```');
  assert.equal(inert.html.includes('<script>'), false);
});

test('scenes save/reload with immutable baseline, durable retries, optimistic concurrency and history', t => {
  const { store, wb, doc, id, path } = fixture(t);
  const first = wb.save(doc.id, id, payload(doc));
  assert.deepEqual(wb.save(doc.id, id, payload(doc)), first);
  const noop = payload(doc, { expected_version: first.id, operation_key: 'view-only' });
  assert.equal(wb.save(doc.id, id, noop).id, first.id);
  const edit = payload(doc, { expected_version: first.id, operation_key: 'edit', scene: { elements: [shape('A', 20), shape('B')], appState: { theme: 'dark', viewBackgroundColor: '#000', scrollX: 5 }, files: {} } });
  const next = wb.save(doc.id, id, edit);
  assert.notEqual(next.id, first.id);
  assert.deepEqual(next.scene.appState, { scrollX: 5 });
  assert.equal(wb.save(doc.id, id, noop).id, first.id, 'no-op acknowledgements remain retryable after later saves');
  assert.throws(() => wb.save(doc.id, id, { ...edit, operation_key: 'racing-editor' }), /another editor/);
  assert.throws(() => wb.save(doc.id, id, { ...edit, scene: { elements: [] } }), /operation_key/);
  assert.throws(() => wb.save(doc.id, id, { ...edit, operation_key: 'baseline', expected_version: next.id, baseline: { elements: [] } }), /baseline is immutable/);
  assert.deepEqual(wb.snapshot(first.id), first);
  assert.equal(store.revision(doc.id).source, source, 'scene save never overwrites Mermaid');
  const reopened = new Store(path); t.after(() => reopened.close());
  assert.deepEqual(reopened.whiteboards.load(doc.id, id).saved, next);
});

test('only exact continuous diagram identity inherits annotations; changed sources stay historical', t => {
  const { store, wb, doc, id } = fixture(t);
  const first = wb.save(doc.id, id, payload(doc));
  const same = store.importReport({ title: 'Review', source: source + '\n\nUnrelated update.' });
  assert.equal(wb.load(same.id, id).saved.id, first.id);
  const carried = wb.save(same.id, id, payload(same, { operation_key: 'carry', derived_from: first.id }));
  assert.equal(carried.derived_from, first.id);
  assert.equal(carried.revision_id, same.id);
  const changed = store.importReport({ title: 'Review', source: source.replace('Start', 'Changed') });
  assert.equal(wb.load(changed.id, changed.diagrams[0].block_id).saved, null);
  assert.throws(() => wb.load(changed.id, id), /not found/);
  assert.throws(() => wb.save(doc.id, id, { ...payload(doc), source_hash: changed.diagrams[0].source_hash }), /Source hash/);
  assert.throws(() => wb.save(changed.id, changed.diagrams[0].block_id, payload(changed, { operation_key: 'bad-inherit', derived_from: first.id })), /unmatched/);
  assert.equal(wb.load(doc.id, id).saved.id, first.id);
  assert.equal(wb.history().length, 2);
});

test('feedback is server-summarized, bounded, immutable and revision-bound through the authorized conversation and citations', t => {
  const { store, wb, doc, id } = fixture(t);
  const first = wb.save(doc.id, id, payload(doc, { scene: { elements: [shape('A', 50), shape('B'), ...Array.from({ length: 60 }, (_, i) => shape('note-' + i))] } }));
  const input = { snapshot_id: first.id, note: 'Explain these changes, not commands.', client_key: 'feedback' };
  const thread = wb.feedback(doc.id, id, input);
  assert.equal(wb.feedback(doc.id, id, input).id, thread.id);
  const newer = store.importReport({ title: 'Review', source: source.replace('Start', 'Changed') });
  assert.throws(() => wb.feedback(newer.id, newer.diagrams[0].block_id, input), /another diagram or revision/);
  const session = store.reserve({ worker: 'authorized-author' });
  assert.equal(session.document.source, source);
  assert.equal(session.document.id, doc.id);
  assert.equal(session.context.whiteboard.snapshot_id, first.id);
  assert.equal(session.context.whiteboard.stats.moved, 1);
  assert.equal(session.context.whiteboard.stats.added, 60);
  assert.ok(session.context.whiteboard.summary_lines.length <= 41);
  assert.ok(session.context.whiteboard.summary_lines.every(line => line.length <= 200));
  assert.equal('scene' in session.context.whiteboard, false);
  assert.match(session.context.whiteboard.delivery, /not scene JSON or pixels/);
  store.answer(session.request_id, { lease_token: session.lease_token, status: 'answered', body: 'Supplied fixture.', citations: [{ revision_id: doc.id, block_id: id, quote: session.quote }] });
  const followup = store.followup(thread.id, { question: 'And why?', client_key: 'followup' });
  assert.equal(followup.messages.length, 3);
  assert.equal(store.reserve({ worker: 'authorized-author' }).context.whiteboard.snapshot_id, first.id);
});

test('scene validation confines files, types, text and geometry rather than trusting converter/browser metadata', () => {
  assert.throws(() => validateScene({ elements: [shape('A'), shape('A')] }), /Duplicate/);
  assert.throws(() => validateScene({ elements: [{ ...shape('A'), x: Infinity }] }), /geometry/);
  assert.throws(() => validateScene({ elements: [{ ...shape('A'), type: 'embeddable' }] }), /Unsupported/);
  assert.throws(() => validateScene({ elements: [shape('A')], files: { image: { dataURL: 'https://example.invalid/private' } } }), /embedded data/);
  assert.throws(() => validateScene({ elements: [{ ...shape('A'), text: 'x'.repeat(20_001) }] }), /20,000/);
  assert.throws(() => validateScene({ elements: Array.from({ length: 5001 }, (_, i) => shape(String(i))) }), /5,000/);
  const safe = validateScene({ elements: [{ ...shape('A'), link: 'file:///private', customData: { command: 'ignored' } }] });
  assert.equal('link' in safe.elements[0], false);
  assert.equal('customData' in safe.elements[0], false);
});

test('HTTP confines opaque frame assets, denies API cross-origin writes and binds whiteboard snapshots', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const doc = app.store.importReport({ title: 'Review', source });
  const path = `/api/whiteboards/${doc.id}/${doc.diagrams[0].block_id}`;
  const call = (route, body, headers = {}) => fetch(base + route, { ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1', ...headers } });
  assert.equal((await call(path, payload(doc), { Origin: 'null' })).status, 403);
  assert.equal((await call(path, payload(doc), { Origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await call(path, payload(doc), { 'X-Sillage-Local': '0' })).status, 415);
  assert.equal((await call(path, payload(doc))).status, 201);
  const file = readdirSync('dist/whiteboard/fonts/Excalifont').find(name => name.endsWith('.woff2'));
  const font = await call('/whiteboard-assets/fonts/Excalifont/' + file, undefined, { Origin: 'null' });
  assert.equal(font.status, 200); assert.equal(font.headers.get('access-control-allow-origin'), '*');
  assert.equal((await call('/api/document', undefined, { Origin: 'null' })).status, 403);
  assert.equal((await call('/whiteboard-assets/..%2F..%2Fpackage.json')).status, 404);
  const page = await call('/whiteboard-frame');
  const csp = page.headers.get('content-security-policy');
  assert.ok(csp.includes('sandbox allow-scripts') && csp.includes("frame-src 'none'"));
  assert.ok(!csp.includes('allow-same-origin') && !csp.includes('https:'));
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  const large = payload(doc, { operation_key: 'large', expected_version: 1, scene: { elements: Array.from({ length: 160 }, (_, i) => ({ ...shape(String(i)), type: 'text', text: 'x'.repeat(19_000) })) } });
  assert.equal((await call('/api/questions', large)).status, 413);
  assert.equal((await call(path, large)).status, 201, 'whiteboard writes alone get the 20 MB boundary');
});

test('installed conversion graph resolves the exact Lavish native-conversion pins', () => {
  const pins = { mermaid: '11.12.1', '@excalidraw/excalidraw': '0.18.1', '@excalidraw/mermaid-to-excalidraw': '2.2.2', react: '18.3.1', 'react-dom': '18.3.1' };
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  for (const [name, version] of Object.entries(pins)) {
    assert.equal(pkg.dependencies[name], version);
    for (const [path, record] of Object.entries(lock.packages)) if (path.endsWith('/node_modules/' + name) || path === 'node_modules/' + name) assert.equal(record.version, version);
    assert.equal(JSON.parse(readFileSync(new URL('../node_modules/' + name + '/package.json', import.meta.url))).version, version);
  }
});

test('versioned saved-font repair permits expansion only, without dropping annotation baseline or content', t => {
  const { wb, doc, id } = fixture(t);
  const label = { id: 'label', type: 'text', x: 0, y: 0, width: 40, height: 20, text: 'Original text' };
  const original = wb.save(doc.id, id, payload(doc, { text_metrics_version: 0, baseline: { elements: [label] }, scene: { elements: [label] } }));
  const expanded = { ...label, width: 80, height: 24 };
  const repair = payload(doc, { operation_key: 'repair', expected_version: original.id,
    baseline: { elements: [expanded] }, scene: { elements: [expanded] } });
  const saved = wb.save(doc.id, id, repair);
  assert.equal(saved.baseline.elements[0].width, 80);
  assert.equal(wb.snapshot(original.id).baseline.elements[0].width, 40);
  assert.throws(() => wb.save(doc.id, id, { ...repair, operation_key: 'downgrade', expected_version: saved.id, text_metrics_version: 0 }), /backwards/);
  assert.throws(() => wb.save(doc.id, id, { ...repair, operation_key: 'relabel', expected_version: saved.id, baseline: { elements: [{ ...expanded, text: 'Not the baseline' }] } }), /immutable/);
});
