import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { localUrl } from '../src/fake-agent.js';
import { temporaryDb, questionInput } from '../test-support/helpers.js';

async function start(dbPath) {
  const app = createApp({ dbPath });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return { ...app, origin: `http://127.0.0.1:${app.server.address().port}` };
}
async function stop(app) {
  await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
}
async function post(origin, path, body) {
  const response = await fetch(origin + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' }, body: JSON.stringify(body) });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}

test('HTTP import → question → fake-agent command → service restart → changed import', async t => {
  const path = temporaryDb(t);
  let app = await start(path);
  t.after(async () => { if (app.server.listening) await stop(app); });
  const doc = await post(app.origin, '/api/document', { title: 'Walkthrough', source: '# H\n\nExact context.' });
  const thread = await post(app.origin, '/api/questions', questionInput(doc));
  assert.equal(thread.request_status, 'waiting');
  const child = spawn(process.execPath, ['src/fake-agent.js'], { env: { ...process.env, SILLAGE_URL: app.origin } });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => errors += chunk);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, errors);
  assert.equal(JSON.parse(output).status, 'answered');
  await stop(app);
  app = await start(path);
  const saved = await (await fetch(`${app.origin}/api/threads/${thread.id}`)).json();
  assert.equal(saved.messages.length, 2);
  assert.match(saved.messages[1].body, /demonstration only/);
  assert.equal(saved.messages[1].citations[0].quote, 'Exact context.');
  await post(app.origin, '/api/document', { title: 'Walkthrough', source: '# H\n\nChanged context.' });
  const after = await (await fetch(`${app.origin}/api/threads/${thread.id}`)).json();
  assert.equal(after.anchor_status, 'needs_review');
  assert.equal(after.messages.length, 2);
  assert.equal(after.quote, 'Exact context.');
});

test('HTTP surface rejects foreign origins, DNS rebinding, form CSRF, paths and malformed bodies', async t => {
  const app = await start(temporaryDb(t));
  t.after(() => stop(app));
  const foreign = await fetch(app.origin + '/api/threads', { headers: { Origin: 'https://attacker.test' } });
  assert.equal(foreign.status, 403);
  const fetchSite = await fetch(app.origin + '/api/threads', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(fetchSite.status, 403);
  const badHost = await new Promise((resolve, reject) => {
    http.get(app.origin + '/', { headers: { Host: 'attacker.test' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(app.origin + '/api/document', { method: 'POST', body: 'source=x' })).status, 415);
  assert.equal((await fetch(app.origin + '/api/document', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' }, body: 'null' })).status, 400);
  assert.equal((await fetch(app.origin + '/api/document', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' }, body: '{oops' })).status, 400);
  assert.equal((await fetch(app.origin + '/api/document', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' }, body: 'x'.repeat(2_000_001) })).status, 413);
  assert.equal((await fetch(app.origin + '/src/store.js')).status, 404);
  const page = await fetch(app.origin);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.match(await page.text(), /Sillage AXI/);
});

test('simultaneous HTTP pollers receive at most one live reservation', async t => {
  const app = await start(temporaryDb(t));
  t.after(() => stop(app));
  const doc = await post(app.origin, '/api/document', { title: 'Test', source: 'Exact context.' });
  await post(app.origin, '/api/questions', questionInput(doc));
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post(app.origin, '/api/agent/reserve', { worker: `worker-${i}` })));
  assert.equal(results.filter(r => r.request).length, 1);
});

test('legacy HTTP reservations cannot self-declare managed ownership', async t => {
  const app = await start(temporaryDb(t));
  t.after(() => stop(app));
  const doc = await post(app.origin, '/api/document', { title: 'Test', source: 'Exact context.' });
  await post(app.origin, '/api/questions', questionInput(doc));
  const { request } = await post(app.origin, '/api/agent/reserve', {
    worker: 'local-session:legacy', managed: true,
  });
  assert.equal(app.store.db.prepare('SELECT managed FROM requests WHERE id=?').get(request.request_id).managed, 0);
});

test('fake adapter refuses non-loopback destinations and credential-bearing URLs', () => {
  assert.equal(localUrl('http://127.0.0.1:3210'), 'http://127.0.0.1:3210');
  for (const value of ['https://example.test', 'http://example.test', 'http://127.0.0.1.evil.test',
    'http://secret@localhost:3210', 'http://localhost:3210/path', 'file:///etc/passwd']) {
    assert.throws(() => localUrl(value));
  }
});

test('bundled mark is a fixed safe asset, not an SVG or filesystem upload surface', async t => {
  const app = await start(temporaryDb(t));
  t.after(() => stop(app));
  const response = await fetch(app.origin + '/sillage.svg');
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  const svg = await response.text();
  assert.match(svg, /<svg.*viewBox="0 0 32 32"/);
  assert.doesNotMatch(svg, /<(?:script|image|foreignObject|style|use|animate)|\bon\w+=|\bhref=|url\(/i);
  assert.deepEqual([...svg.matchAll(/<([a-zA-Z]+)/g)].map(m => m[1]), ['svg', 'rect', 'path']);
  const page = await (await fetch(app.origin)).text();
  assert.match(page, /rel="icon" href="\/sillage.svg"/);
  assert.match(page, /src="\/sillage.svg" width="28" height="28" alt=""/);
  assert.equal((await fetch(app.origin + '/private-report.md')).status, 404);
  const state = await (await fetch(app.origin + '/api/state')).json();
  assert.equal(state.revision_id, null);
  assert.equal(state.agent.state, 'unavailable');
  assert.equal((await fetch(app.origin + '/api/agent/connect', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1', Origin: 'https://evil.test' },
    body: '{"worker":"bad"}' })).status, 403);
  assert.equal((await fetch(app.origin + '/api/agent/heartbeat', { method: 'POST', body: '{}' })).status, 415);
});
