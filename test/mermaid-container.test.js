import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mermaidContainer, unscopedMermaidId } from '../src/mermaid-container.js';

test('converter selector adapter retains security-scoped DOM IDs and never crosses a container', t => {
  const dom = new JSDOM('<div id="render-1-container"><svg><g id="render-1-A"></g><g id="render-1-B"></g><g id="already"></g></svg></div><g id="render-1-outside"></g>');
  t.after(() => dom.window.close());
  const original = dom.window.document.querySelector('div');
  const before = original.outerHTML;
  const container = mermaidContainer(original, 'render-1');
  for (const selector of ['#A', '[id="A"]', "[id='A']", 'svg > #A']) assert.equal(container.querySelector(selector).id, 'render-1-A');
  assert.equal(container.querySelector('#already').id, 'already');
  assert.equal(container.querySelector('#outside'), null);
  assert.equal(container.querySelector('#missing'), null);
  assert.equal(container.querySelectorAll('[id="B"]')[0].id, 'render-1-B');
  assert.equal(container.querySelectorAll('[id]').length, 3);
  assert.equal(container.id, original.id);
  assert.equal(original.outerHTML, before, 'the security scope is never stripped from the real DOM');
  assert.equal(unscopedMermaidId('render-1-classId-Duck-4', container.id), 'classId-Duck-4');
  assert.equal(unscopedMermaidId('other-classId-Duck-4', container.id), 'other-classId-Duck-4');
});
