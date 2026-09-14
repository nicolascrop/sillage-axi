// Opt-in real browser evidence through chrome-devtools-axi only. No browser launch,
// downloads, provider or inference. All reports/replies are synthetic fixtures.
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
import { buildWhiteboard } from './build-whiteboard.js';

assert.match(process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL || '', /^http:\/\/127\.0\.0\.1:\d+\/?$/, 'Select an existing loopback Chrome using CHROME_DEVTOOLS_AXI_BROWSER_URL');
await buildWhiteboard();
const evidence = resolve(`.data/test/whiteboard-browser-${process.pid}`);
mkdirSync(evidence, { recursive: true });
const app = createApp({ dbPath: `${evidence}/fixture.sqlite` });
app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
const origin = `http://127.0.0.1:${app.server.address().port}`;
const execute = promisify(execFile);
const c = async (...args) => {
  const { stdout } = await execute('chrome-devtools-axi', args, { timeout: 90_000, maxBuffer: 10_000_000, env: process.env });
  if (/^error:/m.test(stdout)) throw new Error(stdout);
  return stdout;
};
const observation = output => decode(output.split(/\nhelp\[/)[0]);
// AXI's scroll/run wrappers are unavailable in this environment. Firstmate's
// supported path is eval with an explicitly selected page and fresh snapshot.
async function prepare() {
  const pages = observation(await c('pages')).pages;
  // A shared Chrome may reconnect and AXI may renumber its tab handles. The
  // unique fixture origin, not a cached numeric handle, owns our page identity.
  page = pages.find(p => p.url.replace(/\/$/, '') === origin)?.id;
  assert.ok(page, 'The fixture page must still exist before browser actions');
  await c('selectpage', String(page));
  return c('snapshot');
}
async function action(...args) {
  await prepare();
  const result = await c(...args);
  await c('snapshot');
  return result;
}
const evaluate = async expression => {
  const result = observation(await action('eval', expression)).result;
  return typeof result === 'string' ? JSON.parse(result) : result;
};
const reference = async regex => {
  const snapshot = await prepare();
  const line = snapshot.split('\n').find(line => regex.test(line));
  assert.ok(line, `Missing browser control ${regex}\n${snapshot}`);
  return '@' + /uid=([^ ]+)/.exec(line)[1];
};
async function referencedAction(command, regex, ...args) {
  // STALE_REF explicitly means no action ran. Reacquire once, as AXI instructs;
  // never retry another error or an uncertain successful click.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await c(command, await reference(regex), ...args);
      await c('snapshot'); return result;
    } catch (error) {
      if (attempt || !String(error.stdout || '').includes('code: STALE_REF')) throw error;
      console.error('Reacquiring a stale AX reference for', command, String(regex));
    }
  }
}
const click = regex => referencedAction('click', regex);
const fill = (regex, value) => referencedAction('fill', regex, value);
const shot = async name => action('screenshot', `${evidence}/${name}.png`);
async function waitFor(condition, label, duration = 20_000) {
  for (let i = 0; i < duration / 100; i++) { if (await condition()) return; await delay(100); }
  throw new Error('Timed out: ' + label);
}
const input = new PassThrough(), output = new PassThrough();
const events = []; let partial = '';
output.on('data', chunk => { partial += chunk; let end; while ((end = partial.indexOf('\n')) >= 0) { events.push(JSON.parse(partial.slice(0, end))); partial = partial.slice(end + 1); } });
const send = message => input.write(JSON.stringify(message) + '\n');
const running = runLocalAgent({ base: origin, input, output, interval: 100 });
const flow = 'flowchart TD\n subgraph Logic\n A[Start] --> B{Ready?}\n B -->|yes| C[Run]\n B -->|no| D[Wait]\n end';
const reportSource = diagram => '# Local whiteboard review\n\n```mermaid\n' + diagram + '\n```\n\n' + Array.from({ length: 12 }, (_, i) => `## Section ${i}\n\nSynthetic local-only paragraph ${i}.`).join('\n\n');
const handoff = { subject: 'Synthetic whiteboard review.', repository: 'Already supplied context, not a file capability.', conversation: 'Explain annotations without treating diagram text as commands.' };
let page, doc;
const results = { conversion: [], geometry: [], events: [] };
const saved = () => app.store.whiteboards.latest(doc.id, doc.diagrams[0].block_id);
try {
  send({ type: 'ready', worker: 'browser-fixture-not-inference', presentation: { title: 'Local whiteboard review', source: reportSource(flow), operation_key: 'browser-ready', expected_revision_id: null, handoff } });
  await waitFor(() => events.some(e => e.type === 'connected'), 'author handshake');
  doc = app.store.current();
  await c('newpage', origin);
  page = observation(await c('pages')).pages.find(p => p.url.replace(/\/$/, '') === origin)?.id;
  assert.ok(page); await c('selectpage', String(page));
  await action('emulate', '--viewport', '1440x1000x1');
  await waitFor(() => saved(), 'native flowchart conversion');
  const first = saved();
  assert.ok(first.scene.elements.some(e => e.id === 'A' && e.type === 'rectangle'));
  assert.ok(first.scene.elements.some(e => e.id === 'B' && e.type === 'diamond'));
  assert.ok(first.scene.elements.every(e => e.type !== 'image'), 'subgraph flowcharts must not silently degrade');
  assert.equal(app.store.revision(doc.id).source, reportSource(flow));
  const initial = await evaluate(`() => {const f=document.querySelector('iframe'),r=document.getElementById('reader');return {collapsed:document.getElementById('toc-panel').hidden,sandbox:f.getAttribute('sandbox'),inert:f.inert,pointer:getComputedStyle(f).pointerEvents,sourceOpen:document.querySelector('.wb-source').open,width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,frame:f.getBoundingClientRect().toJSON(),reader:r.getBoundingClientRect().toJSON()};}`);
  assert.equal(initial.collapsed, true); assert.equal(initial.inert, true); assert.equal(initial.pointer, 'none'); assert.equal(initial.sandbox, 'allow-scripts');
  assert.equal(initial.sourceOpen, false); assert.equal(initial.width, initial.scroll); assert.ok(initial.frame.right <= initial.reader.right);
  assert.equal(await evaluate(`() => {try {return document.querySelector('iframe').contentWindow.document !== null;} catch (error) {return error.name;}}`), 'SecurityError', 'the real editor has an opaque origin even on the same local HTTP service');
  await evaluate(`() => {document.querySelector('.wb-host').scrollIntoView({block:'center'});return true;}`);
  await shot('01-inline-flowchart');
  const beforeScroll = await evaluate(`() => ({reader:document.getElementById('reader').scrollTop,chat:document.getElementById('chat-scroll').scrollTop})`);
  const hitTarget = await evaluate(`() => { const r=document.querySelector('iframe').getBoundingClientRect(); return document.elementFromPoint(r.left+r.width/2,Math.min(innerHeight-30,r.top+r.height/2)).className; }`);
  assert.equal(hitTarget, 'wb-cover', 'locked iframe is outside pointer hit testing');
  await evaluate(`() => {document.getElementById('reader').scrollBy(0,600);return document.getElementById('reader').scrollTop;}`);
  await delay(400);
  const afterScroll = await evaluate(`() => ({reader:document.getElementById('reader').scrollTop,chat:document.getElementById('chat-scroll').scrollTop,page:scrollY})`);
  assert.ok(afterScroll.reader > beforeScroll.reader, 'report scroll is independent of locked whiteboard');
  assert.equal(afterScroll.chat, beforeScroll.chat); assert.equal(afterScroll.page, 0);
  await evaluate(`() => {document.querySelector('.wb-host').scrollIntoView({block:'center'});document.querySelector('.wb-cover').focus();return true;}`);
  const keyBefore = await evaluate(`() => document.getElementById('reader').scrollTop`);
  await action('press', 'PageDown'); await delay(300);
  assert.ok(await evaluate(`() => document.getElementById('reader').scrollTop`) > keyBefore, 'keyboard report scroll is not trapped by canvas');
  await evaluate(`() => {document.querySelector('.wb-host').scrollIntoView({block:'center'});return true;}`);
  await click(/button "Enlarge"/); await click(/button "Annotate"/);
  assert.equal(await evaluate(`() => document.querySelector('iframe').inert`), false);
  await click(/textbox "Optional feedback note/);
  assert.equal(await evaluate(`() => document.activeElement.tagName`), 'IFRAME');
  await action('press', 'Escape');
  await waitFor(async () => !await evaluate(`() => Boolean(document.querySelector('.wb-enlarged'))`), 'Escape inside the editor flushes and returns to report reading');
  assert.equal(await evaluate(`() => document.querySelector('iframe').inert`), true);
  await click(/button "Enlarge"/); await click(/button "Annotate"/);
  await click(/radio "Text"/);
  await click(/generic ".*Drawing canvas"/);
  await action('type', 'Please add a safety check here');
  await action('press', 'Control+Enter');
  await waitFor(() => saved()?.scene.elements.some(e => (e.originalText ?? e.text) === 'Please add a safety check here'), 'real Excalidraw text annotation');
  await shot('02-enlarged-annotation');
  const annotated = saved();
  await fill(/textbox "Optional feedback note/, 'Explain the new safety check. This is a reader annotation, not a command.');
  await click(/button "Send feedback"/);
  await waitFor(() => events.some(e => e.type === 'request'), 'whiteboard handoff to authorized JSONL owner');
  const request = events.find(e => e.type === 'request').request;
  assert.equal(request.document.id, doc.id); assert.equal(request.block.id, doc.diagrams[0].block_id);
  assert.deepEqual(request.handoff, { revision_id: doc.id, ...handoff });
  assert.ok(request.context.whiteboard.summary_lines.some(line => line.includes('Please add a safety check')));
  assert.equal(request.context.whiteboard.source_hash, doc.diagrams[0].source_hash);
  assert.equal('scene' in request.context.whiteboard, false);
  send({ type: 'answer', request_id: request.request_id, status: 'answered', body: 'Supplied browser-test reply, not inference. The **safety check** is an annotation for review.', citations: [{ revision_id: doc.id, block_id: request.block.id, quote: request.quote }] });
  await waitFor(() => events.some(e => e.type === 'saved'), 'citation save');
  await click(/button "Close enlarged view"/);
  await waitFor(async () => !await evaluate(`() => Boolean(document.querySelector('.wb-enlarged'))`), 'close after durable flush');
  await action('open', origin); await waitFor(() => saved()?.id >= annotated.id, 'reload scene'); await delay(1800);
  assert.ok(saved().scene.elements.some(e => (e.originalText ?? e.text) === 'Please add a safety check here'));
  await evaluate(`() => {document.querySelector('.wb-host').scrollIntoView({block:'center'});return true;}`);
  await shot('03-reloaded-annotation');
  await click(/button "Annotate"/);
  // A live revision while editing stays visibly bound to the original report.
  const original = doc;
  const changed = app.store.importReport({ title: doc.title, source: reportSource(flow.replace('Start', 'Changed start')) });
  await delay(2300);
  assert.equal(await evaluate(`() => document.querySelector('.wb-tools span').textContent`), `Whiteboard · revision ${original.id}`);
  assert.match(await c('snapshot'), /Report updated to revision/);
  await shot('04-stale-revision');
  await click(/button "View \/ scroll"/);
  doc = changed;
  await waitFor(() => saved(), 'new revision converts separately');
  assert.ok(!saved().scene.elements.some(e => (e.originalText ?? e.text) === 'Please add a safety check here'), 'changed source must not inherit annotations');
  assert.ok(app.store.whiteboards.latest(original.id, original.diagrams[0].block_id).scene.elements.some(e => (e.originalText ?? e.text) === 'Please add a safety check here'));
  const cited = app.store.thread(request.thread_id);
  assert.equal(cited.anchor_status, 'needs_review'); assert.equal(cited.messages[1].citations[0].revision_id, original.id);
  await click(/DisclosureTriangle "Whiteboard history"/);
  await click(new RegExp(`button "Revision ${original.id} ·`));
  await delay(1800); await click(/button "Annotate"/);
  await shot('05-historical-scene');
  await click(/button "Close history"/); await delay(500);
  // Small screens preserve the report/chat switch and contained enlarged editor.
  for (const width of [390, 320]) {
    // Headed Linux windows clamp native width; emulate the exact CSS viewport.
    await action('emulate', '--viewport', `${width}x844x1`);
    await evaluate(`() => {document.getElementById('show-report').click();document.querySelector('.wb-host').scrollIntoView({block:'center'});return true;}`);
    const geometry = await evaluate(`() => ({width:innerWidth,scroll:document.documentElement.scrollWidth,frame:document.querySelector('iframe').getBoundingClientRect().toJSON(),reader:document.getElementById('reader').getBoundingClientRect().toJSON(),chatHidden:document.getElementById('threads-panel').hidden})`);
    assert.equal(geometry.width, geometry.scroll); assert.ok(geometry.frame.right <= geometry.reader.right); assert.equal(geometry.chatHidden, true);
    await shot(`${width}-inline`);
    await click(/button "Enlarge"/); await click(/button "Annotate"/);
    const enlarged = await evaluate(`() => document.querySelector('.wb-enlarged').getBoundingClientRect().toJSON()`);
    assert.equal(enlarged.width, width); assert.equal(enlarged.height, 844);
    assert.match(await c('snapshot'), /textbox "Optional feedback note/);
    await waitFor(() => (saved()?.scene.appState.zoom?.value ?? 1) < 0.7, 'narrow enlarged scene fits the available canvas');
    await shot(`${width}-editing`);
    await click(/button "Close enlarged view"/); await delay(300);
    results.geometry.push({ width, geometry, enlarged });
  }
  await action('emulate', '--viewport', '1440x1000x1');
  // Pinned Lavish matrix: supported shapes vs explicit draw-on-image fallback.
  const cases = [
    ['parallel-flow', 'flowchart LR\n A --> B\n A --> B', false],
    ['sequence', 'sequenceDiagram\n Alice->>Bob: Hello\n Bob-->>Alice: Ready', false],
    ['class', 'classDiagram\n Animal <|-- Duck\n Animal : +int age\n Duck : +swim()', false],
    ['er', 'erDiagram\n CUSTOMER ||--o{ ORDER : places', false],
    ['state', 'stateDiagram-v2\n [*] --> Ready\n Ready --> Done\n Done --> [*]', false],
    ['pie', 'pie title Allocation\n "A" : 40\n "B" : 60', true],
  ];
  for (const [name, diagram, fallback] of cases) {
    doc = app.store.importReport({ title: 'Local whiteboard review', source: reportSource(diagram) });
    await action('open', origin);
    await waitFor(() => saved(), `conversion ${name}`, 40_000);
    const record = saved();
    assert.equal(record.baseline.elements.every(e => e.type === 'image'), fallback, `${name} conversion matrix`);
    assert.equal(new Set(record.scene.elements.map(e => e.id)).size, record.scene.elements.length, `${name} unique IDs`);
    if (name === 'parallel-flow') assert.ok(record.scene.elements.some(e => e.id === 'A'), 'duplicate edges must not randomize node identity');
    await evaluate(`() => {document.querySelector('.wb-host').scrollIntoView({block:'center'});return true;}`);
    await shot(`matrix-${name}`);
    results.conversion.push({ name, fallback, types: [...new Set(record.scene.elements.map(e => e.type))], elements: record.scene.elements.length });
    if (fallback) {
      await click(/button "Enlarge"/); await click(/button "Annotate"/);
      await click(/radio "Text"/); await click(/generic ".*Drawing canvas"/);
      await action('type', 'Review this allocation'); await action('press', 'Control+Enter');
      await waitFor(() => saved()?.scene.elements.some(e => (e.originalText ?? e.text) === 'Review this allocation'), 'image fallback accepts native annotations');
      await click(/button "Close enlarged view"/); await delay(300);
      await action('open', origin); await delay(1800);
      await click(/button "Annotate"/);
      assert.match(await c('snapshot'), /not natively editable/, 'reload must still disclose an image conversion after adding native annotations');
      await shot('image-fallback-annotation-reloaded');
      await click(/button "View \/ scroll"/);
    }
  }
  const multiple = app.store.importReport({ title: 'Multiple diagrams', source: reportSource('flowchart LR\n A-->B') + '\n\n```mermaid\nsequenceDiagram\n Alice->>Bob: Local message\n```' });
  await action('open', origin);
  await waitFor(() => multiple.diagrams.every(d => app.store.whiteboards.latest(multiple.id, d.block_id)), 'every report Mermaid fence gets its own inline scene');
  assert.equal(await evaluate(`() => document.querySelectorAll('#report iframe').length`), 2);
  for (const diagram of multiple.diagrams) assert.equal(app.store.whiteboards.latest(multiple.id, diagram.block_id).source_hash, diagram.source_hash);
  await shot('multiple-inline-diagrams');
  doc = app.store.importReport({ title: 'Malformed diagram', source: reportSource('not-a-mermaid-diagram') });
  await action('open', origin); await delay(2500);
  assert.match(await evaluate(`() => document.querySelector('.wb-local-status').textContent`), /Could not convert/);
  assert.equal(await evaluate(`() => document.querySelector('.wb-source code').textContent`), 'not-a-mermaid-diagram');
  assert.equal(saved(), null);
  await shot('malformed-source-fallback');
  doc = app.store.importReport({ title: 'Offline fixture', source: reportSource('flowchart LR\n A-->B') });
  await action('open', origin); await waitFor(() => saved(), 'offline fixture conversion');
  // Offline reconnect: the editor remains usable, failure stays visible, retry
  // preserves its exact operation key, and no remote provider is involved.
  await click(/button "Enlarge"/); await click(/button "Annotate"/);
  await action('emulate', '--network', 'Offline');
  await click(/radio "Text"/); await click(/generic ".*Drawing canvas"/);
  await action('type', 'Offline annotation survives reconnect'); await action('press', 'Control+Enter');
  await delay(2200);
  assert.match(await c('snapshot'), /failed|Failed|unavailable|fetch/i);
  await shot('06-offline-pending-save');
  await action('emulate', '--network', 'Fast 4G');
  await click(/button "Retry save \/ reconnect"/);
  await waitFor(() => saved()?.scene.elements.some(e => (e.originalText ?? e.text) === 'Offline annotation survives reconnect'), 'offline edit save after reconnect');
  await click(/button "Close enlarged view"/); await delay(300);
  // Check each bounded network page so the AXI output truncation cannot hide URLs.
  let network = '';
  for (let page = 0; page < 30; page++) {
    const batch = await c('network', '--limit', '20', '--page', String(page));
    network += batch + '\n';
    const range = /Showing (\d+)-(\d+) of (\d+)/.exec(batch);
    if (!range || Number(range[2]) >= Number(range[3])) break;
  }
  assert.equal(/(?:GET|POST|PUT|PATCH) https?:\/\/(?!127\.0\.0\.1:)/.test(network), false, 'no non-loopback request');
  const consoleOutput = await c('console');
  assert.equal(/esm\.sh|fonts.*blocked/.test(consoleOutput), false, 'all fonts must be local, not silently fall back');
  writeFileSync(`${evidence}/network.txt`, network); writeFileSync(`${evidence}/console.txt`, consoleOutput);
  results.events = events.map(e => e.type); results.result = 'passed'; results.origin = origin;
  writeFileSync(`${evidence}/result.json`, JSON.stringify(results, null, 2));
  console.log(`Whiteboard browser checks passed. Evidence: ${evidence}`);
} finally {
  await action('emulate', '--network', 'Fast 4G').catch(() => {});
  input.end(); await running;
  try {
    const pages = observation(await c('pages')).pages;
    const current = pages.find(p => p.url.replace(/\/$/, '') === origin);
    if (current) await c('closepage', String(current.id));
  } catch (error) { console.error('Fixture page cleanup:', error.message); }
  finally { await new Promise(resolve => app.server.close(resolve)); }
}
