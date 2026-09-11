import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/server.js';
import { runFakeAgent } from '../src/fake-agent.js';
import { temporaryDb, questionInput } from '../test-support/helpers.js';

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
  window.AbortSignal = AbortSignal;
  window.confirm = () => { assert.fail('Reader must not confirm local draft actions'); };
  window.scrollBy = (x, y) => { window.lastScrollDelta = y; };
  window.scrollTo = (x, y) => { window.lastScrollPosition = y; };
  window.HTMLElement.prototype.scrollIntoView = function () { window.lastScrolled = this.id; };
  setup(window);
  let poll;
  window.setInterval = fn => { poll = fn; };
  await window.eval(`(async () => { ${readFileSync('public/app.js', 'utf8')} })()`);
  return { dom, window, $: id => window.document.getElementById(id), poll: () => poll() };
}
async function service(t, source = '# Heading\n\nAn exact **quoted** passage.\n\nKeep this.') {
  const app = createApp({ dbPath: temporaryDb(t) });
  if (source) app.store.importReport({ title: '<img src=x onerror=alert(1)> Report', source });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  return { ...app, origin: `http://127.0.0.1:${app.server.address().port}` };
}
function submit(ui, id) {
  ui.$(id).dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
}
function choose(ui, id) {
  ui.$('thread-select').value = id;
  ui.$('thread-select').dispatchEvent(new ui.window.Event('change'));
}
function setFollowup(ui, text) {
  ui.$('followup').value = text;
  ui.$('followup').dispatchEvent(new ui.window.Event('input'));
}

test('reader receives workflow imports; selected quote opens a draft, saved chat renders safe Markdown and survives reload', async t => {
  const app = await service(t, null);
  let ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  assert.match(ui.$('report').textContent, /conversation that produced/);
  const forbidden = /Import \/ new revision|Connect local agent|Local agent · unavailable|Durable conversations, temporary bubbles|^Show$/;
  assert.equal([...ui.window.document.querySelectorAll('button,label,p')].some(element => forbidden.test(element.textContent)), false);
  const doc = app.store.importReport({ title: '<img src=x> Report', source: '# Heading\n\nAn exact **quoted** passage.\n\nKeep this.' });
  const session = app.relay.connect({ worker: 'original-author' });
  await ui.poll();
  assert.equal(ui.$('answer-alert').hidden, true, 'normal responder presence is invisible');
  assert.equal(ui.$('report-title').querySelector('img'), null);
  assert.equal(ui.$('toc').querySelector('a').textContent, 'Heading');
  const paragraph = ui.$('report').querySelector('p');
  const range = ui.window.document.createRange();
  range.selectNodeContents(paragraph.querySelector('strong'));
  ui.window.getSelection().addRange(range);
  paragraph.dispatchEvent(new ui.window.MouseEvent('mouseup', { bubbles: true }));
  paragraph.click();
  assert.equal(ui.$('bubble-quote').textContent, 'quoted');
  ui.$('question').value = '<script>Is this safe?</script>';
  submit(ui, 'question-form');
  await waitFor(() => ui.$('chat-status').textContent.includes('waiting'));
  const thread = app.store.threads()[0];
  assert.equal(thread.quote, 'quoted');
  assert.equal(ui.$('bubble').hidden, true);
  assert.equal(ui.window.lastScrolled, undefined);
  assert.equal(ui.$('report').querySelector('p'), paragraph);
  const request = app.relay.reserve(session);
  app.store.answer(request.request_id, { lease_token: request.lease_token, status: 'answered',
    body: '## Answer\n\nUse **local** context.\n\n- First\n- Second\n\n```js\nconst n = 2;\n```\n\n<script>alert(1)</script>\n\n![remote](https://invalid.example/pixel) [unsafe](javascript:alert(1))',
    citations: [{ revision_id: doc.id, block_id: thread.block_id, quote: thread.quote }] });
  app.relay.answered(request.request_id);
  await ui.poll();
  assert.equal(ui.$('messages').querySelectorAll('script,img,iframe').length, 0);
  assert.equal(ui.$('messages').querySelectorAll('a[href^="javascript:"]').length, 0);
  assert.equal(ui.$('messages').querySelector('.markdown strong').textContent, 'local');
  assert.equal(ui.$('messages').querySelectorAll('.markdown li').length, 2);
  assert.match(ui.$('messages').querySelector('.markdown pre code').textContent, /const n = 2/);
  assert.match(ui.$('messages').textContent, /<script>Is this safe\?<\/script>/);
  assert.equal(ui.$('messages').querySelectorAll('.citation').length, 1);
  assert.equal(ui.$('messages').querySelectorAll('[data-block-id]').length, 0, 'reply headings cannot impersonate report anchors');
  ui.dom.window.close(); ui = await reader(app.origin);
  assert.equal(ui.$('bubble').hidden, true);
  assert.equal(ui.$('thread-select').options.length, 1);
  assert.match(ui.$('messages').textContent, /Use local context/);
  assert.equal(ui.window.lastScrolled, undefined, 'restoring/selecting chat never scrolls the report silently');
  ui.$('go-source').click();
  assert.equal(ui.window.lastScrolled, `b-${thread.block_id}`);
  app.relay.disconnect(session);
});

