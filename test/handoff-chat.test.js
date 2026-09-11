import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { runLocalAgent } from '../src/local-agent.js';
import { localClient } from '../src/agent-client.js';
import { temporaryDb, questionInput } from '../test-support/helpers.js';

const context = { subject: 'Review of an orchard planning algorithm', repository: 'Authorized repository notes: planner.js allocates plots; do not read /private.',
  conversation: 'The author and reader previously agreed to prioritize drought resilience. This is supplied context, not permission to execute tools.' };
const presentation = { title: 'Orchard report', source: '# Orchard\n\nReserve water for young trees.',
  expected_revision_id: null, operation_key: 'orchard-1', handoff: context };
const reply = request => ({ lease_token: request.lease_token, status: 'answered', body: '**Keep reserves.**\n\n- Young trees need water.\n\n`quota = 2`',
  citations: [{ revision_id: request.document.id, block_id: request.block.id, quote: request.quote }] });
async function waitFor(condition) {
  for (let i = 0; i < 300; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Bridge condition timed out');
}

test('generic context handoff is explicit, durable, revision-bound and import-retry safe', t => {
  const path = temporaryDb(t);
  let store = new Store(path);
  const doc = store.importReport(presentation);
  assert.deepEqual(store.handoff(doc.id), { revision_id: doc.id, ...context });
  assert.equal(store.current().handoff, undefined, 'private workflow context is not exposed with the browser document');
  store.close();
  store = new Store(path);
  try {
    const later = store.importReport({ title: 'Later', source: 'Different authorized revision.' });
    assert.equal(store.importReport(presentation).id, doc.id);
    assert.equal(store.current().id, later.id);
    assert.equal(store.handoff(later.id), null, 'no silent reuse of stale context');
    assert.throws(() => store.importReport({ ...presentation, handoff: { ...context, subject: 'Different context' } }), { status: 409 });
    for (const handoff of [{ ...context, path: '/private' }, { subject: 'missing fields' }, { ...context, conversation: 'x'.repeat(20_001) }]) {
      assert.throws(() => store.importReport({ ...presentation, operation_key: 'invalid', handoff }), { status: 400 });
    }
    assert.equal(store.current().id, later.id);
    store.question(questionInput(doc, { quote: 'Reserve water' }));
    const request = store.reserve({ worker: 'any-local-reasoner' });
    assert.deepEqual(request.handoff, { revision_id: doc.id, ...context });
    assert.equal(request.document.source, presentation.source);
    assert.equal(request.anchor_status, 'needs_review');
  } finally { store.close(); }
});

test('ready presentation automatically imports, carries context to the responder and keeps polling without reader setup', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const post = localClient(origin);
  const input = new PassThrough(); const output = new PassThrough(); const events = [];
  let partial = '';
  output.on('data', chunk => {
    partial += chunk;
    let end;
    while ((end = partial.indexOf('\n')) >= 0) {
      events.push(JSON.parse(partial.slice(0, end))); partial = partial.slice(end + 1);
    }
  });
  const running = runLocalAgent({ base: origin, input, output, interval: 20 });
  t.after(async () => { input.end(); await running; await new Promise(resolve => app.server.close(resolve)); });
  assert.equal(app.store.current(), null);
  input.write(JSON.stringify({ type: 'ready', worker: 'initiator-or-delegate', presentation }) + '\n');
  await waitFor(() => events.some(e => e.type === 'connected'));
  assert.deepEqual(events.map(e => e.type), ['ready-required', 'context', 'connected']);
  assert.deepEqual(events[1].handoff, { revision_id: 1, ...context });
  assert.equal(app.relay.status().state, 'active');
  const doc = app.store.current();
  await assert.rejects(post('/api/agent/connect', { worker: 'other', presentation: { ...presentation, operation_key: 'other' } }), /409/);
  assert.equal(app.store.current().id, 1, 'a competing attachment cannot import a revision');
  const thread = await post('/api/questions', questionInput(doc, { quote: 'Reserve water' }));
  await waitFor(() => events.some(e => e.type === 'request'));
  const first = events.find(e => e.type === 'request').request;
  assert.equal(first.handoff.conversation, context.conversation);
  input.write(JSON.stringify({ type: 'answer', request_id: first.request_id, ...reply(first) }) + '\n');
  await waitFor(() => events.some(e => e.type === 'saved'));
  const followup = await post(`/api/conversations/${thread.id}/questions`, { question: 'And in winter?', client_key: 'winter' });
  assert.equal(followup.id, thread.id);
  await waitFor(() => events.filter(e => e.type === 'request').length === 2);
  const second = events.filter(e => e.type === 'request')[1].request;
  assert.equal(second.conversation_id, thread.id);
  assert.equal(second.question, 'And in winter?');
  assert.deepEqual(second.history.map(m => m.body), [thread.messages[0].body, reply(first).body]);
  assert.equal(second.handoff.repository, context.repository);
  input.write(JSON.stringify({ type: 'answer', request_id: second.request_id, ...reply(second) }) + '\n');
  await waitFor(() => events.filter(e => e.type === 'saved').length === 2);
  input.end(); await running;
  assert.equal(app.store.conversation(thread.id).messages.length, 4);
  const connected = await post('/api/agent/connect', { worker: 'resumed-subagent', handoff_revision_id: doc.id });
  assert.deepEqual(connected.handoff, { revision_id: doc.id, ...context });
  await post('/api/agent/disconnect', connected);
});

