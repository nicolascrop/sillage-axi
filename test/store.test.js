import test from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDb, questionInput } from '../test-support/helpers.js';
import { Store } from '../src/store.js';
import { DatabaseSync } from 'node:sqlite';

test('unknown future database schema is refused rather than overwritten', t => {
  const path = temporaryDb(t);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=3');
  assert.throws(() => new Store(path), /Unsupported Sillage database schema 3/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  db.close();
});

test('schema v1 gains a nonmanaged reservation marker during migration', t => {
  const path = temporaryDb(t);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE requests (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE,
    client_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('waiting','reserved','answered','failed')),
    worker TEXT, lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    answer_hash TEXT, created_at INTEGER NOT NULL
  ); PRAGMA user_version=1`);
  db.close();
  const store = new Store(path);
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    const managed = store.db.prepare('PRAGMA table_info(requests)').all().find(column => column.name === 'managed');
    assert.deepEqual({ name: managed.name, notnull: managed.notnull, dflt_value: managed.dflt_value },
      { name: 'managed', notnull: 1, dflt_value: '0' });
  } finally { store.close(); }
});

function seed(store) { return store.importReport({ title: 'Report', source: '# H\n\nExact context.\n\nUnchanged.' }); }
function answerInput(request, changes = {}) {
  return { lease_token: request.lease_token, status: 'answered', body: '<script>plain text reply</script>',
    citations: [{ revision_id: request.document.id, block_id: request.block.id, quote: request.quote }], ...changes };
}

test('source, question, reservation, terminal answer, citations and unread survive reopening SQLite', t => {
  const path = temporaryDb(t);
  let store = new Store(path);
  const doc = seed(store);
  const thread = store.question(questionInput(doc));
  assert.equal(thread.request_status, 'waiting');
  store.close();
  store = new Store(path);
  assert.equal(store.thread(thread.id).quote, 'Exact context.');
  const request = store.reserve({ worker: 'one' });
  assert.equal(request.document.source, doc.source);
  assert.equal(request.context.block.source, 'Exact context.');
  store.close();
  store = new Store(path);
  assert.equal(store.reserve({ worker: 'other' }), null);
  store.answer(request.request_id, answerInput(request));
  store.close();
  store = new Store(path);
  const saved = store.thread(thread.id);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.messages[1].citations[0].quote, 'Exact context.');
  assert.equal(saved.unread, 1);
  assert.equal(saved.request_status, 'answered');
  assert.equal(store.current().source, doc.source);
  store.close();
});

test('question retries are storage-idempotent and conflicting reuse is refused', () => {
  const store = new Store(':memory:');
  try {
    const doc = seed(store);
    const input = questionInput(doc);
    assert.equal(store.question(input).id, store.question(input).id);
    assert.equal(store.threads().length, 1);
    assert.throws(() => store.question({ ...input, question: 'Changed' }), { status: 409 });
    assert.throws(() => store.question({ ...input, client_key: 'two', quote: 'Fabricated' }), { status: 400 });
    assert.equal(store.threads().length, 1);
  } finally { store.close(); }
});

test('exclusive lease, expiry, reclaim, stale answer and idempotent terminal answer semantics', () => {
  let now = 1000;
  const store = new Store(':memory:', { now: () => now });
  try {
    const thread = store.question(questionInput(seed(store)));
    const first = store.reserve({ worker: 'first', lease_seconds: 5 });
    assert.equal(first.attempt, 1);
    assert.equal(store.reserve({ worker: 'second' }), null);
    now += 5000;
    assert.throws(() => store.answer(first.request_id, answerInput(first)), { status: 409 });
    const second = store.reserve({ worker: 'second', lease_seconds: 5 });
    assert.equal(second.request_id, first.request_id);
    assert.notEqual(second.lease_token, first.lease_token);
    assert.equal(second.attempt, 2);
    assert.throws(() => store.answer(first.request_id, answerInput(first)), { status: 409 });
    assert.throws(() => store.answer(second.request_id, answerInput(second, {
      citations: [{ revision_id: second.document.id, block_id: second.block.id, quote: 'Made up' }],
    })), { status: 400 });
    assert.equal(store.thread(thread.id).messages.length, 1);
    const payload = answerInput(second);
    assert.equal(store.answer(second.request_id, payload).duplicate, false);
    now += 100000;
    assert.equal(store.answer(second.request_id, payload).duplicate, true);
    assert.throws(() => store.answer(second.request_id, { ...payload, body: 'different' }), { status: 409 });
    assert.equal(store.thread(thread.id).messages.length, 2);
    assert.equal(store.reserve({ worker: 'third' }), null);
  } finally { store.close(); }
});

test('independent SQLite connections cannot reserve the same live request', t => {
  const path = temporaryDb(t);
  const one = new Store(path);
  const two = new Store(path);
  try {
    one.question(questionInput(seed(one)));
    assert.ok(one.reserve({ worker: 'one' }));
    assert.equal(two.reserve({ worker: 'two' }), null);
  } finally { one.close(); two.close(); }
});

test('failure is an explicit terminal answer, not a lost question or endless retry', () => {
  const store = new Store(':memory:');
  try {
    const thread = store.question(questionInput(seed(store)));
    const request = store.reserve({ worker: 'fixture' });
    const payload = answerInput(request, { status: 'failed', body: 'Cannot answer locally.', citations: [] });
    assert.equal(store.answer(request.request_id, payload).thread.request_status, 'failed');
    assert.equal(store.answer(request.request_id, payload).duplicate, true);
    assert.equal(store.reserve({ worker: 'fixture' }), null);
    assert.equal(store.thread(thread.id).unread, 1);
  } finally { store.close(); }
});

test('regeneration keeps exact relationships but never drifts a changed, deleted or ambiguous thread', () => {
  const store = new Store(':memory:');
  try {
    const original = seed(store);
    const thread = store.question(questionInput(original));
    const same = store.importReport({ title: 'Report', source: '# H\n\nInserted.\n\nExact context.\n\nUnchanged.' });
    assert.equal(same.id, original.id + 1);
    assert.equal(store.thread(thread.id).anchor_status, 'matched');
    store.importReport({ title: 'Report', source: '# H\n\nChanged context.\n\nUnchanged.' });
    assert.equal(store.thread(thread.id).anchor_status, 'needs_review');
    assert.equal(store.thread(thread.id).context.block.source, 'Exact context.');
    // Old revision remains addressable (e.g. a draft submitted from a stale tab).
    const stale = store.question(questionInput(original, { client_key: 'stale' }));
    assert.equal(stale.anchor_status, 'needs_review');
    const request = store.reserve({ worker: 'fixture' });
    assert.equal(request.document.id, original.id);
    assert.equal(request.anchor_status, 'needs_review');
    store.answer(request.request_id, answerInput(request));
    assert.equal(store.thread(thread.id).anchor_status, 'needs_review');
    store.importReport({ title: 'Report', source: original.source });
    assert.equal(store.thread(thread.id).anchor_status, 'needs_review');
    const newThread = store.question(questionInput(store.current(), { client_key: 'new' }));
    store.importReport({ title: 'Report', source: '# H\n\nExact context.\n\nExact context.' });
    assert.equal(store.thread(newThread.id).anchor_status, 'needs_review');
    store.updateThread(thread.id, { unread: false, closed: true });
    assert.equal(store.thread(thread.id).closed, 1);
    assert.equal(store.thread(thread.id).messages.length, 2);
  } finally { store.close(); }
});

test('compare-and-import guards file watching against concurrent revisions without changing manual v1 imports', () => {
  const store = new Store(':memory:');
  try {
    const first = store.importReport({ title: 'Français', source: 'Bonjour.', expected_revision_id: null });
    const second = store.importReport({ title: 'Français', source: 'Bonjour à tous.', expected_revision_id: first.id });
    assert.throws(() => store.importReport({ title: 'Français', source: 'Ancien fichier.', expected_revision_id: first.id }), { status: 409 });
    assert.equal(store.current().id, second.id);
    assert.equal(store.current().source, 'Bonjour à tous.');
    assert.equal(store.importReport({ title: 'Français', source: 'Bonjour à tous.' }).id, 3);
  } finally { store.close(); }
});
