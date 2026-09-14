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
  const dom = new JSDOM(await (await fetch(origin)).text(), { url: origin, runScripts: 'outside-only' });
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
  window.eval(readFileSync('public/whiteboards.js', 'utf8'));
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
  ui.$('conversation-list').open = true;
  const choice = [...ui.$('conversation-choices').querySelectorAll('button')].find(button => button.dataset.threadId === id);
  assert.ok(choice);
  choice.click();
}
function activeConversation(ui) {
  return ui.$('conversation-choices').querySelector('[aria-current=true]')?.dataset.threadId || '';
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
    body: '## Answer\n\nUse **local** context.\n\n- First\n- Second\n\n| Signal | Meaning |\n|---|---|\n| Water | Keep reserves |\n\n```js\nconst n = 2;\n```\n\n<script>alert(1)</script>\n\n![remote](https://invalid.example/pixel) [unsafe](javascript:alert(1))',
    citations: [{ revision_id: doc.id, block_id: thread.block_id, quote: thread.quote }] });
  app.relay.answered(request.request_id);
  await ui.poll();
  assert.equal(ui.$('messages').querySelectorAll('script,img,iframe').length, 0);
  assert.equal(ui.$('messages').querySelectorAll('a[href^="javascript:"]').length, 0);
  assert.equal(ui.$('messages').querySelector('.markdown strong').textContent, 'local');
  assert.equal(ui.$('messages').querySelectorAll('.markdown li').length, 2);
  assert.match(ui.$('messages').querySelector('.markdown pre code').textContent, /const n = 2/);
  const responseTable = ui.$('messages').querySelector('.markdown .table-scroll');
  assert.equal(responseTable.tabIndex, 0);
  assert.equal(responseTable.getAttribute('role'), 'region');
  assert.match(responseTable.getAttribute('aria-label'), /scroll horizontally/);
  assert.equal(responseTable.querySelector('table').textContent.includes('Keep reserves'), true);
  assert.match(ui.$('messages').textContent, /<script>Is this safe\?<\/script>/);
  assert.equal(ui.$('messages').querySelectorAll('.citation').length, 1);
  assert.equal(ui.$('messages').querySelectorAll('[data-block-id]').length, 0, 'reply headings cannot impersonate report anchors');
  ui.dom.window.close(); ui = await reader(app.origin);
  assert.equal(ui.$('bubble').hidden, true);
  assert.equal(ui.$('conversation-choices').querySelectorAll('button').length, 1);
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
  assert.equal(ui.$('conversation-choices').querySelectorAll('button').length, 2);
  assert.equal(ui.$('conversation-choices').querySelector('button strong').textContent, second.messages[0].body);
  choose(ui, first.id);
  await waitFor(() => !app.store.conversation(first.id).unread);
  await waitFor(() => ![...ui.$('conversation-choices').querySelectorAll('button')].find(b => b.dataset.threadId === first.id).textContent.includes('New reply'));
  setFollowup(ui, 'A draft about the first quote');
  choose(ui, second.id);
  await waitFor(() => !app.store.conversation(second.id).unread);
  await waitFor(() => !ui.$('conversation-choices').textContent.includes('New reply'));
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
  assert.equal(ui.$('conversation-choices').querySelectorAll('button').length, 2, 'follow-ups do not create another finder entry');
  choose(ui, second.id);
  assert.equal(ui.$('followup').value, 'Second draft');
  await ui.poll();
});

test('local drafts close silently with outside click, Escape, replacement and page departure; Contents collapses independently', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const paragraphs = ui.$('report').querySelectorAll('p');
  paragraphs[0].click(); ui.$('question').value = 'Unsent';
  ui.window.document.querySelector('.brand strong').click();
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
  assert.equal(ui.$('toc-panel').hidden, true);
  ui.$('toc-toggle').click();
  assert.equal(ui.$('toc-panel').hidden, false);
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
      if (this.id === 'reader') return { top: 70 };
      const top = this.textContent === 'Passage stable.' ? (changed ? 160 : 90) : 500;
      return { top, bottom: this.classList.contains('site-header') ? 70 : top + 30, right: 800 };
    };
  });
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click(); ui.$('question').value = 'Que signifie ce passage ?';
  app.store.importReport({ title: 'Rapport', source: '# Rapport\n\nContexte modifié.\n\nPassage stable.' });
  await ui.poll();
  assert.equal(ui.$('reader').scrollTop, 70);
  assert.equal(ui.window.lastScrollDelta, undefined);
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
  app.store.updateConversation(thread.id, { closed: true });
  await ui.poll();
  assert.match(ui.$('conversation-state').textContent, /closed/);
  assert.equal(ui.$('conversation-choices').querySelectorAll('button').length, 1);
  assert.match(ui.$('conversation-state').textContent, /passage to review/);
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
  assert.equal(ui.$('conversation-choices').querySelectorAll('button').length, 1);
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
  ui.window.document.querySelector('.brand strong').click();
  choose(ui, second.id);
  assert.equal(activeConversation(ui), second.id);
  pending.resolve(await normalFetch('/api/questions', pending.init));
  await waitFor(() => ui.$('conversation-choices').querySelectorAll('button').length === 3 && ui.$('notice').textContent.includes('Question saved'));
  assert.equal(activeConversation(ui), second.id);
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
  ui.window.document.querySelector('.brand strong').click();
  paragraphs[1].click();
  assert.equal(ui.$('bubble-quote').textContent, 'Keep this.');
  pending.resolve(await normalFetch('/api/questions', pending.init));
  await waitFor(() => ui.$('conversation-choices').querySelectorAll('button').length === 1 && ui.$('notice').textContent.includes('Question saved'));
  assert.equal(activeConversation(ui), '');
  assert.equal(ui.$('chat').hidden, true);
  assert.equal(ui.$('bubble-quote').textContent, 'Keep this.');
});

test('completed initial save closes its bubble after switching conversations', async t => {
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
  choose(ui, second.id);
  assert.equal(activeConversation(ui), second.id);
  assert.equal(ui.$('bubble').hidden, true, 'choosing another conversation is an outside click');
  pending.resolve(await normalFetch('/api/questions', pending.init));
  await waitFor(() => ui.$('conversation-choices').querySelectorAll('button').length === 3 && ui.$('notice').textContent.includes('Question saved'));
  assert.equal(ui.$('bubble').hidden, true);
  assert.equal(activeConversation(ui), second.id);
  assert.match(ui.$('messages').textContent, /Existing second/);
});