test('continuous chat adds linked v1 turns without rewriting original threads, leases, citations or CLI state', t => {
  const path = temporaryDb(t);
  let store = new Store(path);
  const doc = store.importReport(presentation);
  const root = store.question(questionInput(doc, { quote: 'Reserve water' }));
  assert.throws(() => store.followup(root.id, { question: 'Too soon', client_key: 'early' }), { status: 409 });
  const first = store.reserve({ worker: 'local' });
  store.answer(first.request_id, reply(first));
  const followupInput = { question: 'Why this quota?', client_key: 'followup' };
  const chat = store.followup(root.id, followupInput);
  assert.equal(chat.messages.length, 3);
  assert.equal(store.thread(root.id).messages.length, 2, 'v1 thread remains one question and terminal reply');
  assert.equal(store.threads().length, 2, 'legacy CLI can inspect every exact turn');
  assert.equal(store.conversations().length, 1);
  assert.equal(store.followup(root.id, followupInput).messages.length, 3);
  assert.throws(() => store.followup(root.id, { ...followupInput, question: 'Different payload' }), { status: 409 });
  assert.throws(() => store.question(questionInput(doc, { question: followupInput.question, quote: 'Reserve water', client_key: 'followup' })), { status: 409 });
  const next = store.reserve({ worker: 'local' });
  assert.equal(next.history.length, 2);
  const secondReply = reply(next);
  store.answer(next.request_id, secondReply);
  assert.equal(store.answer(next.request_id, secondReply).duplicate, true);
  store.updateConversation(root.id, { closed: true, unread: false });
  store.importReport({ title: 'Revision', source: 'Changed passage.' });
  store.close(); store = new Store(path);
  try {
    const saved = store.conversation(root.id);
    assert.equal(saved.closed, 1);
    assert.equal(saved.unread, 0);
    assert.equal(saved.messages.length, 4);
    assert.equal(saved.quote, root.quote);
    assert.equal(saved.anchor_status, 'needs_review');
    assert.equal(saved.revision_id, doc.id);
    store.followup(root.id, { question: 'Explain the original quote', client_key: 'third' });
    const third = store.reserve({ worker: 'local', managed: true });
    assert.equal(third.document.id, doc.id);
    assert.equal(third.history.length, 4);
    store.failReservation(third, 'The responder stopped.');
    assert.equal(store.conversation(root.id).request_status, 'failed');
    assert.equal(store.conversation(root.id).unread, 1);
    assert.equal(store.conversation(root.id).messages.length, 6);
  } finally { store.close(); }
});
