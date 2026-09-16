import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/server.js';
import { runLocalAgent } from '../src/local-agent.js';
import { temporaryDb, questionInput } from '../test-support/helpers.js';

const headers = { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' };
async function service(t) {
  const app = createApp({ dbPath: temporaryDb(t) });
  app.store.importReport({ title: 'Synthetic review', source: 'Exact context.' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  return { ...app, origin: `http://127.0.0.1:${app.server.address().port}` };
}
async function review(app) {
  const page = new JSDOM(await (await fetch(app.origin)).text());
  const review_key = page.window.document.querySelector('meta[name="sillage-review"]').content;
  page.window.close();
  return { review_key, revision_id: app.store.revisionId() };
}
const end = (app, body, options = {}) => fetch(app.origin + '/review/end', { method: 'POST', headers, body: JSON.stringify(body), ...options });
function holdEnd(app, body) {
  const payload = JSON.stringify(body);
  let resolve, reject;
  const done = new Promise((res, rej) => { resolve = res; reject = rej; });
  const request = http.request(app.origin + '/review/end', {
    method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
  }, response => {
    let data = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { data += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
  });
  request.on('error', reject);
  request.write(payload.slice(0, -1));
  return { release: () => request.end(payload.slice(-1)), done };
}
async function waitFor(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Local bridge condition timed out');
}

test('reader end action preserves v1 data and state, rejects cross-origin/form/stale pages, and safely replays', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const session = app.relay.connect({ worker: 'synthetic-author' });
  const requested = app.store.question(questionInput(doc));
  const pending = app.relay.reserve(session);
  const queued = app.store.question(questionInput(doc, { client_key: 'queued', question: 'Wait for a resumed respondent' }));
  const body = await review(app);
  assert.notEqual(body.review_key, session.session_id);
  const state = await (await fetch(app.origin + '/api/state')).json();
  assert.deepEqual(Object.keys(state).sort(), ['agent', 'revision_id']);
  assert.deepEqual(Object.keys(state.agent).sort(), ['busy', 'expires_seconds', 'heartbeat_seconds', 'state', 'worker']);
  assert.equal((await fetch(app.origin + '/review/end')).status, 404, 'GET never ends a review');
  for (const extra of [{ Origin: 'https://foreign.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await end(app, body, { headers: { ...headers, ...extra } })).status, 403, JSON.stringify(extra));
  }
  // Undici rewrites Host; use the raw HTTP consumer for a real rebinding probe.
  const badHost = await new Promise((resolve, reject) => {
    const request = http.request(app.origin + '/review/end', { method: 'POST', headers: { ...headers, Host: 'foreign.test' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
  assert.equal(badHost, 403);
  assert.equal((await end(app, body, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await end(app, body, { headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await end(app, { ...body, session_id: session.session_id })).status, 400, 'no browser session-management input');
  assert.equal((await end(app, { ...body, review_key: 'unknown' })).status, 409);
  const stalePage = await review(app);
  assert.equal((await end(app, { ...stalePage, revision_id: 99 })).status, 409);
  assert.equal((await end(app, stalePage)).status, 409);
  assert.equal(app.relay.session.id, session.session_id);
  // Existing disconnect semantics are not relaxed for browser access.
  assert.equal((await fetch(app.origin + '/api/agent/disconnect', { method: 'POST', headers, body: '{}' })).status, 409);
  const response = await end(app, body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), { ended: true });
  assert.equal(app.relay.status().state, 'unavailable');
  const failed = app.store.thread(requested.id);
  assert.equal(failed.request_status, 'failed');
  assert.equal(failed.closed, 0);
  assert.equal(failed.quote, requested.quote);
  assert.equal(failed.messages[0].body, requested.messages[0].body);
  assert.equal(app.store.thread(queued.id).request_status, 'waiting');
  assert.deepEqual(app.store.current(), doc);
  assert.throws(() => app.store.answer(pending.request_id, { lease_token: pending.lease_token, status: 'answered', body: 'Too late', citations: [] }));
  const replacement = app.relay.connect({ worker: 'new-author' });
  app.store.importReport({ title: 'Updated', source: 'A new report revision.' });
  assert.deepEqual(await (await end(app, body)).json(), { ended: true });
  assert.equal(app.relay.session.id, replacement.session_id, 'lost acknowledgement retry never disconnects a later responder');
  assert.equal((await fetch(app.origin + '/api/document')).status, 200, 'service remains available');
  app.relay.disconnect(replacement);
  const noResponder = await review(app);
  assert.deepEqual(await (await end(app, noResponder)).json(), { ended: true });
  assert.deepEqual(await (await end(app, noResponder)).json(), { ended: true });
});

test('a stale end page cannot disconnect a replacement respondent on retry', async t => {
  const app = await service(t);
  const page = await review(app);
  const original = app.relay.connect({ worker: 'original-author' });
  app.store.importReport({ title: 'Updated', source: 'A new report revision.' });
  const stale = await end(app, page);
  assert.equal(stale.status, 409);
  assert.equal(app.relay.session.id, original.session_id);
  app.relay.disconnect(original);
  const replacement = app.relay.connect({ worker: 'replacement-author' });
  const retry = await end(app, { ...page, revision_id: app.store.revisionId() });
  assert.equal(retry.status, 409);
  assert.match((await retry.json()).error, /expired/);
  assert.equal(app.relay.session.id, replacement.session_id);
});

test('ending one review page retires sibling pages before they can target a replacement', async t => {
  const app = await service(t);
  app.relay.connect({ worker: 'original-author' });
  const page = await review(app);
  const sibling = await review(app);
  assert.deepEqual(await (await end(app, page)).json(), { ended: true });
  const replacement = app.relay.connect({ worker: 'replacement-author' });
  const result = await end(app, sibling);
  assert.equal(result.status, 409);
  assert.match((await result.json()).error, /expired/);
  assert.equal(app.relay.session.id, replacement.session_id);
  app.relay.disconnect(replacement);
  assert.deepEqual(await (await end(app, await review(app))).json(), { ended: true });
});

test('end actions retire when the bound respondent is replaced before delivery', async t => {
  const app = await service(t);
  const original = app.relay.connect({ worker: 'original-author' });
  const lostPage = await review(app);
  app.relay.disconnect(original);
  const replacement = app.relay.connect({ worker: 'replacement-author' });
  const lost = await end(app, { ...lostPage, revision_id: app.store.revisionId() });
  assert.equal(lost.status, 409);
  assert.match((await lost.json()).error, /reload/i);
  assert.equal(app.relay.session.id, replacement.session_id);
  const fresh = await review(app);
  assert.deepEqual(await (await end(app, fresh)).json(), { ended: true });
  assert.equal(app.relay.status().state, 'unavailable');

  const delayedOriginal = app.relay.connect({ worker: 'delayed-original' });
  const delayedPage = await review(app);
  const held = holdEnd(app, delayedPage);
  await new Promise(resolve => setImmediate(resolve));
  app.relay.disconnect(delayedOriginal);
  const delayedReplacement = app.relay.connect({ worker: 'delayed-replacement' });
  held.release();
  const delayed = await held.done;
  assert.equal(delayed.status, 409);
  assert.match(delayed.body.error, /reload/i);
  assert.equal(app.relay.session.id, delayedReplacement.session_id);
  assert.deepEqual(await (await end(app, await review(app))).json(), { ended: true });
});

test('the running JSONL respondent naturally detaches after the reader ends a review', async t => {
  const app = await service(t);
  const input = new PassThrough(), output = new PassThrough();
  const events = []; let partial = '';
  output.on('data', chunk => {
    partial += chunk;
    let end;
    while ((end = partial.indexOf('\n')) >= 0) { events.push(JSON.parse(partial.slice(0, end))); partial = partial.slice(end + 1); }
  });
  const running = runLocalAgent({ base: app.origin, input, output, interval: 20 });
  t.after(() => { input.end(); return running; });
  input.write(JSON.stringify({ type: 'ready', worker: 'end-review-jsonl-fixture' }) + '\n');
  await waitFor(() => events.some(e => e.type === 'connected'));
  const thread = app.store.question(questionInput(app.store.current()));
  await waitFor(() => events.some(e => e.type === 'request'));
  assert.deepEqual(await (await end(app, await review(app))).json(), { ended: true });
  await waitFor(() => events.some(e => e.type === 'stopped'));
  await running;
  assert.equal(app.store.thread(thread.id).request_status, 'failed');
  assert.equal(app.server.listening, true);
  assert.equal((await fetch(app.origin)).status, 200);
  assert.equal(app.relay.status().state, 'unavailable');
});

test('retired review pages refuse instead of retargeting the active respondent', async t => {
  const app = await service(t);
  const oldPage = await review(app);
  for (let i = 0; i < 1000; i++) await (await fetch(app.origin)).text();
  const session = app.relay.connect({ worker: 'retired-page-fixture' });
  const result = await end(app, oldPage);
  assert.equal(result.status, 409);
  assert.match((await result.json()).error, /expired/);
  assert.equal(app.relay.session.id, session.session_id);
  assert.deepEqual(await (await end(app, await review(app))).json(), { ended: true });
});