test('closed initial save keeps its exact failed payload available for retry', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const normalFetch = ui.window.fetch;
  const payloads = [];
  let attempt = 0;
  let pending;
  ui.window.fetch = (path, init) => {
    if (path === '/api/questions') {
      payloads.push(JSON.parse(init.body));
      attempt += 1;
      if (attempt === 1) return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    }
    return normalFetch(path, init);
  };
  ui.$('report').querySelector('p').click();
  ui.$('question').value = 'Keep this exact question';
  submit(ui, 'question-form');
  await waitFor(() => pending);
  ui.window.document.querySelector('.brand strong').click();
  pending.reject(new Error('Disconnected while saving'));
  await waitFor(() => !ui.$('notice-retry').hidden);
  assert.equal(ui.$('bubble').hidden, true);
  assert.match(ui.$('notice').textContent, /exact question is preserved/);
  ui.$('notice-retry').click();
  await waitFor(() => ui.$('notice').textContent === 'Question saved.');
  assert.deepEqual(payloads[1], payloads[0]);
  assert.equal(app.store.threads()[0].messages[0].body, 'Keep this exact question');
  assert.equal(ui.$('notice-retry').hidden, true);
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

test('unchanged polls preserve finder choices, focus and draft without DOM mutations', async t => {
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
  ui.window.document.querySelector('.brand strong').click();
  app.store.question(questionInput(app.store.current(), { quote: 'quoted' }));
  await ui.poll();
  const choice = ui.$('conversation-choices').firstElementChild;
  ui.$('conversation-toggle').focus();
  await assertQuietPoll();
  assert.equal(ui.$('conversation-choices').firstElementChild, choice);
  assert.equal(ui.window.document.activeElement, ui.$('conversation-toggle'));
  app.relay.disconnect(session);
  await ui.poll();
  assert.equal(ui.$('answer-alert').hidden, false, 'real presence changes still alert');
  await assertQuietPoll();
});

test('narrow arrival collapses Contents without persistence and empty chat explains how to start', async t => {
  const app = await service(t);
  const ui = await reader(app.origin, window => { window.innerWidth = 390; });
  t.after(() => ui.dom.window.close());
  assert.equal(ui.$('toc-panel').hidden, true);
  assert.equal(ui.$('toc-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.$('conversation-list').hidden, true);
  assert.equal(ui.$('chat-empty').hidden, false);
  assert.match(ui.$('chat-empty').textContent, /Ask about a passage to start/);
  ui.$('toc-toggle').click(); await ui.poll();
  assert.equal(ui.$('toc-panel').hidden, false, 'explicit reader choice survives polling');
  assert.equal(ui.window.localStorage.length, 0);
});

test('question placement uses actual bubble height and the visible viewport', async t => {
  const app = await service(t);
  const ui = await reader(app.origin, window => {
    window.innerWidth = 390; window.innerHeight = 844;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.id === 'bubble') return { height: Math.min(520, parseFloat(this.style.maxHeight) || 520) };
      if (this.classList.contains('site-header')) return { bottom: 112, height: 112 };
      if (this.id === 'question-submit') {
        const bubble = window.document.getElementById('bubble');
        const bottom = parseFloat(bubble.style.top) + bubble.getBoundingClientRect().height;
        return { top: bottom - 48, bottom };
      }
      return { top: 422, right: 360, bottom: 470 };
    };
  });
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click();
  const e = ui.$('bubble');
  assert.ok(parseFloat(e.style.top) + e.getBoundingClientRect().height <= 832);
  ui.window.innerHeight = 400;
  ui.window.dispatchEvent(new ui.window.Event('resize'));
  assert.ok(parseFloat(e.style.top) + e.getBoundingClientRect().height <= 388);
  assert.ok(ui.$('question-submit').getBoundingClientRect().bottom <= 388);
  assert.equal(ui.window.document.activeElement, ui.$('question'));
});

test('narrow answer arrival reveals its beginning when the reader is viewing the latest turn', async t => {
  const app = await service(t);
  const thread = app.store.question(questionInput(app.store.current(), { quote: 'quoted', question: 'Why?' }));
  const session = app.relay.connect({ worker: 'original-author' });
  const ui = await reader(app.origin, window => {
    window.innerWidth = 390;
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains('message') ? { top: 200, bottom: 300 } : { top: 0, bottom: 80 };
    };
    window.HTMLElement.prototype.scrollIntoView = function () {
      window.lastRevealedMessage = this.dataset.messageId;
    };
  });
  t.after(() => ui.dom.window.close());
  ui.$('show-chat').click();
  const request = app.relay.reserve(session);
  app.store.answer(request.request_id, { lease_token: request.lease_token, status: 'answered', body: 'The answer starts here.', citations: [] });
  app.relay.answered(request.request_id);
  await ui.poll();
  const answer = app.store.conversation(thread.id).messages.at(-1);
  assert.equal(ui.$('chat-scroll').scrollTop, 188);
  assert.equal(ui.$('threads-panel').hidden, false);
  app.relay.disconnect(session);
});

test('narrow question and answer saves leave report reading in place until explicit reply navigation', async t => {
  const app = await service(t);
  const session = app.relay.connect({ worker: 'original-author' });
  const ui = await reader(app.origin, window => {
    window.innerWidth = 390;
    // Even if a short report leaves chat in view, focus is still on its passage.
    window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains('message') ? { top: 200, bottom: 300 } : { top: 0, bottom: 80 };
    };
    window.HTMLElement.prototype.scrollIntoView = function () {
      window.lastRevealedMessage = this.dataset.messageId;
    };
  });
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click();
  ui.$('question').value = 'Keep the report in place';
  submit(ui, 'question-form');
  await waitFor(() => ui.$('chat-status').textContent.includes('waiting'));
  const thread = app.store.threads()[0];
  assert.equal(ui.window.lastRevealedMessage, undefined);
  const request = app.relay.reserve(session);
  app.store.answer(request.request_id, { lease_token: request.lease_token, status: 'answered', body: 'The answer begins here.', citations: [] });
  app.relay.answered(request.request_id);
  await ui.poll();
  const answer = app.store.conversation(thread.id).messages.at(-1);
  assert.equal(ui.window.lastRevealedMessage, undefined, 'answer arrival must not scroll away from the report');
  assert.equal(ui.$('latest-reply').hidden, false);
  ui.$('latest-reply').click();
  assert.equal(ui.$('chat-scroll').scrollTop, 188);
  assert.equal(ui.$('threads-panel').hidden, false);
  assert.equal(ui.window.document.activeElement.dataset.messageId, answer.id);
  assert.equal(ui.$('latest-reply').hidden, true);
  await waitFor(() => !ui.$('conversation-choices').textContent.includes('New reply'));
  app.relay.disconnect(session);
});

test('saved confirmation offers explicit navigation; quotes remain exact but display readable text', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click();
  assert.equal(ui.$('bubble-quote').textContent, 'An exact quoted passage.');
  ui.$('question').value = 'Why?'; submit(ui, 'question-form');
  await waitFor(() => ui.$('notice').textContent.includes('Question saved'));
  const thread = app.store.threads()[0];
  assert.equal(thread.quote, 'An exact **quoted** passage.');
  assert.equal(ui.$('chat-quote').textContent, 'An exact quoted passage.');
  assert.equal(ui.$('notice-chat').hidden, false);
  assert.equal(ui.window.lastScrolled, undefined);
  ui.$('notice-chat').click();
  await waitFor(() => ui.window.document.activeElement === ui.$('threads-panel'));
  assert.equal(ui.window.lastScrolled, undefined);
  assert.equal(ui.window.document.activeElement, ui.$('threads-panel'));
});

