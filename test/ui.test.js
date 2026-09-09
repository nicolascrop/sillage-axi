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
async function reader(origin) {
  const dom = new JSDOM(readFileSync('public/index.html', 'utf8'), { url: origin, runScripts: 'outside-only' });
  const { window } = dom;
  window.fetch = (path, init) => fetch(origin + path, init);
  window.confirm = () => true;
  window.HTMLElement.prototype.scrollIntoView = function () { window.lastScrolled = this.id; };
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
  assert.match(ui.$('bubble-status').textContent, /answered/);
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
  await ui.poll();
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
  assert.equal(app.store.threads().length, 1);
});
