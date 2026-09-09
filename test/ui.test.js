import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/server.js';
import { runFakeAgent } from '../src/fake-agent.js';
import { temporaryDb } from '../test-support/helpers.js';

async function waitFor(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('DOM condition timed out');
}
async function reader(origin, setup = () => {}) {
  const dom = new JSDOM(readFileSync('public/index.html', 'utf8'), { url: origin, runScripts: 'outside-only' });
  const { window } = dom;
  window.fetch = (path, init) => fetch(origin + path, init);
  window.confirm = () => true;
  window.scrollBy = (x, y) => { window.lastScrollDelta = y; };
  window.scrollTo = (x, y) => { window.lastScrollPosition = y; };
  window.HTMLElement.prototype.scrollIntoView = function () { window.lastScrolled = this.id; };
  setup(window);
  let poll;
  window.setInterval = fn => { poll = fn; };
  await window.eval(`(async () => { ${readFileSync('public/app.js', 'utf8')} })()`);
  return { dom, window, $: id => window.document.getElementById(id), poll: () => poll() };
}
function submit(ui, id) {
  ui.$(id).dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
}

test('reader DOM workflow: import, selected quote, waiting, reply, close, reload, unmatched snapshot', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  let ui = await reader(origin);
  t.after(() => ui.dom.window.close());
  ui.$('title').value = '<img src=x onerror=alert(1)> Report';
  ui.$('source').value = '# Heading\n\nAn exact **quoted** passage.\n\nKeep this.';
  submit(ui, 'import-form');
  await waitFor(() => ui.$('report').querySelector('p'));
  assert.equal(ui.$('report-title').querySelector('img'), null);
  assert.equal(ui.$('toc').querySelector('a').textContent, 'Heading');
  const paragraph = ui.$('report').querySelector('p');
  const range = ui.window.document.createRange();
  range.selectNodeContents(paragraph.querySelector('strong'));
  ui.window.getSelection().addRange(range);
  paragraph.dispatchEvent(new ui.window.MouseEvent('mouseup', { bubbles: true }));
  paragraph.click(); // trailing click must not turn a short selection into the whole passage
  assert.equal(ui.$('bubble-quote').textContent, 'quoted');
  assert.equal(ui.$('bubble').hidden, false);
  ui.$('question').value = '<script>Is this safe?</script>';
  submit(ui, 'question-form');
  await waitFor(() => ui.$('bubble-status').textContent.includes('waiting'));
  const thread = app.store.threads()[0];
  assert.equal(thread.quote, 'quoted');
  assert.equal(ui.window.lastScrolled, undefined, 'saving must not scroll/rebuild the report');
  assert.equal(ui.$('report').querySelector('p'), paragraph);
  await runFakeAgent(origin);
  await ui.poll();
  assert.match(ui.$('bubble-status').textContent, /demo result — not an AI answer/);
  assert.equal(ui.$('messages').querySelectorAll('script,img').length, 0);
  assert.match(ui.$('messages').textContent, /<script>Is this safe\?<\/script>/);
  assert.equal(ui.$('messages').querySelectorAll('.citation').length, 1);
  ui.$('bubble-close').click();
  assert.equal(ui.$('bubble').hidden, true);
  assert.equal(app.store.threads().length, 1);
  ui.dom.window.close();
  ui = await reader(origin);
  assert.equal(ui.$('bubble').hidden, true, 'bubbles are temporary, not restored inline');
  assert.match(ui.$('threads').textContent, /unread/);
  ui.$('threads').querySelector('button').click();
  await waitFor(() => ui.$('bubble').hidden === false);
  assert.equal(ui.window.lastScrolled, `b-${thread.block_id}`);
  await waitFor(() => app.store.thread(thread.id).unread === 0);
  ui.$('bubble-close').click();
  ui.$('source').value = '# Heading\n\nA changed passage.\n\nKeep this.';
  submit(ui, 'import-form');
  await waitFor(() => ui.$('revision').textContent.includes('Revision 2'));
  await ui.poll();
  await waitFor(() => ui.$('threads').textContent.includes('passage to review'));
  ui.$('threads').querySelector('button').click();
  assert.match(ui.$('bubble-anchor').textContent, /Passage to review/);
  assert.equal(ui.$('go-source').hidden, true);
  assert.equal(ui.$('bubble-quote').textContent, 'quoted');
  assert.match(ui.$('snapshot-text').textContent, /An exact \*\*quoted\*\* passage/);
  assert.match(ui.$('messages').textContent, /Local fake agent/);
  ui.$('close-thread').click();
  await waitFor(() => app.store.thread(thread.id).closed === 1);
  // The database changes before the PATCH handler finishes refreshing the UI.
  // Wait for its rendered result before teardown closes the jsdom document.
  await waitFor(() => ui.$('close-thread').textContent === 'Reopen thread');
  assert.match(ui.$('threads').textContent, /passage to review/, 'unmatched stays visible even if closed');
});