test('full conversation chooser distinguishes long questions with one keyboard-accessible finder', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const prefix = 'A long shared introduction '.repeat(5);
  const one = app.store.question(questionInput(doc, { question: prefix + 'FIRST', client_key: 'full-one', quote: 'quoted' }));
  const two = app.store.question(questionInput(doc, { question: prefix + 'SECOND', client_key: 'full-two', quote: 'quoted' }));
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const buttons = [...ui.$('conversation-choices').querySelectorAll('button')];
  assert.equal(buttons.length, 2);
  const first = buttons.find(b => b.textContent.includes('FIRST'));
  assert.ok(first.textContent.includes(prefix));
  ui.$('conversation-list').open = true;
  first.click();
  assert.equal(activeConversation(ui), one.id);
  assert.equal(ui.$('conversation-list').open, false);
  assert.equal(ui.window.document.activeElement, ui.$('conversation-toggle'));
  choose(ui, two.id);
  assert.match(ui.$('messages').textContent, /SECOND/);
});

test('changing conversation state preserves finder focus and restores choice focus', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const one = app.store.question(questionInput(doc, { question: 'First', client_key: 'focus-one', quote: 'quoted' }));
  const two = app.store.question(questionInput(doc, { question: 'Second', client_key: 'focus-two', quote: 'quoted' }));
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  ui.$('conversation-toggle').focus();
  app.store.updateConversation(one.id, { closed: true });
  await ui.poll();
  assert.equal(ui.window.document.activeElement, ui.$('conversation-toggle'));
  const choice = [...ui.$('conversation-choices').querySelectorAll('button')]
    .find(button => button.dataset.threadId === two.id);
  choice.focus();
  app.store.updateConversation(two.id, { closed: true });
  await ui.poll();
  assert.equal(ui.window.document.activeElement.dataset.threadId, two.id);
});

test('revision refresh restores focus and horizontal position to a report table region', async t => {
  const source = '# Report\n\n| Column | Detail |\n|---|---|\n| Stable | Table |';
  const app = await service(t, source);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const region = ui.$('report').querySelector('.table-scroll');
  region.focus();
  region.scrollLeft = 27;
  const blockId = region.querySelector('table').dataset.blockId;
  app.store.importReport({ title: 'Report', source: `${source}\n\nA new note.` });
  await ui.poll();
  const refreshedRegion = ui.$('report').querySelector('.table-scroll');
  assert.equal(ui.window.document.activeElement, refreshedRegion);
  assert.equal(refreshedRegion.querySelector('table').dataset.blockId, blockId);
  assert.equal(refreshedRegion.scrollLeft, 27);
});

test('thread refresh restores focus and horizontal position to a response table region', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const thread = app.store.question(questionInput(doc, { question: 'Explain the table', client_key: 'response-table-focus', quote: 'quoted' }));
  const session = app.relay.connect({ worker: 'original-author' });
  const request = app.relay.reserve(session);
  app.store.answer(request.request_id, { lease_token: request.lease_token, status: 'answered', body: '| Signal | Meaning |\n|---|---|\n| Water | Keep reserves |', citations: [] });
  app.relay.answered(request.request_id);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const region = ui.$('messages').querySelector('.table-scroll');
  region.focus();
  region.scrollLeft = 19;
  app.store.updateConversation(thread.id, { closed: true });
  await ui.poll();
  const refreshedRegion = ui.$('messages').querySelector('.table-scroll');
  assert.equal(ui.window.document.activeElement, refreshedRegion);
  assert.equal(refreshedRegion.scrollLeft, 19);
  app.relay.disconnect(session);
});

test('author-supplied report language follows exact revisions without translating the English interface', async t => {
  const app = await service(t, null);
  app.store.importReport({ title: 'Rapport', source: '# Rapport\n\nUn passage français.', language: 'fr' });
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  assert.equal(ui.window.document.documentElement.lang, 'en');
  assert.equal(ui.$('report').lang, 'fr');
  assert.equal(ui.$('toc').lang, 'fr');
  assert.equal(ui.$('report-title').lang, 'fr');
  assert.equal(ui.$('report-title').hidden, true);
  ui.$('report').querySelector('p').click();
  assert.equal(ui.$('bubble-quote').lang, 'fr');
  ui.$('question').value = 'Pourquoi ?'; submit(ui, 'question-form');
  await waitFor(() => ui.$('notice').textContent === 'Question saved.');
  assert.equal(ui.$('chat-quote').lang, 'fr');
  app.store.importReport({ title: 'English', source: '# English\n\nA different passage.', language: 'en' });
  await ui.poll();
  assert.equal(ui.$('report').lang, 'en');
  assert.equal(ui.$('chat-quote').lang, 'fr');
  assert.equal(ui.$('snapshot-text').lang, 'fr');
});

test('activity follows actual turns and presence; waiting drafts stay editable and keyboard send waits for a terminal reply', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const thread = app.store.question(questionInput(doc, { quote: 'quoted', question: 'Why this passage?' }));
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  assert.match(ui.$('chat-status').textContent, /saved.*waiting to resume/);
  assert.match(ui.$('chat-next').textContent, /conversation that presented.*stays queued/);
  assert.equal(ui.$('followup').disabled, false);
  assert.equal(ui.$('followup-submit').disabled, true);
  assert.equal(ui.$('context-label').textContent, 'Quoted passage');
  assert.equal(ui.$('context-preview').textContent, 'quoted');
  setFollowup(ui, 'A draft while waiting');
  const keyboardSend = (key = 'ctrlKey') => ui.$('followup').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', [key]: true, bubbles: true, cancelable: true }));
  keyboardSend();
  assert.equal(app.store.conversation(thread.id).messages.length, 1);
  const session = app.relay.connect({ worker: 'author-owned-fixture' });
  await ui.poll();
  assert.equal(ui.$('chat-status').textContent, 'Question saved · waiting for the agent');
  const request = app.relay.reserve(session);
  await ui.poll();
  assert.equal(ui.$('chat-status').textContent, 'Agent is replying');
  assert.equal(ui.$('followup').value, 'A draft while waiting');
  ui.$('followup').focus();
  app.store.answer(request.request_id, { lease_token: request.lease_token, status: 'failed', body: 'The supplied fixture could not finish this turn.', citations: [] });
  app.relay.answered(request.request_id);
  await ui.poll();
  assert.equal(ui.$('chat-status').textContent, 'Reply failed · question saved');
  assert.match(ui.$('chat-next').textContent, /follow-up to try again/);
  assert.equal(ui.$('messages').querySelector('.message.failed .message-heading').textContent, 'AgentReply failed');
  assert.equal(ui.window.document.activeElement, ui.$('followup'), 'answer arrival never takes focus from the draft');
  assert.equal(ui.$('followup-submit').disabled, false);
  keyboardSend('metaKey');
  await waitFor(() => ui.$('followup').value === '');
  const next = app.relay.reserve(session);
  assert.equal(next.question, 'A draft while waiting');
  assert.deepEqual(next.history.map(m => m.body), ['Why this passage?', 'The supplied fixture could not finish this turn.']);
  assert.equal(next.document.id, doc.id);
  assert.equal(next.quote, 'quoted');
  app.store.answer(next.request_id, { lease_token: next.lease_token, status: 'answered', body: 'Supplied recovery reply.', citations: [] });
  app.relay.answered(next.request_id);
  await ui.poll();
  assert.equal(ui.$('chat-status').textContent, 'Reply saved');
  assert.match(ui.$('chat-next').textContent, /another report passage/);
  app.relay.disconnect(session);
});