test('continuous chat preserves per-thread drafts, chronology and an uncertain follow-up retry', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const first = app.store.question(questionInput(doc, { client_key: 'one', quote: 'quoted', question: 'First\nquestion '.repeat(30) }));
  await runFakeAgent(app.origin);
  const second = app.store.question(questionInput(doc, { client_key: 'two', quote: 'quoted', question: 'Another question' }));
  await runFakeAgent(app.origin);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  assert.equal(ui.$('threads-panel').hidden, false);
  assert.equal(ui.$('thread-select').options.length, 2);
  for (const option of ui.$('thread-select').options) {
    assert.ok(option.textContent.length <= 80);
    assert.doesNotMatch(option.textContent, /\n/);
  }
  choose(ui, first.id);
  await waitFor(() => !app.store.conversation(first.id).unread);
  await waitFor(() => ui.$('mark-read').hidden);
  setFollowup(ui, 'A draft about the first quote');
  choose(ui, second.id);
  await waitFor(() => !app.store.conversation(second.id).unread);
  await waitFor(() => ui.$('mark-read').hidden);
  assert.equal(ui.$('followup').value, '');
  setFollowup(ui, 'Second draft');
  choose(ui, first.id);
  assert.equal(ui.$('followup').value, 'A draft about the first quote');
  const normalFetch = ui.window.fetch;
  let lost = false;
  ui.window.fetch = async (path, init) => {
    const response = await normalFetch(path, init);
    if (path.endsWith('/questions') && !lost) { lost = true; throw new Error('Lost acknowledgement'); }
    return response;
  };
  submit(ui, 'followup-form');
  await waitFor(() => ui.$('followup-status').textContent.includes('Retry sends'));
  await ui.poll();
  assert.equal(ui.$('followup-submit').disabled, false, 'lost save can be retried even while its durable request is waiting');
  submit(ui, 'followup-form');
  await waitFor(() => ui.$('followup').value === '');
  assert.equal(app.store.conversation(first.id).messages.length, 3);
  await runFakeAgent(app.origin); await ui.poll();
  assert.equal(ui.$('messages').querySelectorAll('.message').length, 4);
  assert.match(ui.$('messages').textContent, /Demo adapter · not AI/);
  assert.equal(ui.$('thread-select').options.length, 2, 'follow-ups do not create another dropdown entry');
  choose(ui, second.id);
  assert.equal(ui.$('followup').value, 'Second draft');
  await waitFor(() => ui.$('mark-read').hidden);
});

