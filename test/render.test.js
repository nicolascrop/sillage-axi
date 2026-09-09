import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderReport, safeHtml } from '../src/render.js';

const sample = `# Report

A **bold** passage with &amp; an entity.

- First
- Second

> A quotation.

\`\`\`js
const x = '<script>alert(1)</script>';
\`\`\`

| Name | Value |
| --- | --- |
| A | 10 |

\`\`\`excalidraw
{"type":"excalidraw","elements":[]}
\`\`\`
`;

test('established renderer emits semantic passages, unique owned anchors, and a TOC', () => {
  const rendered = renderReport(sample);
  const doc = new JSDOM(rendered.html).window.document;
  for (const kind of ['heading', 'paragraph', 'list_item', 'blockquote', 'code', 'table']) {
    assert.ok(rendered.blocks.some(b => b.kind === kind), kind);
  }
  assert.equal(doc.querySelectorAll('[data-block-id]').length, rendered.blocks.length);
  for (const b of rendered.blocks) {
    assert.equal(doc.querySelectorAll(`#b-${b.id}`).length, 1);
    assert.equal(doc.getElementById(`b-${b.id}`).dataset.blockId, b.id);
    assert.ok(b.start_line <= b.end_line);
  }
  assert.equal(doc.querySelector('strong').textContent, 'bold');
  assert.equal(rendered.toc[0].text, 'Report');
  assert.equal(rendered.toc[0].id, rendered.blocks[0].id);
  assert.match(doc.querySelector('[data-diagram]').textContent, /Unsupported diagram.*Excalidraw/s);
  assert.match(doc.querySelector('[data-diagram] code').textContent, /"elements":\[\]/);
});

test('reports, raw HTML, URLs, image trackers and diagram payloads cannot execute or auto-fetch', () => {
  const html = renderReport(`# <img src=x onerror=alert(1)>

<script>alert(1)</script>

[bad](javascript:alert(1)) [relative](file:///etc/passwd) [ok](https://example.test)

![tracker](https://tracker.test/pixel.png)

\`\`\`excalidraw
</code><script>alert(2)</script><img src=x>
\`\`\`
`).html;
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelectorAll('script,img,iframe,svg,object').length, 0);
  assert.equal(doc.querySelectorAll('[onerror],[onclick]').length, 0);
  assert.equal(doc.querySelectorAll('a').length, 1); // markdown-it refuses both javascript: and file: links
  assert.equal(doc.querySelector('a[href]').href, 'https://example.test/');
  assert.match(doc.body.textContent, /<script>alert\(1\)<\/script>/);
  assert.equal(safeHtml('<script>x</script><img src=x><a href="javascript:alert(1)" onclick="x">x</a>'), '<a rel="noreferrer noopener">x</a>');
});

test('exact unique passages keep IDs through insertion and line shifts, not source positions', () => {
  const old = renderReport('# Heading\n\nKeep **this**.\n\nOther.');
  const next = renderReport('# Heading\n\nNew paragraph.\n\nKeep **this**.\n\nOther.', old.blocks);
  const kept = old.blocks.find(b => b.source === 'Keep **this**.');
  assert.equal(next.blocks.find(b => b.source === kept.source).id, kept.id);
  assert.notEqual(next.blocks.find(b => b.id === kept.id).start_line, kept.start_line);
  assert.deepEqual(renderReport(sample, renderReport(sample).blocks).blocks.map(b => b.fingerprint), renderReport(sample).blocks.map(b => b.fingerprint));
});

for (const [name, oldSource, newSource, passage] of [
  ['changed', '# H\n\nAlpha beta.', '# H\n\nAlpha changed.', 'Alpha beta.'],
  ['deleted', '# H\n\nAlpha beta.', '# H\n\nDifferent.', 'Alpha beta.'],
  ['split', '# H\n\nAlpha beta.', '# H\n\nAlpha\n\nbeta.', 'Alpha beta.'],
  ['merged', '# H\n\nAlpha\n\nbeta.', '# H\n\nAlpha beta.', 'Alpha'],
  ['new ambiguity', '# H\n\nSame.', '# H\n\nSame.\n\nSame.', 'Same.'],
  ['old ambiguity', '# H\n\nSame.\n\nSame.', '# H\n\nSame.', 'Same.'],
  ['container changed', '# H\n\n> Keep.\n>\n> Other.', '# H\n\n> Keep.\n>\n> Changed.', '> Keep.'],
  ['section moved', '# A\n\nKeep.\n\n# B', '# A\n\n# B\n\nKeep.', 'Keep.'],
  ['reference destination changed', '# H\n\n[link][x]\n\n[x]: https://one.test', '# H\n\n[link][x]\n\n[x]: https://two.test', '[link][x]'],
]) {
  test(`${name} does not inherit an old passage identity`, () => {
    const old = renderReport(oldSource);
    const next = renderReport(newSource, old.blocks);
    const block = old.blocks.find(b => b.source === passage);
    assert.ok(block, passage);
    assert.ok(!next.blocks.some(b => b.id === block.id));
  });
}

test('deleted and later reappearing passage is not resurrected onto its old thread', () => {
  const a = renderReport('# H\n\nKeep.');
  const b = renderReport('# H\n\nGone.', a.blocks);
  const c = renderReport('# H\n\nKeep.', b.blocks);
  assert.notEqual(a.blocks[1].id, c.blocks[1].id);
});
