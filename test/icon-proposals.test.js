import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { JSDOM } from 'jsdom';

const html = readFileSync('proposals/icons.html', 'utf8');

async function board(t) {
  const dom = new JSDOM(html, { url: 'file:///sillage/proposals/icons.html', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  await once(dom.window, 'load');
  // Storage, requests and application state are outside this standalone study.
  for (const api of ['localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'WebSocket']) {
    Object.defineProperty(dom.window, api, { get() { assert.fail(`Proposal board accessed ${api}`); } });
  }
  dom.window.eval(dom.window.document.querySelector('script').textContent);
  const document = dom.window.document;
  return { window: dom.window, document, choices: [...document.querySelectorAll('input[type="radio"]')] };
}

test('standalone board contains exactly ten distinct, accessible inline-SVG proposals', async t => {
  const { document, choices } = await board(t);
  assert.equal(choices.length, 10);
  assert.equal(document.querySelectorAll('.candidate').length, 10);
  assert.equal(new Set(choices.map(choice => choice.value)).size, 10);
  const names = new Set();
  const artwork = new Set();
  for (const choice of choices) {
    assert.equal(choice.name, 'icon-choice');
    assert.equal(choice.disabled, false);
    const card = choice.closest('label');
    assert.equal(card.htmlFor, choice.id);
    const name = document.getElementById(choice.getAttribute('aria-labelledby')).textContent;
    names.add(name);
    assert.match(name, /^\d{2} · .+/);
    const rationale = document.getElementById(choice.getAttribute('aria-describedby')).textContent;
    assert.ok(rationale.length > 30 && rationale.length < 180);
    const svg = card.querySelector('.candidate-stage svg');
    assert.equal(svg.getAttribute('role'), 'img');
    assert.ok(svg.getAttribute('aria-label').length > 10);
    assert.equal(svg.getAttribute('viewBox'), '0 0 48 48');
    artwork.add(svg.querySelector('g').innerHTML.trim());
    assert.ok(svg.querySelector('path, rect, circle'));
    const sizes = [...card.querySelectorAll('.candidate-sizes svg')];
    assert.deepEqual(sizes.map(sample => sample.getAttribute('width')), ['16', '24', '32']);
    for (const sample of sizes) assert.equal(sample.querySelector('g').innerHTML, svg.querySelector('g').innerHTML);
  }
  assert.equal(names.size, 10);
  assert.equal(artwork.size, 10);
  const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
  assert.equal(ids.length, new Set(ids).size, 'all accessible and SVG references have unique targets');
});

test('selection highlights exactly one proposal, announces its name, previews it, and clears', async t => {
  const { document, choices } = await board(t);
  const status = document.getElementById('selection-status');
  const preview = document.getElementById('chosen-preview');
  const clear = document.getElementById('clear-choice');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(document.querySelectorAll('input:checked').length, 0);
  assert.equal(preview.hasAttribute('hidden'), true);
  assert.equal(clear.disabled, true);
  for (const choice of choices) {
    choice.closest('label').click();
    assert.equal(document.querySelectorAll('input:checked').length, 1);
    assert.equal(choice.checked, true);
    const selectedLabels = [...document.querySelectorAll('.candidate-state')].filter(label => label.textContent === 'Selected ✓');
    assert.equal(selectedLabels.length, 1);
    assert.equal(selectedLabels[0].closest('label'), choice.closest('label'));
    assert.equal(preview.hasAttribute('hidden'), false);
    const source = document.getElementById(`mark-${choice.value}`);
    assert.equal(preview.querySelector('g').innerHTML, source.innerHTML);
    assert.equal(preview.querySelectorAll('[id], use').length, 0, 'preview has no duplicate IDs or dynamic file references');
    assert.equal(status.textContent, `Selected for this visit: ${document.getElementById(choice.getAttribute('aria-labelledby')).textContent}`);
    assert.equal(clear.disabled, false);
  }
  clear.click();
  assert.equal(document.querySelectorAll('input:checked').length, 0);
  assert.match(status.textContent, /No icon selected/);
  assert.equal(preview.hasAttribute('hidden'), true);
  assert.equal(preview.children.length, 0);
  assert.equal(clear.disabled, true);
  assert.equal(document.activeElement, choices[0], 'clearing does not leave focus on a disabled button');
});

test('a new visit and browser-restored page forget the temporary choice without using storage', async t => {
  const first = await board(t);
  first.choices[4].click();
  assert.equal(first.choices[4].checked, true);
  const reloaded = await board(t);
  assert.equal(reloaded.document.querySelectorAll('input:checked').length, 0);
  assert.match(reloaded.document.getElementById('selection-status').textContent, /No icon selected/);
  first.window.dispatchEvent(new first.window.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(first.document.querySelectorAll('input:checked').length, 0);
  assert.equal(first.document.getElementById('chosen-preview').hasAttribute('hidden'), true);
});

test('proposal file is self-contained, network-disabled, and not connected to the application', async t => {
  const { document } = await board(t);
  assert.equal(document.querySelectorAll('link, script[src], img, iframe, object, embed, form, a').length, 0);
  assert.equal(document.querySelectorAll('script').length, 1);
  assert.equal(document.querySelectorAll('style').length, 1);
  // Even same-file SVG <use> references can trigger file-origin errors in Chrome.
  assert.equal(document.querySelectorAll('[href], [src], use').length, 0);
  assert.equal(document.querySelectorAll('svg script, svg image, svg foreignObject, svg animate').length, 0);
  for (const element of document.querySelectorAll('*')) {
    for (const attr of element.attributes) assert.doesNotMatch(attr.name, /^on/i);
  }
  const css = document.querySelector('style').textContent;
  assert.doesNotMatch(css, /@import|url\(/i);
  assert.match(css, /:has\(input:checked\)/);
  assert.match(css, /:has\(input:focus-visible\)/);
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(document.querySelector('noscript').textContent, /Nothing is saved/);
  assert.doesNotMatch(readFileSync('public/index.html', 'utf8'), /proposals\/icons|icon-choice/);
  assert.doesNotMatch(readFileSync('src/server.js', 'utf8'), /proposals\/icons|icon-choice/);
});
