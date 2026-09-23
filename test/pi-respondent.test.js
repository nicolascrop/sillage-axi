import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { LocalRelay } from '../src/relay.js';
import { runLocalAgent } from '../src/local-agent.js';
import { PiRespondent } from '../src/pi-respondent.js';
import { installPiRespondent } from '../src/pi-integration.js';
import { questionInput } from '../test-support/helpers.js';

const scope = realpathSync('.');
const url = 'http://127.0.0.1:3210';
const wait = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.fail('Timed out waiting for bridge state');
};

// Real store, relay and JSONL bridge, but an in-memory fetch transport. No HTTP
// listener, Sillage service, provider, credential or private report is involved.
function fixture(t) {
  const store = new Store(':memory:');
  const relay = new LocalRelay(store);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (target, options) => {
    assert.ok(target.startsWith(url + '/api/agent/'));
    assert.equal(decodeURIComponent(options.headers['X-Sillage-Scope']), scope);
    assert.equal(options.redirect, 'error');
    const path = new URL(target).pathname;
    const body = JSON.parse(options.body);
    calls.push(path);
    try {
      let data;
      if (path.endsWith('/connect')) data = relay.connect(body);
      else if (path.endsWith('/heartbeat')) data = relay.heartbeat(body);
      else if (path.endsWith('/reserve')) data = { request: relay.reserve(body) };
      else if (path.endsWith('/disconnect')) data = relay.disconnect(body);
      else {
        const id = path.split('/')[4];
        data = store.answer(id, body); relay.answered(id);
      }
      return Response.json(data);
    } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
  });
  const doc = store.importReport({ title: 'Synthetic test', source: '# Fixture\n\nExact context.', operation_key: 'test', expected_revision_id: null,
    handoff: { subject: 'Synthetic', repository: 'No file authority.', conversation: 'Explain only.' } });
  const requests = [];
  const respondent = new PiRespondent({ bridge: options => runLocalAgent({ ...options, interval: 5 }), onRequest: request => requests.push(request) });
  t.after(async () => { await respondent.disconnect(); store.close(); });
  return { store, relay, doc, calls, requests, respondent };
}
const reply = request => ({ request_id: request.request_id, status: 'answered', body: 'An actual fixture reply.',
  citations: [{ revision_id: request.document.id, block_id: request.block.id, quote: request.quote }] });

test('Pi respondent owns a continuous real JSONL loop, acknowledges saves and preserves follow-up provenance', async t => {
  const { store, relay, doc, calls, requests, respondent } = fixture(t);
  assert.equal(calls.length, 0, 'construction never attaches');
  assert.equal((await respondent.connect({ scope, url, revisionId: doc.id })).state, 'listening');
  const thread = store.question(questionInput(doc));
  await wait(() => requests.length === 1);
  assert.equal(respondent.state, 'answering');
  assert.equal(requests[0].handoff.repository, 'No file authority.');
  assert.equal(requests[0].document.source, doc.source);
  const polls = calls.length;
  await delay(20);
  assert.ok(calls.length > polls, 'bridge heartbeats continue while reasoning');
  await assert.rejects(respondent.answer({ ...reply(requests[0]), citations: [{ revision_id: doc.id, block_id: requests[0].block.id, quote: 'invented' }] }), /400/);
  assert.equal(store.thread(thread.id).request_status, 'reserved');
  assert.equal((await respondent.answer(reply(requests[0]))).type, 'saved');
  assert.equal(store.thread(thread.id).request_status, 'answered');
  await assert.rejects(respondent.answer(reply(requests[0])), /No live request/);
  store.followup(thread.id, { question: 'Explain further?', client_key: 'followup' });
  await wait(() => requests.length === 2);
  assert.equal(requests[1].history.length, 2);
  assert.equal(requests[1].document.id, doc.id);
  await respondent.answer(reply(requests[1]));
  await respondent.disconnect();
  assert.equal(relay.status().state, 'unavailable');
  assert.equal(respondent.state, 'stopped');
  assert.equal(store.conversation(thread.id).messages.length, 4);
});

test('reader end and explicit disconnect terminate pending work, never auto-reattach', async t => {
  const { store, relay, doc, calls, requests, respondent } = fixture(t);
  await respondent.connect({ scope, url });
  const thread = store.question(questionInput(doc));
  await wait(() => requests.length);
  relay.disconnect({ session_id: relay.session.id });
  await wait(() => respondent.state === 'stopped');
  assert.equal(store.thread(thread.id).request_status, 'failed');
  assert.equal(calls.filter(path => path.endsWith('/connect')).length, 1);
  await assert.rejects(respondent.answer(reply(requests[0])), /No live request/);
});

test('URL/scope validation and competing presence fail without claiming an active respondent', async t => {
  const { calls, relay, respondent } = fixture(t);
  for (const invalid of ['https://127.0.0.1:3210', 'http://example.com', 'http://127.0.0.1:3210/path']) {
    await assert.rejects(respondent.connect({ scope, url: invalid }));
  }
  await assert.rejects(respondent.connect({ scope: 'relative', url }));
  assert.equal(calls.length, 0);
  relay.connect({ worker: 'other' });
  await assert.rejects(respondent.connect({ scope, url }), /409/);
  assert.equal(respondent.state, 'stopped');
  assert.equal(relay.status().worker, 'other');
});