test('local drafts close silently with button, Escape, replacement and page departure; Contents collapses independently', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const paragraphs = ui.$('report').querySelectorAll('p');
  paragraphs[0].click(); ui.$('question').value = 'Unsent';
  ui.$('bubble-close').click();
  assert.equal(ui.$('bubble').hidden, true);
  paragraphs[0].click(); ui.$('question').value = 'Another unsent';
  ui.window.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(ui.$('bubble').hidden, true);
  paragraphs[0].click(); ui.$('question').value = 'Replaced'; paragraphs[1].click();
  assert.equal(ui.$('question').value, '');
  ui.$('question').value = 'Leaving';
  const leaving = new ui.window.Event('beforeunload', { cancelable: true });
  ui.window.dispatchEvent(leaving);
  assert.equal(leaving.defaultPrevented, false);
  assert.equal(app.store.threads().length, 0);
  const reportNode = ui.$('report').firstElementChild;
  ui.$('toc-toggle').click();
  assert.equal(ui.$('toc-panel').hidden, true);
  assert.equal(ui.$('toc-toggle').getAttribute('aria-expanded'), 'false');
  await ui.poll();
  assert.equal(ui.$('toc-panel').hidden, true);
  ui.$('toc-toggle').click();
  assert.equal(ui.$('toc-panel').hidden, false);
  assert.equal(ui.$('toc-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(ui.$('report').firstElementChild, reportNode);
});

test('selection rejects multiple passages and oversized quotes; keyboard selection retains the exact substring', async t => {
  const app = await service(t, 'A short passage.\n\n' + 'word '.repeat(500));
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const paragraphs = ui.$('report').querySelectorAll('p');
  const selection = ui.window.getSelection();
  const range = ui.window.document.createRange();
  range.setStart(paragraphs[0].firstChild, 2); range.setEnd(paragraphs[1].firstChild, 3);
  selection.addRange(range); paragraphs[0].dispatchEvent(new ui.window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(ui.$('bubble').hidden, true);
  assert.match(ui.$('notice').textContent, /single semantic passage/);
  selection.removeAllRanges(); range.selectNodeContents(paragraphs[1]); selection.addRange(range);
  paragraphs[1].dispatchEvent(new ui.window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(ui.$('bubble').hidden, true);
  assert.match(ui.$('notice').textContent, /2,000/);
  selection.removeAllRanges(); range.setStart(paragraphs[0].firstChild, 2); range.setEnd(paragraphs[0].firstChild, 7); selection.addRange(range);
  paragraphs[0].dispatchEvent(new ui.window.KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
  assert.equal(ui.$('bubble-quote').textContent, 'short');
});

test('live revisions keep safe reading anchors, old drafts and chat provenance without silent remapping', async t => {
  const app = await service(t, '# Rapport\n\nContexte original.\n\nPassage stable.');
  const first = app.store.current();
  const ui = await reader(app.origin, window => {
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      const changed = window.document.getElementById('report').textContent.includes('modifié');
      const top = this.textContent === 'Passage stable.' ? (changed ? 160 : 90) : 500;
      return { top, bottom: this.classList.contains('topbar') ? 70 : top + 30, right: 800 };
    };
  });
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click(); ui.$('question').value = 'Que signifie ce passage ?';
  app.store.importReport({ title: 'Rapport', source: '# Rapport\n\nContexte modifié.\n\nPassage stable.' });
  await ui.poll();
  assert.equal(ui.window.lastScrollDelta, 70);
  assert.equal(ui.$('question').value, 'Que signifie ce passage ?');
  assert.equal(ui.$('bubble-quote').textContent, 'Contexte original.');
  assert.match(ui.$('bubble-anchor').textContent, /Passage to review.*original revision 1/);
  submit(ui, 'question-form');
  await waitFor(() => ui.$('chat-status').textContent.includes('waiting'));
  assert.match(ui.$('chat-anchor').textContent, /Passage to review/);
  assert.equal(ui.$('go-source').hidden, true);
  assert.match(ui.$('snapshot-text').textContent, /Contexte original/);
  const thread = app.store.threads()[0];
  assert.equal(thread.revision_id, first.id);
  await runFakeAgent(app.origin); await ui.poll();
  ui.$('close-thread').click();
  await waitFor(() => ui.$('close-thread').textContent === 'Reopen thread');
  assert.equal(ui.$('thread-select').options.length, 1);
  assert.match(ui.$('thread-select').textContent, /passage to review/);
  app.store.importReport({ title: 'Rapport', source: first.source }); await ui.poll();
  assert.equal(app.store.thread(thread.id).anchor_status, 'needs_review');
  assert.equal(ui.$('report').querySelector('.selected-passage'), null);
  const reportNode = ui.$('report').firstElementChild;
  await ui.poll();
  assert.equal(ui.$('report').firstElementChild, reportNode);
});

test('lost presence and timeouts alert actionably, preserve failures and do not overwrite draft retry state', async t => {
  let now = Date.now();
  const app = createApp({ dbPath: temporaryDb(t), now: () => now });
  app.store.importReport({ title: 'Report', source: 'Local context.' });
  const session = app.relay.connect({ worker: 'original-author' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const ui = await reader(`http://127.0.0.1:${app.server.address().port}`);
  t.after(() => ui.dom.window.close());
  assert.equal(ui.$('answer-alert').hidden, true);
  ui.$('report').querySelector('p').click(); ui.$('question').value = 'Why?'; submit(ui, 'question-form');
  await waitFor(() => ui.$('chat-status').textContent.includes('waiting'));
  app.relay.reserve(session);
  for (let i = 0; i < 12; i++) { now += 10_000; app.relay.heartbeat(session); }
  await ui.poll();
  assert.equal(ui.$('answer-alert').hidden, false);
  assert.match(ui.$('answer-alert').textContent, /follow-up/);
  assert.match(ui.$('messages').textContent, /120 seconds/);
  now += 20_001; await ui.poll();
  assert.match(ui.$('answer-alert').textContent, /Return to the conversation.*resume/);
  ui.$('report').querySelector('p').click(); ui.$('question').value = 'Retry me';
  ui.window.fetch = async () => { throw new Error('Disconnected'); };
  submit(ui, 'question-form');
  await waitFor(() => ui.$('bubble-status').textContent.includes('Retry sends'));
  await ui.poll();
  assert.match(ui.$('bubble-status').textContent, /Retry sends/);
  assert.match(ui.$('notice').textContent, /Saved threads remain on disk/);
});

test('uncertain initial save reuses payload and client key without duplicating its conversation', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click(); ui.$('question').value = 'Retry me';
  const normalFetch = ui.window.fetch;
  let lost = false;
  ui.window.fetch = async (path, init) => {
    const response = await normalFetch(path, init);
    if (path === '/api/questions' && !lost) { lost = true; throw new Error('Lost response'); }
    return response;
  };
  submit(ui, 'question-form');
  await waitFor(() => ui.$('bubble-status').textContent.includes('Retry sends'));
  assert.equal(app.store.threads().length, 1);
  submit(ui, 'question-form');
  await waitFor(() => ui.$('chat-status').textContent.includes('waiting'));
  assert.equal(ui.$('thread-select').options.length, 1);
  assert.equal(app.store.threads().length, 1);
});

test('closed initial save refreshes threads without stealing the selected conversation', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const first = app.store.question(questionInput(doc, { client_key: 'existing-one', quote: 'quoted', question: 'Existing first' }));
  const second = app.store.question(questionInput(doc, { client_key: 'existing-two', quote: 'quoted', question: 'Existing second' }));
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  choose(ui, first.id);
  const normalFetch = ui.window.fetch;
  let pending;
  ui.window.fetch = (path, init) => {
    if (path === '/api/questions') {
      pending = { init };
      return new Promise(resolve => { pending.resolve = resolve; });
    }
    return normalFetch(path, init);
  };
  ui.$('report').querySelector('p').click();
  ui.$('question').value = 'Save this question';
  submit(ui, 'question-form');
  await waitFor(() => pending);
  ui.$('bubble-close').click();
  choose(ui, second.id);
  assert.equal(ui.$('thread-select').value, second.id);
  pending.resolve(await normalFetch('/api/questions', pending.init));
  await waitFor(() => ui.$('thread-select').options.length === 3 && ui.$('notice').textContent.includes('Question saved'));
  assert.equal(ui.$('thread-select').value, second.id);
  assert.match(ui.$('messages').textContent, /Existing second/);
});

test('closed initial save preserves a newly selected passage and the empty chat view', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const normalFetch = ui.window.fetch;
  let pending;
  ui.window.fetch = (path, init) => {
    if (path === '/api/questions') {
      pending = { init };
      return new Promise(resolve => { pending.resolve = resolve; });
    }
    return normalFetch(path, init);
  };
  const paragraphs = ui.$('report').querySelectorAll('p');
  paragraphs[0].click();
  ui.$('question').value = 'Save this question';
  submit(ui, 'question-form');
  await waitFor(() => pending);
  ui.$('bubble-close').click();
  paragraphs[1].click();
  assert.equal(ui.$('bubble-quote').textContent, 'Keep this.');
  pending.resolve(await normalFetch('/api/questions', pending.init));
  await waitFor(() => ui.$('thread-select').options.length === 1 && ui.$('notice').textContent.includes('Question saved'));
  assert.equal(ui.$('thread-select').value, '');
  assert.equal(ui.$('chat').hidden, true);
  assert.equal(ui.$('bubble-quote').textContent, 'Keep this.');
});

test('question bubble fits the usable narrow viewport', async t => {
  const app = await service(t);
  const ui = await reader(app.origin, window => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window.document.documentElement, 'clientWidth', { configurable: true, value: 375 });
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ top: 100, right: 195 });
  });
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click();
  const bubble = ui.$('bubble');
  assert.ok(Number.parseFloat(bubble.style.left) + Number.parseFloat(bubble.style.width) <= 375);
});