test('uncertain save retry reuses payload and client key instead of creating a duplicate', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  app.store.importReport({ title: 'Retry', source: 'Exact context.' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const ui = await reader(origin);
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click();
  ui.$('question').value = 'Retry me';
  const normalFetch = ui.window.fetch;
  let lost = false;
  ui.window.fetch = async (path, init) => {
    const response = await normalFetch(path, init);
    if (path === '/api/questions' && !lost) { lost = true; throw new Error('Simulated lost response'); }
    return response;
  };
  submit(ui, 'question-form');
  await waitFor(() => ui.$('bubble-status').textContent.includes('Retry sends'));
  assert.equal(app.store.threads().length, 1);
  submit(ui, 'question-form');
  await waitFor(() => ui.$('bubble-status').textContent.includes('waiting'));
  // "Waiting" is drawn before the submit handler's final thread-list fetch.
  await waitFor(() => ui.$('threads').querySelector('[data-thread-id]'));
  assert.equal(app.store.threads().length, 1);
});

test('compact durable threads are hidden by default; local-agent presence and connect path are visible', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  const doc = app.store.importReport({ title: 'Threads', source: 'A passage about local report provenance.' });
  const block = doc.blocks[0];
  const thread = app.store.question({ revision_id: doc.id, block_id: block.id, quote: block.source,
    question: 'A long question about provenance. '.repeat(20), client_key: 'compact' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const ui = await reader(`http://127.0.0.1:${app.server.address().port}`);
  t.after(() => ui.dom.window.close());
  assert.equal(ui.$('threads-panel').hidden, true);
  assert.equal(ui.$('threads-toggle').getAttribute('aria-expanded'), 'false');
  assert.match(ui.$('agent-state').textContent, /unavailable/);
  ui.$('agent-toggle').click();
  assert.equal(ui.$('agent-panel').hidden, false);
  assert.match(ui.$('agent-panel').textContent, /npm run local-agent/);
  assert.equal(ui.$('question-submit').textContent, 'Ask question');
  ui.$('threads-toggle').click();
  assert.equal(ui.$('threads-panel').hidden, false);
  assert.equal(ui.$('layout').classList.contains('threads-open'), true);
  const entry = ui.$('threads').querySelector('.thread-entry');
  assert.ok(entry.querySelector('strong').textContent.length <= 72);
  assert.ok(entry.querySelector('.thread-summary').textContent.length <= 107);
  assert.equal(entry.querySelectorAll('q,.message,blockquote').length, 0);
  entry.click();
  assert.match(ui.$('bubble-status').textContent, /waiting.*unavailable/);
  assert.equal(ui.$('bubble-agent').hidden, false);
  const session = app.relay.connect({ worker: '<img src=x> local' });
  await ui.poll();
  assert.match(ui.$('agent-state').textContent, /active/);
  assert.equal(ui.$('agent-detail').querySelector('img'), null);
  assert.match(ui.$('bubble-status').textContent, /active local agent/);
  const request = app.relay.reserve(session);
  app.store.answer(request.request_id, { lease_token: request.lease_token, status: 'answered', body: 'An actual supplied reply.', citations: [] });
  app.relay.answered(request.request_id);
  await ui.poll();
  assert.match(ui.$('messages').textContent, /An actual supplied reply/);
  ui.$('bubble-close').click();
  ui.$('threads-toggle').click();
  assert.equal(app.store.thread(thread.id).messages.length, 2);
  assert.equal(ui.$('bubble').hidden, true);
  app.relay.disconnect(session);
  await ui.poll();
  assert.match(ui.$('agent-state').textContent, /unavailable/);
});

test('live imports update even with no threads, keep safe reading anchor and original draft context', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  const first = app.store.importReport({ title: 'Rapport français', source: '# Rapport\n\nContexte original.\n\nPassage stable.' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const ui = await reader(`http://127.0.0.1:${app.server.address().port}`, window => {
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      const changed = window.document.getElementById('report').textContent.includes('modifié');
      const top = this.textContent === 'Passage stable.' ? (changed ? 160 : 90) : 500;
      return { top, bottom: this.classList.contains('topbar') ? 70 : top + 30, right: 800 };
    };
  });
  t.after(() => ui.dom.window.close());
  const oldPassage = ui.$('report').querySelector('p');
  oldPassage.click();
  ui.$('question').value = 'Que signifie ce passage ?';
  const second = app.store.importReport({ title: 'Rapport français', source: '# Rapport\n\nContexte modifié.\n\nPassage stable.' });
  await ui.poll();
  assert.match(ui.$('revision').textContent, /Revision 2/);
  assert.equal(ui.window.lastScrollDelta, 70, 'stable semantic reading anchor retains its viewport offset');
  assert.match(ui.$('report').textContent, /modifié/);
  assert.equal(ui.$('bubble').hidden, false);
  assert.equal(ui.$('question').value, 'Que signifie ce passage ?');
  assert.equal(ui.$('bubble-quote').textContent, 'Contexte original.');
  assert.match(ui.$('bubble-anchor').textContent, /Passage to review.*original revision 1/);
  assert.equal(ui.$('report').querySelector('.selected-passage'), null);
  submit(ui, 'question-form');
  await waitFor(() => ui.$('threads').querySelector('button'));
  const thread = app.store.threads()[0];
  assert.equal(thread.revision_id, first.id);
  assert.equal(thread.current_revision_id, second.id);
  assert.equal(thread.anchor_status, 'needs_review');
  assert.match(ui.$('thread-alert').textContent, /to review/);
  assert.match(ui.$('snapshot-text').textContent, /Contexte original/);
  const reportNode = ui.$('report').firstElementChild;
  await ui.poll();
  assert.equal(ui.$('report').firstElementChild, reportNode, 'unchanged polls do not rebuild the report');
});

test('explicit read-only file capability watches changes, stops, and pauses on conflicting imports or permission loss', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  const initial = '# Rapport\n\nBonjour.';
  app.store.importReport({ title: 'Rapport', source: initial });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  let source = initial; let allowed = true; let reads = 0; let picks = 0;
  const ui = await reader(`http://127.0.0.1:${app.server.address().port}`, window => {
    window.showOpenFilePicker = async () => {
      picks++;
      return [{ getFile: async () => {
        reads++;
        if (!allowed) throw new Error('Read permission lost');
        return { name: 'rapport.md', size: source.length, text: async () => source };
      } }];
    };
  });
  t.after(() => ui.dom.window.close());
  assert.equal(reads, 0, 'no automatic filesystem capability');
  ui.$('watch-file').click();
  await waitFor(() => ui.$('watch-status').textContent.includes('Watching'));
  assert.equal(picks, 1);
  await ui.poll();
  assert.equal(app.store.current().id, 1, 'identical bytes do not create another revision');
  source = '# Rapport\n\nBonjour, révision française.';
  await ui.poll();
  assert.equal(app.store.current().id, 2);
  assert.match(ui.$('report').textContent, /révision française/);
  ui.$('stop-watch').click();
  const stoppedReads = reads;
  source = '# Rapport\n\nChangement arrêté.';
  await ui.poll();
  assert.equal(reads, stoppedReads);
  assert.equal(app.store.current().id, 2);
  ui.$('watch-file').click();
  await waitFor(() => ui.$('watch-status').textContent.includes('does not exactly match'));
  assert.equal(app.store.current().id, 2, 'connecting a different file never imports it silently');
  source = app.store.current().source;
  ui.$('watch-file').click();
  await waitFor(() => ui.$('watch-status').textContent.includes('Watching'));
  app.store.importReport({ title: 'Rapport', source: 'Révision autorisée ailleurs.' });
  await ui.poll();
  assert.match(ui.$('watch-status').textContent, /paused.*another import/);
  assert.match(ui.$('report').textContent, /autorisée ailleurs/);
  source = app.store.current().source;
  ui.$('watch-file').click();
  await waitFor(() => ui.$('watch-status').textContent.includes('Watching'));
  allowed = false;
  await ui.poll();
  assert.match(ui.$('file-state').textContent, /paused.*permission lost/);
  assert.equal(ui.$('stop-watch').hidden, true);
  assert.equal(app.store.current().id, 3);
});

test('fallback clearly requires reselect/import; responsive and pointer affordances are present', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const ui = await reader(`http://127.0.0.1:${app.server.address().port}`);
  t.after(() => ui.dom.window.close());
  assert.equal(ui.$('watch-file').disabled, true);
  assert.match(ui.$('watch-status').textContent, /reselect the file and Import revision/);
  assert.match(ui.$('import-explanation').textContent, /same report.*original quotes.*ambiguous.*never silently remapped/);
  const css = readFileSync('public/style.css', 'utf8');
  assert.match(css, /#report \[data-block-id\] \{ cursor: pointer; \}/);
  assert.match(css, /select, summary, input\[type=file\]/);
  assert.match(css, /max-width: 76ch/);
  assert.match(css, /@media \(max-width: 700px\).*flex-direction: column/s);
  assert.match(css, /max-width: 100%; overflow-x: auto/);
  assert.match(css, /:focus-visible/);
});

test('question bubble fits the usable narrow viewport', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  app.store.importReport({ title: 'Narrow', source: 'A passage.' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const ui = await reader(`http://127.0.0.1:${app.server.address().port}`, window => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window.document.documentElement, 'clientWidth', { configurable: true, value: 375 });
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      return { top: 100, right: 195 };
    };
  });
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click();
  const bubble = ui.$('bubble');
  const right = Number.parseFloat(bubble.style.left) + Number.parseFloat(bubble.style.width);
  assert.ok(right <= 375, `bubble right edge ${right} exceeds client width`);
});

