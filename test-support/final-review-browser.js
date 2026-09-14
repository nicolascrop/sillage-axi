import assert from 'node:assert/strict';

// Execute the real reader and native keyboard/pointer actions. No source inspection.
export async function checkReviewControls({ evaluate, c, snapshot, shot, width, height }) {
  const click = async pattern => {
    const line = (await snapshot()).split('\n').find(line => pattern.test(line));
    assert.ok(line, `Missing accessible control: ${pattern}`);
    await c('click', '@' + /uid=([^ ]+)/.exec(line)[1]);
  };
  const initial = await evaluate(`() => {
    const t=document.getElementById('toc-toggle'),r=t.getBoundingClientRect(),logo=t.nextElementSibling.getBoundingClientRect();
    return {text:t.textContent,name:t.getAttribute('aria-label'),w:r.width,h:r.height,left:r.left,right:r.right,logoLeft:logo.left,expanded:t.getAttribute('aria-expanded'),switcher:!document.getElementById('workspace-switcher').hidden,heading:document.querySelector('.chat-heading h3').textContent,duplicate:!!document.querySelector('.site-header #show-chat,.site-header #show-report,#new-reply,#bubble-close')};
  }`);
  assert.equal(initial.text, ''); assert.equal(initial.name, 'Table of contents');
  assert.equal(initial.w, 44); assert.equal(initial.h, 44); assert.ok(initial.right <= initial.logoLeft);
  assert.equal(initial.expanded, 'false'); assert.equal(initial.switcher, width <= 700);
  assert.equal(initial.heading, 'Conversation'); assert.equal(initial.duplicate, false);
  await evaluate(`() => {document.getElementById('toc-toggle').focus();return true;}`);
  await c('press', 'Enter');
  const open = await evaluate(`() => {const t=document.getElementById('toc-toggle'),p=document.getElementById('toc-panel'),r=p.getBoundingClientRect();return {expanded:t.getAttribute('aria-expanded'),hidden:p.hidden,outline:getComputedStyle(t).outlineStyle,shadow:getComputedStyle(t).boxShadow,left:r.left,right:r.right,height:r.height};}`);
  assert.equal(open.expanded, 'true'); assert.equal(open.hidden, false);
  assert.equal(open.outline, 'solid'); assert.notEqual(open.shadow, 'none');
  assert.ok(open.left >= 0 && open.right <= width && open.height > 0);
  await shot(`${width}x${height}-contents-icon`);
  await c('press', 'Escape');
  assert.deepEqual(await evaluate(`() => ({hidden:document.getElementById('toc-panel').hidden,focused:document.activeElement.id})`), { hidden: true, focused: 'toc-toggle' });
  await c('press', 'Space');
  assert.equal(await evaluate(`() => document.getElementById('toc-panel').hidden`), false);
  await c('press', 'Space');
  assert.equal(await evaluate(`() => document.getElementById('toc-panel').hidden`), true);
  await evaluate(`() => {document.getElementById('review-menu-toggle').focus();return true;}`);
  await c('press', 'ArrowDown');
  const menu = await evaluate(`() => {const e=document.getElementById('review-menu'),r=e.getBoundingClientRect();return {hidden:e.hidden,focused:document.activeElement.id,expanded:document.getElementById('review-menu-toggle').getAttribute('aria-expanded'),left:r.left,right:r.right,bottom:r.bottom,height:innerHeight};}`);
  assert.equal(menu.hidden, false); assert.equal(menu.focused, 'end-session'); assert.equal(menu.expanded, 'true');
  assert.ok(menu.left >= 0 && menu.right <= width && menu.bottom <= menu.height);
  await shot(`${width}x${height}-review-options`);
  await c('press', 'Escape');
  assert.equal(await evaluate(`() => document.activeElement.id`), 'review-menu-toggle');
  await c('press', 'Enter'); await c('press', 'Tab');
  assert.equal(await evaluate(`() => document.getElementById('review-menu').hidden && document.activeElement.id!=='end-session'`), true);
  await click(/button "Review options"/);
  await click(/StaticText "Sillage AXI"/);
  assert.equal(await evaluate(`() => document.getElementById('review-menu').hidden`), true);
  await evaluate(`() => {const p=document.querySelector('#report > p');p.scrollIntoView({block:'center'});p.focus();return true;}`);
  await c('press', 'Enter');
  assert.equal(await evaluate(`() => document.getElementById('bubble').hidden`), false);
  await click(/heading "Ask about this passage"/);
  assert.equal(await evaluate(`() => document.getElementById('bubble').hidden`), false);
  await click(/button "Review options"/);
  assert.equal(await evaluate(`() => document.getElementById('bubble').hidden`), true);
  assert.equal(await evaluate(`() => document.activeElement.id`), 'end-session');
  await c('press', 'Escape');
  await evaluate(`() => {document.getElementById('reader').scrollTop=0;return true;}`);
}