test('new turns append without rebuilding read history, expanded citations, focus or scroll position', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const thread = app.store.question(questionInput(doc, { quote: 'quoted' }));
  await runFakeAgent(app.origin);
  const ui = await reader(app.origin, window => { window.innerHeight = 1000; });
  t.after(() => ui.dom.window.close());
  const question = ui.$('messages').firstElementChild;
  const reply = ui.$('messages').lastElementChild;
  const citation = reply.querySelector('.citation-details');
  citation.open = true;
  citation.querySelector('summary').focus();
  const log = ui.$('messages');
  const scroll = ui.$('chat-scroll');
  Object.defineProperties(scroll, { scrollHeight: { value: 1000 }, clientHeight: { value: 250 } });
  scroll.scrollTop = 60;
  app.store.followup(thread.id, { question: 'A follow-up from another tab', client_key: 'append-test' });
  await ui.poll();
  await runFakeAgent(app.origin);
  await ui.poll();
  assert.equal(log.children.length, 4);
  assert.equal(log.firstElementChild, question);
  assert.equal(log.children[1], reply);
  assert.equal(citation.open, true);
  assert.equal(ui.window.document.activeElement, citation.querySelector('summary'));
  assert.equal(scroll.scrollTop, 60);
  assert.equal(ui.$('latest-reply').hidden, false);
  assert.equal(citation.querySelector('summary').textContent, 'Citation');
  app.store.followup(thread.id, { question: 'One more turn', client_key: 'focused-source-test' });
  await ui.poll();
  scroll.scrollTop = 750; // At the end, but keyboard focus is still inspecting an earlier source.
  await runFakeAgent(app.origin);
  await ui.poll();
  assert.equal(log.children.length, 6);
  assert.equal(scroll.scrollTop, 750, 'do not scroll a focused earlier source out of view');
  assert.equal(ui.window.document.activeElement, citation.querySelector('summary'));
  const oldQuote = citation.querySelector('blockquote').textContent;
  app.store.importReport({ title: 'Changed report', source: 'A different passage, never reattached.' });
  await ui.poll();
  assert.equal(citation.querySelector('blockquote').textContent, oldQuote);
  assert.equal(citation.open, true);
  assert.equal(ui.$('context-label').textContent, 'Quoted passage');
  assert.equal(ui.$('go-source').hidden, true);
  citation.querySelector('button').click();
  assert.match(ui.$('notice').textContent, /Historical citation.*Exact quote is preserved/);
});

test('workspace starts report-first with collapsed Contents; view switches, source icons and resize keep focus and drafts', async t => {
  const app = await service(t);
  app.store.question(questionInput(app.store.current(), { quote: 'quoted' }));
  await runFakeAgent(app.origin);
  const ui = await reader(app.origin, window => { window.innerWidth = 390; });
  t.after(() => ui.dom.window.close());
  assert.equal(ui.$('reader').hidden, false);
  assert.equal(ui.$('threads-panel').hidden, true);
  assert.equal(ui.$('show-report').getAttribute('aria-current'), 'page');
  assert.equal(ui.$('toc-panel').hidden, true);
  ui.$('reader').scrollTop = 240;
  ui.$('show-chat').click();
  assert.equal(ui.$('reader').hidden, true);
  assert.equal(ui.$('threads-panel').hidden, false);
  assert.equal(ui.window.document.activeElement, ui.$('threads-panel'));
  setFollowup(ui, 'A retained workspace draft');
  ui.$('chat-scroll').scrollTop = 90;
  ui.$('show-report').click();
  assert.equal(ui.$('reader').scrollTop, 240);
  assert.equal(ui.window.document.activeElement, ui.$('reader'));
  ui.$('show-chat').click();
  assert.equal(ui.$('chat-scroll').scrollTop, 90);
  assert.equal(ui.$('followup').value, 'A retained workspace draft');
  ui.$('go-source').click();
  assert.equal(ui.$('reader').hidden, false);
  assert.equal(ui.$('threads-panel').hidden, true);
  assert.equal(ui.window.document.activeElement, ui.$('report').querySelector('p'));
  assert.equal(ui.window.lastScrolled, ui.$('report').querySelector('p').id);
  ui.$('show-chat').click();
  ui.$('followup').focus();
  ui.window.innerWidth = 1440; ui.window.dispatchEvent(new ui.window.Event('resize'));
  assert.equal(ui.$('reader').hidden, false);
  assert.equal(ui.$('threads-panel').hidden, false);
  ui.window.innerWidth = 320; ui.window.dispatchEvent(new ui.window.Event('resize'));
  assert.equal(ui.$('reader').hidden, true);
  assert.equal(ui.window.document.activeElement, ui.$('followup'));
  ui.$('toc-toggle').click();
  assert.equal(ui.$('reader').hidden, false);
  ui.$('toc').querySelector('a').click();
  assert.equal(ui.$('toc-panel').hidden, true);
  assert.equal(ui.window.document.activeElement, ui.$('report').querySelector('h1'));
  ui.$('show-chat').click();
  ui.window.document.querySelector('.skip-link').click();
  assert.equal(ui.$('reader').hidden, false);
  assert.equal(ui.window.document.activeElement, ui.$('reader'));
});

