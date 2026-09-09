import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { createHash, randomUUID } from 'node:crypto';

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escape = md.utils.escapeHtml;
const semantic = new Map([
  ['heading_open', 'heading'], ['paragraph_open', 'paragraph'],
  ['list_item_open', 'list_item'], ['blockquote_open', 'blockquote'],
  ['table_open', 'table'], ['fence', 'code'], ['code_block', 'code'],
]);

// Reports never fetch images (including tracking pixels). No raw HTML or embeds.
md.renderer.rules.image = (tokens, i) => `[Image omitted: ${escape(tokens[i].content)}]`;
const originalFence = md.renderer.rules.fence;
const originalCode = md.renderer.rules.code_block;
function codeRenderer(original) {
  return (tokens, i, options, env, renderer) => {
    const token = tokens[i];
    const attrs = renderer.renderAttrs(token);
    if (/^excalidraw(?:\s|$)/i.test(token.info.trim())) {
      return `<figure${attrs} data-diagram="excalidraw"><figcaption>Unsupported diagram · Excalidraw (source preserved)</figcaption><pre><code>${escape(token.content)}</code></pre></figure>\n`;
    }
    // markdown-it's fence rule puts token attributes on <code>. Put the app
    // identity on <pre> only; duplicate DOM IDs would make source navigation unsafe.
    const clean = Object.assign(Object.create(Object.getPrototypeOf(token)), token, {
      attrs: token.attrs?.filter(([name]) => !['id', 'data-block-id', 'tabindex'].includes(name)),
    });
    const copy = tokens.slice();
    copy[i] = clean;
    return original(copy, i, options, env, renderer).replace('<pre', `<pre${attrs}`);
  };
}
md.renderer.rules.fence = codeRenderer(originalFence);
md.renderer.rules.code_block = codeRenderer(originalCode);

// Defense in depth: markdown-it disables HTML; sanitize-html is the final boundary.
export function safeHtml(html) {
  return sanitizeHtml(html, {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'em', 'strong',
      's', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'hr', 'br', 'figure', 'figcaption'],
    allowedAttributes: {
      '*': ['id', 'data-block-id', 'tabindex'],
      a: ['href', 'rel'], ol: ['start'], code: ['class'], figure: ['data-diagram'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attrs) => ({ tagName, attribs: {
        // Local file paths and relative report links are not served by this app.
        ...(attrs.href && /^(https?:\/\/|mailto:|#)/i.test(attrs.href) ? { href: attrs.href } : {}),
        rel: 'noreferrer noopener',
      } }),
    },
  });
}

function inlineText(token) {
  if (token.type === 'image') return `[Image omitted: ${token.content}]`;
  if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
  if (token.children) return token.children.map(inlineText).join('');
  return token.nesting === 0 ? token.content : '';
}

/** Token maps, never DOM selectors, own the source coordinates and identities. */
export function renderReport(source, previous = []) {
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const tokens = md.parse(normalized, {});
  // Make tight-list paragraphs addressable too, with valid semantic markup.
  for (const token of tokens) {
    if (token.type.startsWith('paragraph_')) token.hidden = false;
  }
  const blocks = [];
  const stack = [];
  const headings = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.nesting === -1) { stack.pop(); continue; }
    if (token.type === 'heading_open') {
      const level = Number(token.tag.slice(1));
      while (headings.length && headings.at(-1).level >= level) headings.pop();
    }
    if (semantic.has(token.type) && token.map) {
      let end = i + 1;
      if (token.nesting === 1) {
        let depth = 1;
        while (end < tokens.length && depth) depth += tokens[end++].nesting;
      }
      const slice = tokens.slice(i, end);
      const raw = lines.slice(...token.map).join('\n');
      const text = token.nesting === 0 ? token.content.trimEnd() :
        slice.filter(t => t.type === 'inline' || t.type === 'fence' || t.type === 'code_block')
          .map(inlineText).join('\n');
      // Include resolved rendering (e.g. reference-link destinations), section path,
      // and container sources. This deliberately prefers false-unmatched over drift.
      const signature = JSON.stringify({ kind: semantic.get(token.type), source: raw,
        rendered: safeHtml(md.renderer.render(slice, md.options, {})),
        section: headings.map(h => h.source),
        containers: stack.filter(t => t.map).map(t => [t.type, lines.slice(...t.map).join('\n')]),
      });
      blocks.push({ token, kind: semantic.get(token.type), source: raw, text,
        start_line: token.map[0] + 1, end_line: token.map[1],
        fingerprint: createHash('sha256').update(signature).digest('hex'),
        heading_level: token.type === 'heading_open' ? Number(token.tag.slice(1)) : null,
      });
      if (token.type === 'heading_open') headings.push({ level: Number(token.tag.slice(1)), source: raw });
    }
    if (token.nesting === 1) stack.push(token);
  }
  const count = items => {
    const map = new Map();
    for (const b of items) map.set(b.fingerprint, (map.get(b.fingerprint) || 0) + 1);
    return map;
  };
  const oldCounts = count(previous);
  const newCounts = count(blocks);
  const oldByHash = new Map(previous.map(b => [b.fingerprint, b]));
  for (const block of blocks) {
    const unique = oldCounts.get(block.fingerprint) === 1 && newCounts.get(block.fingerprint) === 1;
    block.id = unique ? oldByHash.get(block.fingerprint).id : randomUUID();
    block.token.attrSet('id', `b-${block.id}`);
    block.token.attrSet('data-block-id', block.id);
    block.token.attrSet('tabindex', '0');
  }
  const html = safeHtml(md.renderer.render(tokens, md.options, {}));
  const toc = blocks.filter(b => b.heading_level).map(b => ({
    id: b.id, level: b.heading_level, text: b.text,
  }));
  return { html, toc, blocks: blocks.map(({ token, ...block }) => block) };
}