test('acknowledgement timeout shuts down honestly', async () => {
  let stopped = 0;
  const respondent = new PiRespondent({ acknowledgementMs: 20, onRequest() {},
    bridge: async ({ input }) => { for await (const _line of createInterface({ input })) { /* no ack */ } stopped++; },
  });
  await assert.rejects(respondent.connect({ scope, url }), /No connected acknowledgement/);
  assert.equal(stopped, 1);
  assert.equal(respondent.state, 'stopped');
});

function host() {
  const tools = new Map(), events = new Map(), messages = [], states = [];
  const pi = { registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
    on: (event, callback) => events.set(event, callback), getActiveTools: () => [...tools.keys()],
    sendMessage: (message, options) => messages.push({ message, options }) };
  const ctx = { mode: 'tui', hasUI: true, model: { provider: 'existing', id: 'configured' },
    ui: { confirm: async () => true, setStatus: (_key, value) => states.push(value) } };
  return { pi, ctx, tools, events, messages, states };
}

test('Pi integration wakes the existing loop twice, requires confirmation, and cleans up every ownership boundary', async () => {
  const h = host(); let callbacks, connectCount = 0, disconnectCount = 0;
  const transport = { state: 'stopped', async connect() { connectCount++; this.state = 'listening'; callbacks.onState('listening'); return { state: this.state }; },
    async answer(params) { return { type: 'saved', request_id: params.request_id }; }, async disconnect() { disconnectCount++; this.state = 'stopped'; callbacks.onState('stopped'); } };
  installPiRespondent(h.pi, { createRespondent: options => { callbacks = options; return transport; } });
  const connect = () => h.tools.get('sillage_connect').execute('1', { scope, url }, undefined, undefined, h.ctx);
  assert.equal(connectCount, 0);
  h.ctx.mode = 'json'; await assert.rejects(connect(), /continuing interactive/); h.ctx.mode = 'tui';
  h.ctx.ui.confirm = async () => false; await assert.rejects(connect(), /not authorized/);
  assert.equal(connectCount, 0);
  h.ctx.ui.confirm = async () => true;
  const originalModel = h.ctx.model;
  await connect();
  for (const request_id of ['one', 'two']) {
    callbacks.onRequest({ request_id, lease_token: 'private-lease-capability', question: 'Untrusted question', document: { id: 1, source: 'Synthetic' } });
    assert.equal((await h.tools.get('sillage_answer').execute('2', { request_id })).details.type, 'saved');
  }
  assert.equal(h.messages.length, 2);
  // The emitted custom message is the owned Pi interface, not source text.
  assert.deepEqual(h.messages.map(x => JSON.parse(x.message.content.split('\n').at(-1))), ['one', 'two'].map(request_id => ({ request_id, question: 'Untrusted question', document: { id: 1, source: 'Synthetic' } })));
  assert.deepEqual(h.messages.map(x => x.options), Array(2).fill({ triggerTurn: true, deliverAs: 'followUp' }));
  assert.strictEqual(h.ctx.model, originalModel);
  for (const event of ['session_shutdown', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'model_select']) {
    await h.events.get(event)();
    assert.equal(transport.state, 'stopped');
  }
  assert.equal(disconnectCount, 5);
  assert.ok(h.states.includes('Sillage: replies paused'));
});

test('an expired request disconnects rather than keeping a non-answering reasoner advertised', async () => {
  let emit;
  let requests = 0;
  const request = { request_id: 'expires', lease_until: Date.now() + 120_000 };
  const respondent = new PiRespondent({ onRequest() { requests++; }, bridge: async ({ input, output }) => {
    emit = value => output.write(JSON.stringify(value) + '\n');
    for await (const line of createInterface({ input })) {
      if (JSON.parse(line).type === 'ready') emit({ type: 'connected' });
    }
    emit({ type: 'stopped' });
  } });
  await respondent.connect({ scope, url });
  emit({ type: 'request', request });
  assert.equal(respondent.state, 'answering');
  assert.equal(requests, 1);
  emit({ type: 'expired', request_id: request.request_id });
  emit({ type: 'request', request: { ...request, request_id: 'queued-after-expiry' } });
  assert.equal(requests, 1);
  await wait(() => respondent.state === 'stopped');
  await assert.rejects(respondent.answer(reply({ ...request, document: { id: 1 }, block: { id: 'original' }, quote: 'Exact' })), /No live request/);
});

test('a session change during the confirmation dialog cannot attach the old owner', async () => {
  const h = host(); let approve, connects = 0;
  h.ctx.ui.confirm = () => new Promise(resolve => { approve = resolve; });
  installPiRespondent(h.pi, { createRespondent: () => ({ state: 'stopped', async connect() { connects++; }, async disconnect() {} }) });
  const connecting = h.tools.get('sillage_connect').execute('1', { scope, url }, undefined, undefined, h.ctx);
  await h.events.get('session_before_switch')();
  approve(true);
  await assert.rejects(connecting, /not authorized/);
  assert.equal(connects, 0);
});