test('icon actions keep accessible names and feedback throughout uncertain-save retry', async t => {
  const app = await service(t);
  const doc = app.store.current();
  const thread = app.store.question(questionInput(doc, { quote: 'quoted' }));
  await runFakeAgent(app.origin);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  for (const [button, name] of [[ui.$('followup-submit'), 'Send message'], [ui.$('go-source'), 'Go to passage'], [ui.$('messages').querySelector('.citation'), 'Go to cited passage']]) {
    assert.equal(button.getAttribute('aria-label'), name);
    assert.equal(button.title, name);
    assert.equal(button.textContent, '');
    assert.equal(button.querySelector('svg').getAttribute('aria-hidden'), 'true');
  }
  assert.equal(ui.$('context-details').open, false);
  assert.equal(ui.$('context-label').textContent, 'Quoted passage');
  assert.equal(ui.$('messages').querySelector('.citation-details summary').textContent, 'Citation');
  ui.$('context-details').open = true; ui.$('snapshot').open = true;
  assert.match(ui.$('snapshot-text').textContent, /Revision 1, lines/);
  assert.ok(ui.$('snapshot-text').textContent.includes(thread.context.block.source));
  const send = ui.$('followup-submit'), icon = send.querySelector('svg');
  const normalFetch = ui.window.fetch;
  let release;
  ui.window.fetch = async (path, init) => {
    const response = await normalFetch(path, init);
    if (path.endsWith('/questions')) {
      await new Promise(resolve => { release = resolve; });
      throw new Error('Lost acknowledgement');
    }
    return response;
  };
  setFollowup(ui, 'Retry this exact message'); submit(ui, 'followup-form');
  await waitFor(() => release);
  assert.equal(send.getAttribute('aria-label'), 'Saving message');
  assert.equal(send.disabled, true);
  assert.equal(ui.$('followup-form').getAttribute('aria-busy'), 'true');
  release();
  await waitFor(() => send.getAttribute('aria-label') === 'Retry message');
  assert.equal(send.title, 'Retry message');
  assert.equal(send.querySelector('svg'), icon);
  assert.equal(send.disabled, false);
  assert.match(ui.$('followup-status').textContent, /Retry sends/);
  ui.window.fetch = normalFetch;
  submit(ui, 'followup-form');
  await waitFor(() => ui.$('followup').value === '' && ui.$('followup-form').getAttribute('aria-busy') === 'false');
  assert.equal(app.store.conversation(thread.id).messages.length, 3);
  assert.equal(send.getAttribute('aria-label'), 'Send message');
  assert.equal(send.querySelector('svg'), icon);
});

test('finder unread state is durable, explicit, and does not acknowledge a late unseen answer racing navigation', async t => {
  const app = await service(t);
  const thread = app.store.question(questionInput(app.store.current(), { quote: 'quoted' }));
  await runFakeAgent(app.origin);
  const ui = await reader(app.origin, window => { window.innerWidth = 390; });
  t.after(() => ui.dom.window.close());
  assert.match(ui.$('conversation-choices').textContent, /New reply/);
  ui.$('show-chat').click();
  await ui.poll();
  assert.equal(app.store.conversation(thread.id).unread, 1, 'opening the pane alone is not an acknowledgement');
  assert.equal(ui.$('conversation-state').hidden, true, 'no unread/number chrome');
  const followup = app.store.followup(thread.id, { question: 'A late reply', client_key: 'late-reply' });
  const normalFetch = ui.window.fetch;
  const acknowledgements = [];
  ui.window.fetch = async (path, init) => {
    if (init?.method === 'PATCH') {
      acknowledgements.push(path);
      await runFakeAgent(app.origin); // lands after the displayed snapshot
    }
    return normalFetch(path, init);
  };
  choose(ui, thread.id);
  await waitFor(() => ui.$('messages').querySelectorAll('.message').length === 4);
  assert.equal(app.store.thread(thread.id).unread, 0);
  assert.equal(app.store.thread(followup.messages.at(-1).thread_id).unread, 1);
  assert.match(ui.$('conversation-choices').textContent, /New reply/);
  assert.deepEqual(acknowledgements, [`/api/threads/${thread.id}`]);
  ui.window.fetch = normalFetch;
  choose(ui, thread.id);
  await waitFor(() => !ui.$('conversation-choices').textContent.includes('New reply'));
  assert.equal(app.store.conversation(thread.id).unread, 0);
  await waitFor(() => ui.window.document.activeElement === ui.$('conversation-toggle'));
  const reloaded = await reader(app.origin);
  t.after(() => reloaded.dom.window.close());
  assert.doesNotMatch(reloaded.$('conversation-choices').textContent, /New reply/);
});

test('a workflow revision received while narrow report is hidden keeps its saved reading position', async t => {
  const app = await service(t);
  const ui = await reader(app.origin, window => { window.innerWidth = 390; });
  t.after(() => ui.dom.window.close());
  const pane = ui.$('reader');
  let position = 240;
  // Real Chrome exposes zero geometry/scrollTop for display:none. A jsdom DOM
  // fixture must model that instead of accidentally proving the old page code.
  Object.defineProperty(pane, 'scrollTop', { get: () => pane.hidden ? 0 : position, set: value => { position = value; } });
  ui.$('show-chat').click();
  app.store.importReport({ title: 'Updated', source: '# Heading\n\nA changed introduction.\n\nKeep this.' });
  await ui.poll();
  assert.equal(pane.hidden, true);
  ui.$('show-report').click();
  assert.equal(pane.scrollTop, 240);
  assert.match(ui.$('report').textContent, /changed introduction/);
  assert.equal(ui.window.lastScrollDelta, undefined);
  assert.equal(ui.window.lastScrollPosition, undefined);
});

