import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Store } from '../src/store.js';
import { LocalRelay } from '../src/relay.js';
import { createApp } from '../src/server.js';
import { localClient } from '../src/agent-client.js';
import { temporaryDb, questionInput } from '../test-support/helpers.js';

const seed = store => store.importReport({ title: 'Rapport', source: '# Rapport\n\nExact context.' });
const answer = request => ({ lease_token: request.lease_token, status: 'answered', body: 'Réponse locale fournie par le travailleur.',
  citations: [{ revision_id: request.document.id, block_id: request.block.id, quote: request.quote }] });

test('explicit agent presence expires; lost heartbeat and timed-out work are terminal, never fake answers', () => {
  let now = 1000;
  const store = new Store(':memory:', { now: () => now });
  const relay = new LocalRelay(store, () => now);
  try {
    const doc = seed(store);
    const thread = store.question(questionInput(doc));
    assert.equal(relay.status().state, 'unavailable');
    assert.throws(() => relay.connect({ worker: 'deterministic-fake-v1' }), { status: 400 });
    const session = relay.connect({ worker: 'local-reasoner' });
    assert.equal(relay.status().state, 'active');
    assert.throws(() => relay.connect({ worker: 'other' }), { status: 409 });
    assert.throws(() => relay.heartbeat({ session_id: 'wrong' }), { status: 409 });
    const request = relay.reserve(session);
    assert.equal(request.document.id, doc.id);
    assert.equal(relay.reserve(session), null);
    now += 20_000;
    assert.equal(relay.status().state, 'unavailable');
    assert.equal(store.thread(thread.id).request_status, 'failed');
    assert.match(store.thread(thread.id).messages[1].body, /disconnected/);
    assert.throws(() => store.answer(request.request_id, answer(request)), { status: 409 });
    assert.throws(() => relay.heartbeat(session), { status: 409 });

    const second = store.question(questionInput(doc, { client_key: 'two' }));
    const connected = relay.connect({ worker: 'slow-reasoner' });
    relay.reserve(connected);
    for (let i = 0; i < 12; i++) { now += 10_000; relay.heartbeat(connected); }
    assert.equal(relay.status().state, 'active');
    assert.equal(store.thread(second.id).request_status, 'failed');
    assert.match(store.thread(second.id).messages[1].body, /120 seconds/);
    assert.equal(store.thread(second.id).messages.length, 2);
    relay.disconnect(connected);
    assert.equal(relay.status().state, 'unavailable');
  } finally { store.close(); }
});

test('restart fails only abandoned managed work, preserving legacy lease reclamation and queued questions', t => {
  const path = temporaryDb(t);
  const store = new Store(path);
  const doc = seed(store);
  const thread = store.question(questionInput(doc));
  const relay = new LocalRelay(store);
  relay.reserve(relay.connect({ worker: 'real-local' }));
  const legacy = store.question(questionInput(doc, { client_key: 'legacy' }));
  store.reserve({ worker: 'legacy' });
  const queued = store.question(questionInput(doc, { client_key: 'queued' }));
  store.close(); // Simulate crash: no relay disconnect.
  const app = createApp({ dbPath: path });
  t.after(() => app.server.emit('close'));
  assert.equal(app.relay.status().state, 'unavailable');
  assert.equal(app.store.thread(thread.id).request_status, 'failed');
  assert.equal(app.store.thread(legacy.id).request_status, 'reserved');
  assert.equal(app.store.thread(queued.id).request_status, 'waiting');
});

test('actual local-agent JSONL bridge drains queued questions with supplied answers and fails on EOF', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  const doc = seed(app.store);
  const first = app.store.question(questionInput(doc));
  const second = app.store.question(questionInput(doc, { client_key: 'second' }));
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const post = localClient(origin);
  const child = spawn(process.execPath, ['src/local-agent.js'], { env: { ...process.env, SILLAGE_URL: origin } });
  const records = []; let errors = '';
  createInterface({ input: child.stdout }).on('line', line => records.push(JSON.parse(line)));
  child.stderr.on('data', chunk => errors += chunk);
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => app.server.close(resolve));
  });
  async function waitForRecord(type, count = 1) {
    for (let i = 0; i < 500; i++) {
      const found = records.filter(record => record.type === type);
      if (found.length >= count) return found[count - 1];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`No ${type}: ${JSON.stringify(records)} ${errors}`);
  }
  await waitForRecord('ready-required');
  assert.equal(app.relay.status().state, 'unavailable', 'starting a bridge is not starting AI');
  child.stdin.write('{"type":"ready","worker":"test-local-reasoner"}\n');
  const { request } = await waitForRecord('request');
  assert.equal(app.relay.status().state, 'active');
  await assert.rejects(post('/api/agent/reserve', { worker: 'deterministic-fake-v1' }), /409/);
  app.store.importReport({ title: 'Rapport', source: '# Rapport\n\nContexte modifié.' });
  child.stdin.write(`${JSON.stringify({ type: 'answer', request_id: request.request_id, ...answer(request) })}\n`);
  await waitForRecord('saved');
  assert.equal(app.store.thread(first.id).messages[1].body, answer(request).body);
  assert.equal(app.store.thread(first.id).messages[1].citations[0].revision_id, doc.id);
  assert.equal(app.store.thread(first.id).anchor_status, 'needs_review');
  await waitForRecord('request', 2);
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, errors);
  assert.equal(app.relay.status().state, 'unavailable');
  assert.equal(app.store.thread(second.id).request_status, 'failed');
  assert.match(app.store.thread(second.id).messages[1].body, /stopped/);
});