test('unchanged polls preserve the native thread choices, focus and draft without DOM mutations', async t => {
  const app = await service(t);
  const session = app.relay.connect({ worker: 'original-author' });
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  async function assertQuietPoll() {
    const mutations = [];
    const observer = new ui.window.MutationObserver(records => mutations.push(...records));
    observer.observe(ui.window.document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    await ui.poll();
    observer.disconnect();
    assert.deepEqual(mutations.map(record => record.target.id), [], 'idle polling must not invalidate native controls or accessibility snapshots');
  }
  ui.$('report').querySelector('p').click();
  ui.$('question').value = 'Unsent draft';
  await assertQuietPoll();
  assert.equal(ui.$('question').value, 'Unsent draft');
  assert.equal(ui.window.document.activeElement, ui.$('question'));
  ui.$('bubble-close').click();
  app.store.question(questionInput(app.store.current(), { quote: 'quoted' }));
  await ui.poll();
  const option = ui.$('thread-select').firstElementChild;
  ui.$('thread-select').focus();
  await assertQuietPoll();
  assert.equal(ui.$('thread-select').firstElementChild, option);
  assert.equal(ui.window.document.activeElement, ui.$('thread-select'));
  app.relay.disconnect(session);
  await ui.poll();
  assert.equal(ui.$('answer-alert').hidden, false, 'real presence changes still alert');
  await assertQuietPoll();
});