test('whiteboard channels bind direct frames to exact revisions and reject spoofed messages without stealing report questions', async t => {
  const app = await service(t, '# Diagrams\n\n```mermaid\nflowchart LR\n A-->B\n```\n\nExact context.');
  const ui = await reader(app.origin); t.after(() => ui.dom.window.close());
  const frame = ui.$('report').querySelector('iframe');
  const diagram = app.store.current().diagrams[0];
  const doc = app.store.current();
  const messages = [];
  frame.contentWindow.postMessage = message => messages.push(message);
  const dispatch = (data, source = frame.contentWindow) => ui.window.dispatchEvent(new ui.window.MessageEvent('message', { source, data }));
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.tabIndex, -1); assert.equal(frame.inert, true);
  dispatch({ type: 'sillage-whiteboard:ready' }, ui.window);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(messages.length, 0, 'unregistered windows cannot request source/init');
  dispatch({ type: 'sillage-whiteboard:ready' });
  await waitFor(() => messages.some(m => m.type === 'sillage-whiteboard:init'));
  const init = messages.find(m => m.type === 'sillage-whiteboard:init');
  assert.equal(init.revisionId, doc.id); assert.equal(init.diagramId, diagram.block_id);
  assert.equal(init.source, 'flowchart LR\n A-->B');
  const shape = { id: 'A', type: 'rectangle', x: 0, y: 0, width: 100, height: 40 };
  const save = { type: 'sillage-whiteboard:save', sourceHash: diagram.source_hash, textMetricsVersion: 1,
    channelId: 'forged', scene: { elements: [shape] }, baseline: { elements: [shape] }, flushId: 'save' };
  dispatch(save); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(app.store.whiteboards.latest(doc.id, diagram.block_id), null);
  dispatch({ ...save, channelId: init.channelId });
  await waitFor(() => messages.some(m => m.type === 'sillage-whiteboard:saveResult' && m.ok));
  dispatch({ type: 'sillage-whiteboard:mounted', channelId: init.channelId });
  const annotate = ui.$('report').querySelector('.wb-tools button');
  annotate.click();
  assert.equal(frame.inert, false); assert.equal(ui.$('bubble').hidden, true);
  assert.equal(messages.at(-1).type, 'sillage-whiteboard:lock');
  assert.equal(messages.at(-1).locked, false);
  const summary = ui.$('report').querySelector('.wb-source summary');
  summary.click(); assert.equal(ui.$('bubble').hidden, true, 'source disclosure is a native control, not a question click');
  dispatch({ ...save, type: 'sillage-whiteboard:queueFeedback', channelId: init.channelId, note: 'Explain this annotation.', clientKey: 'whiteboard-ui-feedback' });
  await waitFor(() => app.store.threads().length === 1);
  await waitFor(() => ui.$('notice').textContent.startsWith('Whiteboard feedback saved.'));
  await ui.poll();
  assert.match(ui.$('messages').textContent, /not scene JSON or pixels/);
  assert.equal(app.store.threads()[0].revision_id, doc.id);
  assert.equal(app.store.threads()[0].block_id, diagram.block_id);
  // Local publication during active editing keeps the old frame and its revision.
  app.store.importReport({ title: 'New revision', source: '# Diagrams\n\n```mermaid\nflowchart LR\n A-->C\n```' });
  await ui.poll();
  assert.equal(ui.$('report').querySelector('iframe'), frame);
  assert.match(ui.$('notice').textContent, /Finish the whiteboard/);
  assert.equal(messages.at(-1).type, 'sillage-whiteboard:staleRevision');
});

test('single header finder keeps historical conversations accessible without close controls', async t => {
  const app = await service(t);
  const thread = app.store.question(questionInput(app.store.current(), { quote: 'quoted', question: 'A historical conversation' }));
  await runFakeAgent(app.origin);
  app.store.updateConversation(thread.id, { closed: true });
  const before = app.store.conversation(thread.id);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  assert.equal(ui.$('threads-panel').querySelector('select'), null);
  assert.equal(ui.$('conversation-actions'), null);
  assert.equal(ui.$('close-thread'), null);
  const toggle = ui.$('conversation-toggle');
  assert.ok(toggle.closest('.chat-heading'));
  assert.equal(toggle.textContent, 'Find a conversation');
  ui.$('conversation-list').open = true;
  ui.$('conversation-choices').querySelector('button').focus();
  ui.window.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.$('conversation-list').open, false);
  assert.equal(ui.window.document.activeElement, toggle);
  ui.$('conversation-list').open = true;
  ui.$('conversation-choices').querySelector('button').click();
  await waitFor(() => !ui.$('conversation-choices').textContent.includes('New reply'));
  assert.equal(ui.$('messages').dataset.conversationId, thread.id);
  assert.equal(ui.window.document.activeElement, toggle);
  const after = app.store.conversation(thread.id);
  assert.equal(after.closed, 1);
  assert.deepEqual(after.messages, before.messages);
  assert.deepEqual(after.context, before.context);
});

test('both composers share keyboard send and accessible saving and retry states', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  ui.$('report').querySelector('p').click();
  const form = ui.$('question-form'), field = ui.$('question'), send = ui.$('question-submit');
  assert.equal(send.getAttribute('aria-label'), 'Send message');
  assert.equal(send.title, 'Send message');
  assert.equal(send.textContent, '');
  assert.equal(ui.$('question-hint').textContent, ui.$('followup-hint').textContent);
  const keyboard = options => field.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
  field.value = 'An initial question\nwith two lines';
  keyboard({}); keyboard({ ctrlKey: true, isComposing: true });
  assert.equal(app.store.threads().length, 0, 'plain Enter and IME composition never send');
  const normalFetch = ui.window.fetch;
  let release;
  ui.window.fetch = async (path, init) => {
    const response = await normalFetch(path, init);
    if (path === '/api/questions') {
      await new Promise(resolve => { release = resolve; });
      throw new Error('Lost acknowledgement');
    }
    return response;
  };
  keyboard({ ctrlKey: true });
  await waitFor(() => release);
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.equal(send.getAttribute('aria-label'), 'Saving message');
  assert.equal(send.disabled, true);
  keyboard({ metaKey: true });
  assert.equal(app.store.threads().length, 1);
  release();
  await waitFor(() => send.getAttribute('aria-label') === 'Retry message');
  assert.equal(form.getAttribute('aria-busy'), 'false');
  assert.equal(send.disabled, false);
  assert.equal(field.value, 'An initial question\nwith two lines');
  ui.window.fetch = normalFetch;
  send.focus();
  send.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => ui.$('bubble').hidden);
  assert.equal(app.store.threads().length, 1);
  await runFakeAgent(app.origin); await ui.poll();
  setFollowup(ui, 'A keyboard follow-up');
  ui.$('followup').dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  await waitFor(() => app.store.threads().length === 2);
  assert.equal(app.store.conversations().length, 1);
  await waitFor(() => ui.$('followup').value === '');
  ui.$('report').querySelector('p').click();
  assert.equal(send.getAttribute('aria-label'), 'Send message');
  assert.equal(form.getAttribute('aria-busy'), 'false');
});

test('minimal chrome exposes icon-only Contents before the mark and only a narrow Report / Conversation selector', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const toggle = ui.$('toc-toggle');
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.textContent, '');
  assert.equal(toggle.getAttribute('aria-label'), 'Table of contents');
  assert.equal(toggle.getAttribute('aria-controls'), 'toc-panel');
  assert.equal(toggle.nextElementSibling.tagName, 'IMG');
  assert.equal(toggle.nextElementSibling.getAttribute('src'), '/sillage.svg');
  assert.equal(toggle.querySelector('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(ui.$('new-reply'), null);
  assert.equal(ui.$('bubble-close'), null);
  assert.equal(ui.window.document.querySelector('.chat-heading h3').textContent, 'Conversation');
  assert.equal(ui.window.document.querySelector('.site-header #show-chat, .site-header #show-report'), null);
  assert.equal(ui.$('workspace-switcher').hidden, true);
  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.title, 'Hide table of contents');
  ui.$('toc').querySelector('a').focus();
  ui.window.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.window.document.activeElement, toggle);
  assert.equal(toggle.title, 'Show table of contents');
  ui.window.innerWidth = 700; ui.window.dispatchEvent(new ui.window.Event('resize'));
  assert.equal(ui.$('workspace-switcher').hidden, false);
  assert.deepEqual([...ui.$('workspace-switcher').querySelectorAll('a')].map(a => a.textContent), ['Report', 'Conversation']);
  ui.$('show-chat').click();
  assert.equal(ui.$('show-chat').getAttribute('aria-current'), 'page');
  assert.equal(ui.$('reader').hidden, true);
  ui.window.innerWidth = 701; ui.window.dispatchEvent(new ui.window.Event('resize'));
  assert.equal(ui.$('workspace-switcher').hidden, true);
  assert.equal(ui.$('reader').hidden, false);
  assert.equal(ui.$('threads-panel').hidden, false);
});

