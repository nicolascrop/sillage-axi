import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { temporaryDb, questionInput } from '../test-support/helpers.js';
const exec = promisify(execFile);
const input = { title: 'Retry-safe', source: '# Heading\n\nExact context.', operation_key: 'import-one', expected_revision_id: null };

test('lost import ack reconciles after restart without advancing the revision or provenance', t => {
  const path = temporaryDb(t); let store = new Store(path);
  const first = store.importReport(input); // Pretend the acknowledgement was lost.
  const thread = store.question(questionInput(first));
  store.importReport({ title: 'Later', source: '# Changed\n\nDifferent.', operation_key: 'later', expected_revision_id: first.id });
  store.close(); store = new Store(path); t.after(() => store.close());
  const replay = store.importReport(input);
  assert.deepEqual(replay, first); assert.equal(store.revisionId(), 2);
  assert.equal(store.thread(thread.id).revision_id, first.id);
  assert.equal(store.thread(thread.id).anchor_status, 'needs_review');
  for (const different of [{ title: 'Different' }, { source: 'Different' }, { expected_revision_id: 2 }]) {
    assert.throws(() => store.importReport({ ...input, ...different }), error => error.status === 409);
  }
  assert.throws(() => store.importReport({ ...input, operation_key: 'new-key' }), error => error.status === 409);
  assert.equal(store.importReport({ ...input, operation_key: 'intentional', expected_revision_id: 2 }).id, 3);
  const legacy = { title: input.title, source: input.source };
  assert.equal(store.importReport(legacy).id, 4); assert.equal(store.importReport(legacy).id, 5);
});

test('concurrent processes commit a keyed import exactly once', async t => {
  const path = temporaryDb(t); new Store(path).close();
  const code = `import { Store } from ${JSON.stringify(pathToFileURL(resolve('src/store.js')).href)}; const store = new Store(${JSON.stringify(path)}); console.log(store.importReport(${JSON.stringify(input)}).id); store.close();`;
  const results = await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath, ['--input-type=module', '-e', code])));
  assert.deepEqual(results.map(result => result.stdout.trim()), ['1', '1', '1', '1']);
  const store = new Store(path); t.after(() => store.close());
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM import_operations').get().n, 1);
  assert.equal(store.revisionId(), 1);
});

test('HTTP keeps 201 document JSON and old unkeyed semantics alongside optional replay keys', async t => {
  const path = temporaryDb(t); const app = createApp({ dbPath: path });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const post = body => fetch(`${origin}/api/document`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' }, body: JSON.stringify(body) });
  const first = await post(input); assert.equal(first.status, 201); const doc = await first.json();
  const replay = await post(input); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), doc);
  assert.ok(doc.html); assert.ok(doc.blocks.length);
  assert.equal((await post({ ...input, title: 'Conflict' })).status, 409);
  assert.equal((await (await post({ title: input.title, source: input.source })).json()).id, 2);
});
