// Opt-in real layout regression test. Uses only an explicitly configured, existing
// local Chrome through chrome-devtools-axi; never downloads or launches a browser.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { decode } from '@toon-format/toon';
import { createApp } from '../src/server.js';
import { runLocalAgent } from '../src/local-agent.js';
import { checkContentsToggle } from '../test-support/contents-browser.js';

if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL || '')) {
  throw new Error('Set CHROME_DEVTOOLS_AXI_BROWSER_URL to an existing local Chrome and configure chrome-devtools-axi first.');
}
const evidence = resolve(`.data/test/chat-browser-${process.pid}`);
mkdirSync(evidence, { recursive: true });
const app = createApp({ dbPath: `${evidence}/fixture.sqlite` });
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
const origin = `http://127.0.0.1:${app.server.address().port}`;
writeFileSync(`${evidence}/origin.txt`, origin);
const source = '# Orchard review\n\nReserve water for **young trees** during dry weeks. Keep the original assumptions and review them after rainfall.\n\n## Comparison\n\n| Plot | Weekly demand | Recommended reserve | Reassessment condition | Owner |\n|---|---|---|---|---|\n| Young apple trees | 120 litres | 24 litres | Two weeks without rainfall | Orchard team |\n| Established pears | 80 litres | 8 litres | Dry soil ten centimetres down | Orchard team |\n\n## Implementation\n\n```js\nconst explanation = "A deliberately long line demonstrating local horizontal scrolling without narrowing words in the report table";\n```\n\n' + Array.from({ length: 8 }, (_, i) => `## Section ${i + 1}\n\nA synthetic paragraph about monitoring water reserves, keeping the original context, and explaining the next step.\n`).join('\n');
// The synthetic author owns the real JSONL handoff and answers only when this
// test supplies a reply. Presence is not a claim of inference or a bundled agent.
const input = new PassThrough();
const output = new PassThrough();
const events = [];
let partial = '';
output.on('data', chunk => {
  partial += chunk;
  let end;
  while ((end = partial.indexOf('\n')) >= 0) {
    events.push(JSON.parse(partial.slice(0, end)));
    partial = partial.slice(end + 1);
  }
});
const send = record => input.write(JSON.stringify(record) + '\n');
const waitFor = async condition => {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(100); }
  assert.fail('Synthetic author handoff timed out');
};
const running = runLocalAgent({ base: origin, input, output, interval: 100 });
const handoff = { subject: 'Synthetic orchard review.', repository: 'Supplied notes only; no filesystem access.', conversation: 'Explain reserves without editing the report.' };
let doc;
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
const composerStyle = id => evaluate(`() => {
  const form=document.getElementById('${id}-form'),field=document.getElementById('${id}'),send=document.getElementById('${id}-submit');
  field.focus({preventScroll:true});
  const f=getComputedStyle(field),b=getComputedStyle(send),s=getComputedStyle(form),icon=send.querySelector('svg').getBoundingClientRect();
  return {outline:f.outlineStyle,border:f.borderWidth,shadow:f.boxShadow,caret:f.caretColor,padding:f.padding,lineHeight:f.lineHeight,fontSize:f.fontSize,color:f.color,background:f.backgroundColor,formPadding:s.padding,formBackground:s.backgroundColor,formBorder:s.borderWidth,formShadow:s.boxShadow,buttonBackground:b.backgroundColor,buttonWidth:send.getBoundingClientRect().width,buttonHeight:send.getBoundingClientRect().height,iconWidth:icon.width,iconHeight:icon.height,name:send.getAttribute('aria-label'),hint:document.getElementById('${id}-hint').textContent,focused:document.activeElement===field};
}`);
const assertCaretComposer = style => {
  assert.equal(style.focused, true);
  assert.equal(style.outline, 'none');
  assert.equal(style.border, '0px');
  assert.equal(style.shadow, 'none');
  assert.equal(style.caret, 'rgb(165, 175, 245)');
  assert.equal(style.formBorder, '0px');
  assert.equal(style.formShadow, 'none');
  assert.equal(style.buttonBackground, 'rgba(0, 0, 0, 0)');
  assert.equal(style.buttonWidth, 32); assert.equal(style.buttonHeight, 32);
  assert.equal(style.iconWidth, 16); assert.equal(style.iconHeight, 16);
  assert.equal(style.name, 'Send message');
  assert.equal(style.hint, 'Ctrl / ⌘ + Enter to send');
};
const geometry = [];
try {
  send({ type: 'ready', worker: 'layout-test-fixture-not-inference', presentation: { title: 'Orchard review', source, operation_key: 'browser-presentation', expected_revision_id: null, handoff } });
  await waitFor(() => events.some(e => e.type === 'connected'));
  doc = app.store.current();
  const context = events.find(e => e.type === 'context');
  assert.equal(context.document.source, source);
  assert.deepEqual(context.handoff, { revision_id: doc.id, ...handoff });
  await c('pages');
  await c('newpage', origin);
  const pages = observation(await c('pages')).pages;
  page = pages.find(p => p.url.replace(/\/$/, '') === origin)?.id;
  assert.ok(page, 'the fixture must have its own explicitly selected page');
  await c('selectpage', String(page));
  for (const [width, height] of [[1440, 1000], [1280, 720], [390, 844], [320, 844], [844, 390]]) {
    await c('emulate', '--viewport', `${width}x${height}x1`);
    await c('open', origin);
    const initial = await evaluate(`() => ({collapsed:document.getElementById('toc-panel').hidden, empty:document.getElementById('chat-empty').textContent,finderHidden:document.getElementById('conversation-list').hidden,select:!!document.querySelector('#threads-panel select'),actions:!!document.getElementById('conversation-actions'), titleHidden:document.getElementById('report-title').hidden, width:document.documentElement.clientWidth, scroll:document.documentElement.scrollWidth})`);
    assert.equal(initial.collapsed, true);
    assert.equal(initial.titleHidden, true);
    assert.equal(initial.width, initial.scroll);
    assert.equal(initial.select, false);
    assert.equal(initial.actions, false);
    if (!app.store.threads().length) {
      assert.match(initial.empty, /Ask about a passage to start/);
      assert.equal(initial.finderHidden, true);
    }
    await checkContentsToggle({ evaluate, snapshot, shot, width, press: async key => { await snapshot(); await c('press', key); } });
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
    if (height > 600) assert.ok(bubble.submitBottom <= bubble.height, 'send is visible on opening');
    else {
      const reached = await evaluate(`() => {const r=document.getElementById('reader'),before=r.scrollTop,b=document.getElementById('question-submit');b.scrollIntoView({block:'nearest'});return {before,after:r.scrollTop,bottom:b.getBoundingClientRect().bottom,page:scrollY};}`);
      assert.ok(reached.bottom <= height, 'short-window bubble scroll makes send reachable');
      assert.equal(reached.before, reached.after);
      assert.equal(reached.page, 0);
    }
    assert.equal(bubble.quote.includes('**'), false);
    await shot(`${width}-question`);
    const questionComposer = await composerStyle('question');
    assertCaretComposer(questionComposer);
    await evaluate(`() => {const q=document.getElementById('question');q.value='Why keep this reserve at ${width}px?';q.focus();return true;}`);
    await c('press', 'Control+Enter');
    let saved;
    for (let i = 0; i < 20; i++) {
      saved = await evaluate(`() => {const n=document.getElementById('notice'),a=document.getElementById('notice-chat');return {text:n.textContent,top:n.getBoundingClientRect().top,bottom:a.getBoundingClientRect().bottom,hidden:a.hidden,height:innerHeight};}`);
      if (saved.text === 'Question saved.') break;
    }
    assert.equal(saved.text, 'Question saved.');
    assert.equal(saved.hidden, false);
    assert.ok(saved.top >= 0 && saved.bottom <= saved.height, 'confirmation and explicit next action remain visible near the reading position');
    await waitFor(() => events.some(e => e.type === 'request' && e.request.question === `Why keep this reserve at ${width}px?`));
    const request = events.find(e => e.type === 'request' && e.request.question === `Why keep this reserve at ${width}px?`).request;
    assert.deepEqual(request.handoff, { revision_id: doc.id, ...handoff });
    await delay(2200);
    const drafting = await evaluate(`() => {const f=document.getElementById('followup');f.value='What should I check next at ${width}px?';f.dispatchEvent(new Event('input'));return {status:document.getElementById('chat-status').textContent,editable:!f.disabled,sendDisabled:document.getElementById('followup-submit').disabled,y:document.getElementById('reader').scrollTop};}`);
    assert.equal(drafting.status, 'Agent is replying');
    assert.equal(drafting.editable, true);
    assert.equal(drafting.sendDisabled, true);
    await shot(`${width}-replying`);
    send({ type: 'answer', request_id: request.request_id, status: 'answered',
      body: '## Why keep reserves?\n\n**Young roots need protection.**\n\n' + '- Reassess the soil before watering.\n'.repeat(12) + '\nSupplied test fixture, not inference.',
      citations: [{ revision_id: doc.id, block_id: request.block.id, quote: request.quote }] });
    await waitFor(() => events.some(e => e.type === 'saved' && e.request_id === request.request_id));
    await delay(2200);
    const arrived = await evaluate(`() => ({y:document.getElementById('reader').scrollTop,draft:document.getElementById('followup').value,status:document.getElementById('chat-status').textContent})`);
    assert.equal(arrived.y, drafting.y, 'answer arrival must not pull a reader out of the report');
    assert.equal(arrived.draft, `What should I check next at ${width}px?`);
    assert.equal(arrived.status, 'Reply saved');
    await evaluate(`() => {document.getElementById('notice-chat').click();return true;}`);
    const chat = await evaluate(`() => {const p=document.getElementById('threads-panel'),l=document.getElementById(innerHeight<=600?'threads-panel':'chat-scroll'),r=document.getElementById('reader'),f=document.getElementById('followup-submit'),box=p.getBoundingClientRect();return {panelClient:p.clientHeight,panelScroll:p.scrollHeight,logClient:l.clientHeight,logScroll:l.scrollHeight,followupBottom:f.getBoundingClientRect().bottom,height:innerHeight,contextOpen:document.getElementById('context-details').open,top:box.top,bottom:box.bottom,right:box.right,width:innerWidth,readerRight:r.getBoundingClientRect().right,headerBottom:document.querySelector('.site-header').getBoundingClientRect().bottom,pageScroll:document.documentElement.scrollHeight,pageClient:document.documentElement.clientHeight,radius:getComputedStyle(p).borderRadius,shadow:getComputedStyle(p).boxShadow,sendName:f.getAttribute('aria-label'),sendText:f.textContent,sendWidth:f.getBoundingClientRect().width};}`);
    assert.equal(chat.contextOpen, false);
    assert.equal(chat.right, chat.width, 'chat reaches right viewport edge');
    assert.equal(chat.top, chat.headerBottom, 'chat starts directly below header');
    assert.equal(chat.bottom, chat.height, 'chat fills available height');
    assert.equal(chat.radius, '0px');
    assert.equal(chat.shadow, 'none');
    assert.equal(chat.pageScroll, chat.pageClient, 'no document-level scroll');
    assert.equal(chat.sendName, 'Send message');
    assert.equal(chat.sendText, '');
    assert.equal(chat.sendWidth, 32);
    if (width > 700) assert.equal(chat.readerRight, chat.width - (width <= 900 ? 320 : width <= 1100 ? 330 : Math.max(360, Math.min(480, width * .3))), 'report scrollbar boundary is beside chat');
    assert.ok(chat.logScroll > chat.logClient, 'chat has one independent scroll region');
    if (height > 600) {
      assert.ok(chat.panelScroll <= chat.panelClient + 2, 'no second chat panel scrollbar');
      assert.ok(chat.followupBottom <= chat.height, 'follow-up remains visible');
    }
    const independent = await evaluate(`() => {const r=document.getElementById('reader'),c=document.getElementById(innerHeight<=600?'threads-panel':'chat-scroll');const before=r.scrollTop;c.scrollTop+=80;const after=r.scrollTop,chat=c.scrollTop;if(innerWidth>700)r.scrollTop+=100;return {before,after,chat,chatAfter:c.scrollTop,page:scrollY};}`);
    assert.equal(independent.before, independent.after);
    assert.equal(independent.chat, independent.chatAfter);
    assert.equal(independent.page, 0);
    geometry.push({ width, height, chat, independent });
    if (width <= 700) {
      const switched = await evaluate(`() => {const r=document.getElementById('reader'),c=document.getElementById('chat-scroll');const chat=c.scrollTop;document.getElementById('show-report').click();r.scrollTop=240;document.getElementById('show-chat').click();const retained=c.scrollTop;document.getElementById('show-report').click();const report=r.scrollTop;document.getElementById('show-chat').click();return {chat,retained,report,hidden:r.hidden};}`);
      assert.equal(switched.chat, switched.retained);
      assert.equal(switched.report, 240);
      assert.equal(switched.hidden, true);
    }
    if (height > 600) {
      // Native keyboard scroll, not only synthetic scrollTop assignments.
      const beforeKey = await evaluate(`() => {const r=document.getElementById('reader'),c=document.getElementById('chat-scroll');c.scrollTop=0;c.focus({preventScroll:true});return r.scrollTop;}`);
      await c('press', 'PageDown'); await delay(300);
      const afterKey = await evaluate(`() => ({report:document.getElementById('reader').scrollTop,chat:document.getElementById('chat-scroll').scrollTop,page:scrollY})`);
      assert.equal(afterKey.report, beforeKey);
      assert.ok(afterKey.chat > 0, 'keyboard scroll works within the named chat region');
      assert.equal(afterKey.page, 0);
    }
    await shot(`${width}-answer`);
    const contextFit = await evaluate(`() => {document.getElementById('context-details').open=true;const p=document.getElementById('threads-panel');return {client:p.clientHeight,scroll:p.scrollHeight};}`);
    if (height > 600) assert.ok(contextFit.scroll <= contextFit.client + 2, 'expanded context stays in chat scroll, never a second panel scrollbar');
    await evaluate(`() => {document.getElementById('context-details').open=false;return true;}`);
    await evaluate(`() => {const f=document.getElementById('followup');f.scrollIntoView({block:'center'});f.focus({preventScroll:true});return true;}`);
    const followupComposer = await composerStyle('followup');
    assertCaretComposer(followupComposer);
    assert.deepEqual(followupComposer, questionComposer, 'both composers share geometry, spacing, colors and caret-only focus');
    await shot(`${width}-composer`);
    await c('press', 'Control+Enter');
    await waitFor(() => events.some(e => e.type === 'request' && e.request.question === `What should I check next at ${width}px?`));
    const followup = events.find(e => e.type === 'request' && e.request.question === `What should I check next at ${width}px?`).request;
    assert.equal(followup.conversation_id, request.thread_id);
    assert.equal(followup.document.id, doc.id);
    assert.equal(followup.quote, request.quote);
    assert.equal(followup.history.length, 2);
    assert.equal(followup.history[0].body, request.question);
    assert.deepEqual(followup.handoff, request.handoff);
    // Keep an earlier source disclosure focused while a new reply is appended.
    await evaluate(`() => {const d=document.querySelector('.citation-details');d.open=true;d.querySelector('summary').focus();return true;}`);
    send({ type: 'answer', request_id: followup.request_id, status: 'answered', body: 'Check the **soil moisture**, then review the reserve after rainfall.\n\nSupplied fixture, not inference.', citations: [{ revision_id: doc.id, block_id: followup.block.id, quote: followup.quote }] });
    await waitFor(() => events.some(e => e.type === 'saved' && e.request_id === followup.request_id));
    await delay(2200);
    const continued = await evaluate(`() => ({count:document.querySelectorAll('.message').length,open:document.querySelector('.citation-details').open,focused:document.activeElement===document.querySelector('.citation-details summary'),draft:document.getElementById('followup').value})`);
    assert.equal(continued.count, 4);
    assert.equal(continued.open, true);
    assert.equal(continued.focused, true);
    assert.equal(continued.draft, '');
    await evaluate(`() => {const b=document.getElementById('latest-reply');if (!b.hidden) b.click();else document.querySelector('.message.agent:last-of-type').scrollIntoView({block:'center'});return true;}`);
    await shot(`${width}-continuous`);
    await evaluate(`() => {document.getElementById('conversation-toggle').focus();return true;}`);
    await c('press', 'Enter');
    const finder = await evaluate(`() => {const d=document.getElementById('conversation-list'),r=document.getElementById('conversation-choices').getBoundingClientRect(),h=document.querySelector('.chat-header').getBoundingClientRect();return {open:d.open,left:r.left,right:r.right,headerLeft:h.left,headerRight:h.right,focused:document.activeElement===document.getElementById('conversation-toggle')};}`);
    assert.equal(finder.open, true);
    assert.equal(finder.focused, true);
    assert.ok(finder.left >= finder.headerLeft && finder.right <= finder.headerRight, 'finder is not clipped by the chat pane');
    await shot(`${width}-finder`);
    await c('press', 'Tab'); await c('press', 'Enter');
    const chosen = await evaluate(`() => ({open:document.getElementById('conversation-list').open,focused:document.activeElement===document.getElementById('conversation-toggle'),id:document.getElementById('messages').dataset.conversationId})`);
    assert.equal(chosen.open, false); assert.equal(chosen.focused, true);
    assert.equal(chosen.id, request.thread_id, 'native keyboard finder selects the latest conversation');

    await evaluate(`() => {document.querySelector('.citation').click();return true;}`);
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
  await evaluate(`() => {const f=document.getElementById('followup');f.value='Keep this interrupted question';f.dispatchEvent(new Event('input'));document.getElementById('followup-form').requestSubmit();return true;}`);
  await waitFor(() => events.some(e => e.type === 'request' && e.request.question === 'Keep this interrupted question'));
  await evaluate(`() => {document.querySelector('#report > p').scrollIntoView({block:'center'});return true;}`);
  input.end();
  await running;
  await delay(2200);
  const alert = await evaluate(`() => {const e=document.getElementById('answer-alert'),r=e.getBoundingClientRect();return {hidden:e.hidden,text:e.textContent,top:r.top,bottom:r.bottom,height:innerHeight};}`);
  assert.equal(alert.hidden, false);
  assert.match(alert.text, /Replies are paused/);
  assert.ok(alert.top >= 0 && alert.bottom <= alert.height, 'loss is visible while reading a scrolled report');
  await shot('listening-loss');
  const failed = await evaluate(`() => {document.getElementById('show-chat').click();const r=document.querySelector('.message.failed');r.scrollIntoView({block:'center'});return {status:document.getElementById('chat-status').textContent,explanation:r.textContent,count:document.querySelectorAll('.message').length};}`);
  assert.equal(failed.status, 'Reply failed · question saved');
  assert.equal(failed.count, 6);
  assert.match(failed.explanation, /disconnect|stopped/i);
  await shot('interrupted-reply');
  await c('open', origin);
  const restored = await evaluate(`() => ({status:document.getElementById('chat-status').textContent,count:document.querySelectorAll('.message').length,question:document.querySelectorAll('.message.user')[2].textContent,revision:document.getElementById('context-label').textContent,collapsed:document.getElementById('toc-panel').hidden})`);
  assert.equal(restored.status, 'Reply failed · question saved');
  assert.equal(restored.count, 6);
  assert.match(restored.question, /Keep this interrupted question/);
  assert.equal(restored.revision, 'Quoted passage');
  assert.equal(restored.collapsed, true);
  await c('emulate', '--viewport', '1440x1000x1');
  const anchor = await evaluate(`() => {document.getElementById('show-report').click();const r=document.getElementById('reader');r.scrollTop=900;const blocks=[...document.querySelectorAll('#report [data-block-id]')];blocks.sort((a,b)=>Math.abs(a.getBoundingClientRect().top-r.getBoundingClientRect().top-16)-Math.abs(b.getBoundingClientRect().top-r.getBoundingClientRect().top-16));const p=blocks[0];return {id:p.id,offset:p.getBoundingClientRect().top-r.getBoundingClientRect().top,chat:document.getElementById('chat-scroll').scrollTop};}`);
  const updatedSource = source.replace('# Orchard review', '# Orchard review\n\nAn added introduction from the synthetic author.');
  app.store.importReport({title:'Orchard review', source:updatedSource});
  await delay(2200);
  const updated = await evaluate(`() => ({offset:document.getElementById('${anchor.id}').getBoundingClientRect().top-document.getElementById('reader').getBoundingClientRect().top,chat:document.getElementById('chat-scroll').scrollTop})`);
  assert.ok(Math.abs(updated.offset-anchor.offset) < 2, 'live revision keeps a safe report anchor inside its pane');
  assert.equal(updated.chat, anchor.chat, 'report revision does not move chat reading');
  await shot('live-revision-wide');
  await c('emulate', '--viewport', '390x844x1');
  await evaluate(`() => {document.getElementById('show-report').click();document.getElementById('reader').scrollTop=400;document.getElementById('show-chat').click();return true;}`);
  app.store.importReport({title:'Orchard review', source:updatedSource+'\n\nOne more synthetic update.'});
  await delay(2200);
  const hiddenUpdate = await evaluate(`() => {const r=document.getElementById('reader'),hidden=r.hidden;document.getElementById('show-report').click();return {hidden,y:r.scrollTop};}`);
  assert.equal(hiddenUpdate.hidden, true);
  assert.equal(hiddenUpdate.y, 400, 'hidden report revision retains approximate saved position');
  await shot('live-revision-narrow');
  writeFileSync(`${evidence}/geometry.json`, JSON.stringify(geometry, null, 2));
  writeFileSync(`${evidence}/console.txt`, await c('console'));
  writeFileSync(`${evidence}/network.txt`, await c('network'));
  writeFileSync(`${evidence}/result.json`, JSON.stringify({ result: 'passed', viewports: ['1440x1000', '1280x720', '390x844', '320x844', '844x390'], handoffEvents: events.map(e => e.type), source }, null, 2));
  console.log(`Browser layout regressions passed. Evidence: ${evidence}`);
} finally {
  input.end();
  await running;
  try { if (page) await c('closepage', String(page)); }
  finally { await new Promise(resolve => app.server.close(resolve)); }
}
