// Opt-in real layout regression test. Uses only an explicitly configured, existing
// local Chrome through chrome-devtools-axi; never downloads or launches a browser.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { decode } from '@toon-format/toon';
import { createApp } from '../src/server.js';

if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL || '')) {
  throw new Error('Set CHROME_DEVTOOLS_AXI_BROWSER_URL to an existing local Chrome and configure chrome-devtools-axi first.');
}
const evidence = resolve(`.data/test/clear-browser-${process.pid}`);
mkdirSync(evidence, { recursive: true });
const app = createApp({ dbPath: `${evidence}/fixture.sqlite` });
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
const origin = `http://127.0.0.1:${app.server.address().port}`;
writeFileSync(`${evidence}/origin.txt`, origin);
const source = '# Orchard review\n\nReserve water for **young trees** during dry weeks. Keep the original assumptions and review them after rainfall.\n\n## Comparison\n\n| Plot | Weekly demand | Recommended reserve | Reassessment condition | Owner |\n|---|---|---|---|---|\n| Young apple trees | 120 litres | 24 litres | Two weeks without rainfall | Orchard team |\n| Established pears | 80 litres | 8 litres | Dry soil ten centimetres down | Orchard team |\n\n## Implementation\n\n```js\nconst explanation = "A deliberately long line demonstrating local horizontal scrolling without narrowing words in the report table";\n```\n\n' + Array.from({ length: 8 }, (_, i) => `## Section ${i + 1}\n\nA synthetic paragraph about monitoring water reserves, keeping the original context, and explaining the next step.\n`).join('\n');
const doc = app.store.importReport({ title: 'Orchard review', source });
const session = app.relay.connect({ worker: 'layout-test-fixture-not-inference' });
const heartbeat = setInterval(() => app.relay.heartbeat(session), 5000);
const execute = promisify(execFile);
const c = async (...args) => {
  const { stdout: output } = await execute('chrome-devtools-axi', args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 10_000_000 });
  if (/^(error|code):/m.test(output)) throw new Error(output);
  return output;
};
// CLI help is human guidance, not part of the structured observation.
const observation = text => decode(text.split(/\nhelp\[/)[0]);
const snapshot = () => c('snapshot');
const evaluate = async expression => {
  await snapshot(); // Reacquire after every navigation/mutation; no stale AX references.
  const result = observation(await c('eval', expression)).result;
  return typeof result === 'string' ? JSON.parse(result) : result;
};
const shot = async name => { await snapshot(); await c('screenshot', `${evidence}/${name}.png`); };
let page;
try {
  await c('pages');
  await c('newpage', origin);
  const pages = observation(await c('pages')).pages;
  page = pages.find(p => p.url.replace(/\/$/, '') === origin)?.id;
  assert.ok(page, 'the fixture must have its own explicitly selected page');
  await c('selectpage', String(page));
  for (const width of [1440, 390, 320]) {
    await c('resize', String(width), width === 1440 ? '1000' : '844');
    await c('open', origin);
    const initial = await evaluate(`() => ({collapsed:document.getElementById('toc-panel').hidden, empty:document.getElementById('thread-select').selectedOptions[0]?.textContent, titleHidden:document.getElementById('report-title').hidden, width:document.documentElement.clientWidth, scroll:document.documentElement.scrollWidth})`);
    assert.equal(initial.collapsed, width <= 700);
    assert.equal(initial.titleHidden, true);
    assert.equal(initial.width, initial.scroll);
    if (!app.store.threads().length) assert.equal(initial.empty, 'No conversations yet');
    await shot(`${width}-initial`);
    const table = await evaluate(`() => {const e=document.querySelector('.table-scroll');e.scrollIntoView({block:'center'});const t=e.querySelector('table');return {width:e.clientWidth,scroll:e.scrollWidth,cell:t.querySelector('td').clientWidth,height:t.getBoundingClientRect().height,tabIndex:e.tabIndex};}`);
    assert.ok(table.cell >= 120, 'table words must not be crushed to a few characters');
    assert.ok(table.height < 400, 'two rows must not stretch into a thousand-pixel column');
    assert.equal(table.tabIndex, 0);
    if (width < 700) assert.ok(table.scroll > table.width, 'narrow tables must scroll inside their own region');
    await shot(`${width}-table`);
    await evaluate(`() => {const p=document.querySelector('#report > p');p.scrollIntoView({block:'center'});p.click();return true;}`);
    const bubble = await evaluate(`() => {const r=document.getElementById('bubble').getBoundingClientRect(),q=document.getElementById('question-submit').getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right,height:innerHeight,width:document.documentElement.clientWidth,submitBottom:q.bottom,quote:document.getElementById('bubble-quote').textContent};}`);
    assert.ok(bubble.top >= 0 && bubble.bottom <= bubble.height, 'whole bubble fits vertically');
    assert.ok(bubble.right <= bubble.width);
    assert.ok(bubble.submitBottom <= bubble.height, 'send is visible on opening');
    assert.equal(bubble.quote.includes('**'), false);
    await shot(`${width}-question`);
    await evaluate(`() => {document.getElementById('question').value='Why keep this reserve at ${width}px?';document.getElementById('question-form').requestSubmit();return true;}`);
    let saved;
    for (let i = 0; i < 20; i++) {
      saved = await evaluate(`() => {const n=document.getElementById('notice'),a=document.getElementById('notice-chat');return {text:n.textContent,top:n.getBoundingClientRect().top,bottom:a.getBoundingClientRect().bottom,hidden:a.hidden,height:innerHeight};}`);
      if (saved.text === 'Question saved.') break;
    }
    assert.equal(saved.text, 'Question saved.');
    assert.equal(saved.hidden, false);
    assert.ok(saved.top >= 0 && saved.bottom <= saved.height, 'confirmation and explicit next action remain visible near the reading position');
    const request = app.relay.reserve(session);
    assert.ok(request);
    app.store.answer(request.request_id, { lease_token: request.lease_token, status: 'answered',
      body: '## Why keep reserves?\n\n**Young roots need protection.**\n\n' + '- Reassess the soil before watering.\n'.repeat(12) + '\nSupplied test fixture, not inference.',
      citations: [{ revision_id: doc.id, block_id: request.block.id, quote: request.quote }] });
    app.relay.answered(request.request_id);
    await delay(2200);
    await evaluate(`() => {document.getElementById('notice-chat').click();return true;}`);
    const chat = await evaluate(`() => {const p=document.getElementById('threads-panel'),l=document.getElementById('messages'),f=document.getElementById('followup-submit');return {panelClient:p.clientHeight,panelScroll:p.scrollHeight,logClient:l.clientHeight,logScroll:l.scrollHeight,followupBottom:f.getBoundingClientRect().bottom,height:innerHeight,contextOpen:document.getElementById('context-details').open};}`);
    assert.equal(chat.contextOpen, false);
    if (width === 1440) {
      assert.ok(chat.panelScroll <= chat.panelClient + 2, 'no second chat panel scrollbar');
      assert.ok(chat.logScroll > chat.logClient, 'only history scrolls in wide chat');
      assert.ok(chat.followupBottom <= chat.height, 'follow-up remains reachable in wide chat');
    } else assert.ok(chat.logScroll <= chat.logClient + 2, 'narrow chat uses page scroll, not nested history');
    await shot(`${width}-answer`);
    await evaluate(`() => {document.querySelector('.citation-details').open=true;document.querySelector('.citation').click();return true;}`);
    const cited = await evaluate(`() => {const r=document.querySelector('#report > p').getBoundingClientRect();return {top:r.top,bottom:r.bottom,header:document.querySelector('.site-header').getBoundingClientRect().bottom,height:innerHeight};}`);
    assert.ok(cited.bottom > cited.header && cited.top < cited.height, 'citation explicitly returns to the source');
    await evaluate(`() => {document.querySelector('#report > p').click();document.getElementById('question').value='Unsent browser draft';return true;}`);
    await snapshot(); await c('press', 'Escape');
    assert.equal(await evaluate(`() => document.getElementById('bubble').hidden`), true);
    await c('press', 'Enter');
    assert.equal(await evaluate(`() => document.getElementById('bubble').hidden`), false);
    await evaluate(`() => {document.getElementById('bubble-close').click();return true;}`);
    assert.equal(await evaluate(`() => document.getElementById('bubble').hidden`), true);
  }
  await evaluate(`() => {document.querySelector('#report > p').scrollIntoView({block:'center'});return true;}`);
  clearInterval(heartbeat);
  app.relay.disconnect(session);
  await delay(2200);
  const alert = await evaluate(`() => {const e=document.getElementById('answer-alert'),r=e.getBoundingClientRect();return {hidden:e.hidden,text:e.textContent,top:r.top,bottom:r.bottom,height:innerHeight};}`);
  assert.equal(alert.hidden, false);
  assert.match(alert.text, /Replies are paused/);
  assert.ok(alert.top >= 0 && alert.bottom <= alert.height, 'loss is visible while reading a scrolled report');
  await shot('listening-loss');
  writeFileSync(`${evidence}/result.json`, JSON.stringify({ result: 'passed', viewports: ['1440x1000', '390x844', '320x844'], source }, null, 2));
  console.log(`Browser layout regressions passed. Evidence: ${evidence}`);
} finally {
  clearInterval(heartbeat);
  try { if (page) await c('closepage', String(page)); }
  finally { await new Promise(resolve => app.server.close(resolve)); }
}