test('an open durable discussion updates safely through matches and ambiguity without losing provenance', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  const first = app.store.importReport({ title: 'Report', source: '# H\n\nKeep this.\n\nAnother passage.' });
  const block = first.blocks.find(b => b.source === 'Keep this.');
  const thread = app.store.question({ revision_id: first.id, block_id: block.id, quote: block.source,
    question: 'Explain this', client_key: 'live-thread' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const ui = await reader(`http://127.0.0.1:${app.server.address().port}`);
  t.after(() => ui.dom.window.close());
  ui.$('threads').querySelector('button').click();
  const oldElement = ui.$('report').querySelector('.selected-passage');
  app.store.importReport({ title: 'Report', source: '# H\n\nInserted.\n\nKeep this.\n\nAnother passage.' });
  await ui.poll();
  assert.notEqual(ui.$('report').querySelector('.selected-passage'), oldElement);
  assert.equal(ui.$('report').querySelector('.selected-passage').dataset.blockId, block.id);
  assert.match(ui.$('bubble-anchor').textContent, /Original revision 1.*matched in revision 2/);
  assert.equal(ui.$('go-source').hidden, false);
  app.store.importReport({ title: 'Report', source: '# H\n\nKeep this.\n\nKeep this.\n\nAnother passage.' });
  await ui.poll();
  assert.equal(ui.$('bubble').hidden, false);
  assert.match(ui.$('bubble-anchor').textContent, /Passage to review/);
  assert.equal(ui.$('go-source').hidden, true);
  assert.equal(ui.$('report').querySelector('.selected-passage'), null);
  assert.equal(ui.$('bubble-quote').textContent, 'Keep this.');
  app.store.importReport({ title: 'Report', source: first.source });
  await ui.poll();
  assert.equal(app.store.thread(thread.id).anchor_status, 'needs_review');
  assert.match(ui.$('bubble-anchor').textContent, /Passage to review/);
  assert.match(ui.$('snapshot-text').textContent, /Revision 1/);
});

test('connection loss makes draft presence unavailable without replacing an uncertain-save retry message', async t => {
  const app = createApp({ dbPath: temporaryDb(t) });
  app.store.importReport({ title: 'Report', source: 'Local context.' });
  app.relay.connect({ worker: 'local' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const ui = await reader(`http://127.0.0.1:${app.server.address().port}`);
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click();
  assert.match(ui.$('bubble-status').textContent, /agent active/);
  ui.window.fetch = async () => { throw new Error('Disconnected'); };
  await ui.poll();
  assert.match(ui.$('bubble-status').textContent, /unavailable/);
  assert.equal(ui.$('bubble-agent').hidden, false);
  ui.$('question').value = 'What does this mean?';
  submit(ui, 'question-form');
  await waitFor(() => ui.$('bubble-status').textContent.includes('Retry sends'));
  await ui.poll();
  assert.match(ui.$('bubble-status').textContent, /Retry sends/);
});