test('question light dismissal preserves inside clicks, outside focus, replacement and exact selected quotes', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const paragraph = ui.$('report').querySelector('p');
  paragraph.click();
  ui.$('question').value = 'Draft';
  ui.$('bubble-quote').click();
  assert.equal(ui.$('bubble').hidden, false);
  assert.equal(ui.$('question').value, 'Draft');
  ui.$('toc-toggle').focus(); ui.$('toc-toggle').click();
  assert.equal(ui.$('bubble').hidden, true);
  assert.equal(ui.window.document.activeElement, ui.$('toc-toggle'), 'outside focus is never pulled back into the report');
  const range = ui.window.document.createRange();
  range.selectNodeContents(paragraph.querySelector('strong'));
  ui.window.getSelection().removeAllRanges();
  ui.window.getSelection().addRange(range);
  paragraph.dispatchEvent(new ui.window.MouseEvent('mouseup', { bubbles: true }));
  paragraph.click();
  assert.equal(ui.$('bubble').hidden, false, 'selection-completing click is not an outside dismissal');
  assert.equal(ui.$('bubble-quote').textContent, 'quoted');
  ui.window.document.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(ui.window.document.activeElement, paragraph);
  assert.equal(app.store.threads().length, 0);
});

test('question dismissal crosses an active whiteboard iframe without disabling annotation', async t => {
  const app = await service(t, '# Diagram\n\nFirst **quoted** passage.\n\nSecond passage.\n\n```mermaid\nflowchart LR\n A-->B\n```');
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const frame = ui.$('report').querySelector('iframe');
  const messages = [];
  frame.contentWindow.postMessage = message => messages.push(message);
  const dispatch = data => ui.window.dispatchEvent(new ui.window.MessageEvent('message', { source: frame.contentWindow, data }));
  dispatch({ type: 'sillage-whiteboard:ready' });
  await waitFor(() => messages.some(message => message.type === 'sillage-whiteboard:init'));
  const channelId = messages.find(message => message.type === 'sillage-whiteboard:init').channelId;
  dispatch({ type: 'sillage-whiteboard:mounted', channelId });
  ui.$('report').querySelector('.wb-tools button').click();
  const paragraphs = [...ui.$('report').querySelectorAll(':scope > p')];
  const range = ui.window.document.createRange();
  range.selectNodeContents(paragraphs[0].querySelector('strong'));
  ui.window.getSelection().removeAllRanges();
  ui.window.getSelection().addRange(range);
  paragraphs[0].dispatchEvent(new ui.window.MouseEvent('mouseup', { bubbles: true }));
  assert.equal(ui.$('bubble').hidden, false);
  assert.equal(ui.$('bubble-quote').textContent, 'quoted');
  const pointer = new ui.window.Event('pointerover', { bubbles: true, cancelable: true });
  frame.dispatchEvent(pointer);
  assert.equal(ui.$('bubble').hidden, true);
  assert.equal(pointer.defaultPrevented, false);
  assert.equal(frame.classList.contains('wb-locked'), false);
  ui.window.getSelection().removeAllRanges();
  paragraphs[1].click();
  assert.equal(ui.$('bubble').hidden, false);
  assert.equal(ui.$('bubble-quote').textContent, 'Second passage.');
  frame.focus();
  assert.equal(ui.$('bubble').hidden, true);
  assert.equal(ui.window.document.activeElement, frame);
});

test('review menu uses keyboard focus, Escape, Tab, focus departure and outside dismissal without lifecycle effects', async t => {
  const app = await service(t);
  const session = app.relay.connect({ worker: 'menu-fixture' });
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const toggle = ui.$('review-menu-toggle');
  const key = (target, value) => target.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  assert.equal(toggle.getAttribute('aria-label'), 'Review options');
  assert.equal(toggle.getAttribute('aria-haspopup'), 'menu');
  assert.equal(ui.$('review-menu').getAttribute('role'), 'menu');
  assert.equal(ui.$('end-session').getAttribute('role'), 'menuitem');
  toggle.focus(); key(toggle, 'ArrowDown');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(ui.window.document.activeElement, ui.$('end-session'));
  key(ui.$('end-session'), 'Home'); key(ui.$('end-session'), 'ArrowUp');
  assert.equal(ui.window.document.activeElement, ui.$('end-session'));
  key(ui.$('end-session'), 'Escape');
  assert.equal(ui.$('review-menu').hidden, true);
  assert.equal(ui.window.document.activeElement, toggle);
  toggle.click(); key(ui.$('end-session'), 'Tab');
  assert.equal(ui.$('review-menu').hidden, true);
  toggle.click(); ui.$('reader').focus();
  assert.equal(ui.$('review-menu').hidden, true);
  toggle.click(); ui.window.document.querySelector('.brand strong').click();
  assert.equal(ui.$('review-menu').hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  ui.$('toc-toggle').click(); await ui.poll();
  ui.window.dispatchEvent(new ui.window.Event('beforeunload'));
  assert.equal(app.relay.session.id, session.session_id, 'only explicit End session disconnects');
});

test('End session closes only this review, stops polling, preserves data and never disconnects a replacement on uncertain retry', async t => {
  const app = await service(t);
  const session = app.relay.connect({ worker: 'ending-fixture' });
  const saved = app.store.question(questionInput(app.store.current(), { quote: 'quoted' }));
  app.relay.reserve(session);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const normalFetch = ui.window.fetch;
  let lost = false, calls = 0;
  ui.window.fetch = async (path, init) => {
    calls++;
    const response = await normalFetch(path, init);
    if (path === '/review/end' && !lost) { lost = true; throw new Error('Lost end acknowledgement'); }
    return response;
  };
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  await waitFor(() => ui.$('notice').textContent.includes('Lost end acknowledgement'));
  assert.equal(ui.$('review-ended').hidden, true);
  assert.equal(ui.$('layout').inert, false);
  assert.equal(app.relay.status().state, 'unavailable');
  assert.equal(app.store.thread(saved.id).request_status, 'failed');
  const replacement = app.relay.connect({ worker: 'replacement-fixture' });
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  await waitFor(() => !ui.$('review-ended').hidden);
  assert.equal(ui.window.document.activeElement, ui.$('review-ended-title'));
  assert.equal(ui.$('layout').hidden, true);
  assert.equal(ui.$('toc-toggle').hidden, true);
  assert.equal(ui.$('review-actions').hidden, true);
  assert.equal(ui.$('workspace-switcher').hidden, true);
  assert.equal(app.relay.session.id, replacement.session_id);
  const before = calls;
  await ui.poll();
  ui.window.innerWidth = 390; ui.window.dispatchEvent(new ui.window.Event('resize'));
  ui.window.location.hash = '#threads-panel';
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, before, 'closed review neither polls nor performs hash navigation');
  assert.equal(ui.$('workspace-switcher').hidden, true);
  assert.equal(app.server.listening, true);
  const reopened = await reader(app.origin);
  t.after(() => reopened.dom.window.close());
  assert.equal(reopened.$('review-ended').hidden, true);
  assert.equal(reopened.$('layout').hidden, false);
  assert.match(reopened.$('messages').textContent, /stopped before answering/);
  assert.equal(app.store.thread(saved.id).closed, 0);
  assert.equal(app.store.current().id, saved.revision_id);
});

