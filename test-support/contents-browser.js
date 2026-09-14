import assert from 'node:assert/strict';

// Shared by the opt-in browser suite and local, synthetic reader previews.
// Assertions use the running UI, native keys, computed layout and the AX tree.
export async function checkContentsToggle({ evaluate, snapshot, press, shot, width }) {
  const state = () => evaluate(`() => {
    const button=document.getElementById('toc-toggle'),panel=document.getElementById('toc-panel'),reader=document.getElementById('reader');
    const box=button.getBoundingClientRect(),p=panel.getBoundingClientRect(),r=reader.getBoundingClientRect();
    const icons=[...button.querySelectorAll('svg')].map(icon=>{const b=icon.getBoundingClientRect();return {width:b.width,height:b.height};});
    const chevron=button.querySelector('.toc-chevron');
    const matrix=chevron ? new DOMMatrix(getComputedStyle(chevron).transform) : null;
    return {expanded:button.getAttribute('aria-expanded'),hidden:panel.hidden,display:getComputedStyle(panel).display,
      focused:document.activeElement===button,focusVisible:button.matches(':focus-visible'),outline:getComputedStyle(button).outlineStyle,
      label:button.innerText.trim(),width:box.width,height:box.height,left:box.left,right:box.right,top:box.top,bottom:box.bottom,
      hit:button.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)),icons,direction:matrix?[matrix.a,matrix.d]:null,
      panelLeft:p.left,panelRight:p.right,panelTop:p.top,panelBottom:p.bottom,readerLeft:r.left,readerRight:r.right,scroll:reader.scrollTop,
      viewport:innerWidth,viewportHeight:innerHeight,pageWidth:document.documentElement.scrollWidth,headerBottom:document.querySelector('.site-header').getBoundingClientRect().bottom};
  }`);
  const assertState = async expanded => {
    const current = await state();
    assert.equal(current.expanded, String(expanded));
    assert.equal(current.hidden, !expanded);
    assert.equal(current.display === 'none', !expanded);
    assert.equal(current.label, 'Contents');
    assert.deepEqual(current.direction, expanded ? [-1, -1] : [1, 1], 'the visible chevron follows disclosure state');
    const tree = await snapshot();
    const button = tree.split('\n').find(line => line.includes('button "Contents"'));
    assert.ok(button, 'the accessibility tree exposes the stable Contents button name');
    assert.equal(/\bexpanded\b/.test(button), expanded);
    assert.equal(tree.includes('navigation "Table of contents"'), expanded, 'collapsed Contents leaves the accessibility tree');
    return current;
  };
  const closed = await assertState(false);
  assert.equal(closed.viewport, width, 'test the requested viewport, not the native window minimum');
  assert.equal(closed.pageWidth, width, 'no horizontal page overflow');
  assert.ok(closed.width >= 44 && closed.height >= 44, 'usable pointer/touch target');
  assert.ok(closed.width < 140 && closed.height <= 44, 'the labelled control remains compact');
  assert.ok(closed.left >= 0 && closed.right <= width && closed.top >= 0 && closed.bottom <= closed.viewportHeight);
  assert.equal(closed.hit, true, 'the visible target is not covered');
  assert.deepEqual(closed.icons, [{ width: 16, height: 16 }, { width: 12, height: 12 }]);

  await evaluate(`() => {document.getElementById('reader').scrollTop=100;document.querySelector('.skip-link').focus();return true;}`);
  await press('Tab');
  const focused = await state();
  assert.equal(focused.focused, true, 'Tab reaches the semantic button');
  assert.equal(focused.focusVisible, true);
  assert.notEqual(focused.outline, 'none', 'keyboard focus remains visible');
  await press('Enter');
  const opened = await assertState(true);
  assert.equal(opened.scroll, 100, 'opening Contents does not scroll the report');
  assert.equal(opened.pageWidth, width);
  assert.ok(opened.panelLeft >= 0 && opened.panelRight <= width);
  assert.ok(opened.panelTop >= opened.headerBottom && opened.panelBottom <= opened.viewportHeight);
  if (width > 900) {
    assert.equal(opened.panelRight, opened.readerLeft, 'wide Contents stays beside the report');
    assert.ok(opened.readerLeft > closed.readerLeft);
  } else {
    assert.equal(opened.panelLeft, opened.readerLeft, 'narrow Contents overlays the report');
    assert.equal(opened.readerRight, closed.readerRight, 'the overlay does not squeeze the report');
  }
  await shot(`${width}-contents-open`);
  await press('Space');
  await assertState(false);
  await shot(`${width}-contents-closed`);
  await press('Enter');
  await evaluate(`() => {document.querySelector('#toc a').focus();return true;}`);
  await press('Escape');
  assert.equal((await assertState(false)).focused, true, 'Escape closes Contents and restores trigger focus');
  await press('Enter');
  await evaluate(`() => {document.querySelector('#toc a').click();return true;}`);
  await assertState(width > 900);
  assert.equal(await evaluate(`() => document.activeElement===document.querySelector('#report h1')`), true);
  if (width > 900) await press('Escape');
  await evaluate(`() => {document.getElementById('reader').scrollTop=0;return true;}`);
}