test('End session waits for uncertain messages and whiteboard work; absent respondent is a safe no-op', async t => {
  const app = await service(t);
  const ui = await reader(app.origin);
  t.after(() => ui.dom.window.close());
  const normalFetch = ui.window.fetch;
  let rejectSave;
  ui.window.fetch = (path, init) => path === '/api/questions' ? new Promise((resolve, reject) => { rejectSave = reject; }) : normalFetch(path, init);
  ui.$('report').querySelector('p').click(); ui.$('question').value = 'Keep this pending question'; submit(ui, 'question-form');
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  assert.match(ui.$('notice').textContent, /Finish saving/);
  rejectSave(new Error('Disconnected while saving'));
  await waitFor(() => !ui.$('notice-retry').hidden);
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  assert.match(ui.$('notice').textContent, /retry pending messages/);
  assert.equal(ui.$('layout').hidden, false);
  ui.window.fetch = normalFetch; ui.$('notice-retry').click();
  await waitFor(() => ui.$('notice').textContent === 'Question saved.');
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  await waitFor(() => !ui.$('review-ended').hidden);
  assert.equal(app.store.threads().length, 1);
  assert.equal(app.store.threads()[0].request_status, 'waiting', 'unclaimed questions stay queued');
});

test('End session refuses to hide active or unsaved whiteboard edits', async t => {
  const app = await service(t, '# Diagram\n\n```mermaid\nflowchart LR\n A-->B\n```');
  const session = app.relay.connect({ worker: 'whiteboard-end-fixture' });
  const ui = await reader(app.origin); t.after(() => ui.dom.window.close());
  const frame = ui.$('report').querySelector('iframe');
  const messages = [];
  frame.contentWindow.postMessage = message => messages.push(message);
  const dispatch = data => ui.window.dispatchEvent(new ui.window.MessageEvent('message', { source: frame.contentWindow, data }));
  dispatch({ type: 'sillage-whiteboard:ready' });
  await waitFor(() => messages.some(m => m.type === 'sillage-whiteboard:init'));
  const channelId = messages.find(m => m.type === 'sillage-whiteboard:init').channelId;
  dispatch({ type: 'sillage-whiteboard:mounted', channelId });
  ui.$('report').querySelector('.wb-tools button').click();
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  await waitFor(() => ui.$('notice').textContent.includes('Finish whiteboard editing'));
  assert.equal(frame.isConnected, true);
  assert.equal(frame.inert, false);
  assert.equal(app.relay.session.id, session.session_id);
  ui.$('report').querySelectorAll('.wb-tools button')[1].click();
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  await waitFor(() => messages.some(m => m.type === 'sillage-whiteboard:flush'));
  const flushId = messages.findLast(m => m.type === 'sillage-whiteboard:flush').flushId;
  dispatch({ type: 'sillage-whiteboard:flushComplete', channelId, flushId, ok: false });
  await waitFor(() => ui.$('notice').textContent.includes('Whiteboard could not save'));
  assert.equal(frame.isConnected, true);
  assert.equal(app.relay.session.id, session.session_id);
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  await waitFor(() => messages.findLast(m => m.type === 'sillage-whiteboard:flush').flushId !== flushId);
  dispatch({ type: 'sillage-whiteboard:flushComplete', channelId, flushId: messages.findLast(m => m.type === 'sillage-whiteboard:flush').flushId, ok: true });
  await waitFor(() => !ui.$('review-ended').hidden);
  assert.equal(frame.isConnected, false);
  assert.equal(app.relay.status().state, 'unavailable');
});

test('End session waits for an in-flight whiteboard revision replacement and refuses a stale displayed revision', async t => {
  const source = '# Diagram\n\n```mermaid\nflowchart LR\n A-->B\n```';
  const app = await service(t, source);
  const session = app.relay.connect({ worker: 'revision-end-fixture' });
  const ui = await reader(app.origin); t.after(() => ui.dom.window.close());
  const frame = ui.$('report').querySelector('iframe');
  const messages = [];
  frame.contentWindow.postMessage = message => messages.push(message);
  const dispatch = (source, data) => ui.window.dispatchEvent(new ui.window.MessageEvent('message', { source, data }));
  dispatch(frame.contentWindow, { type: 'sillage-whiteboard:ready' });
  await waitFor(() => messages.some(m => m.type === 'sillage-whiteboard:init'));
  const channelId = messages.find(m => m.type === 'sillage-whiteboard:init').channelId;
  dispatch(frame.contentWindow, { type: 'sillage-whiteboard:mounted', channelId });
  app.store.importReport({ title: 'Updated diagram review', source: source + '\n\nAn added note.' });
  const refreshing = ui.poll();
  await waitFor(() => messages.some(m => m.type === 'sillage-whiteboard:flush'));
  ui.$('review-menu-toggle').click(); ui.$('end-session').click();
  assert.equal(ui.$('layout').inert, true);
  const flushId = messages.find(m => m.type === 'sillage-whiteboard:flush').flushId;
  dispatch(frame.contentWindow, { type: 'sillage-whiteboard:flushComplete', channelId, flushId, ok: true });
  await refreshing;
  await waitFor(() => ui.$('notice').textContent.includes('The report changed'));
  assert.equal(ui.$('layout').inert, false);
  assert.equal(app.relay.session.id, session.session_id);
  assert.match(ui.$('report').textContent, /An added note/);
  const replacement = ui.$('report').querySelector('iframe');
  assert.notEqual(replacement, frame);
  const nextMessages = [];
  replacement.contentWindow.postMessage = message => nextMessages.push(message);
  dispatch(replacement.contentWindow, { type: 'sillage-whiteboard:ready' });
  await waitFor(() => nextMessages.some(m => m.type === 'sillage-whiteboard:init'));
  assert.equal(nextMessages.find(m => m.type === 'sillage-whiteboard:init').revisionId, app.store.revisionId(), 'replacement remains registered after end refusal');
});
