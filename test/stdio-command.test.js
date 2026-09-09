import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import MarkdownIt from 'markdown-it';

const command = 'node src/local-agent.js';
const nondefaultCommand = `SILLAGE_URL=http://127.0.0.1:3211 ${command}`;
const markdown = new MarkdownIt();

// Keep all public machine-attachment instructions aligned with the direct Node
// subprocess exercised in relay.test.js. npm's normal script banner is not JSONL.
for (const path of ['README.md', 'docs/local-agent.md', 'docs/agent-protocol.md', 'skills/sillage/SKILL.md']) {
  test(`${path} advertises the direct Node stdio command, not the npm wrapper`, () => {
    const source = readFileSync(path, 'utf8');
    const tokens = markdown.parse(source, {});
    const code = tokens.flatMap(token => token.type === 'fence' ? [token.content.trim()]
      : (token.children || []).filter(child => child.type === 'code_inline').map(child => child.content));
    assert.ok(code.some(value => value.split('\n').includes(command)), 'missing direct attachment command');
    assert.doesNotMatch(source, /npm\s+run\s+local-agent/, 'do not advertise banner-producing npm attachment');
    if (path === 'README.md' || path === 'docs/local-agent.md') {
      assert.ok(code.some(value => value.split('\n').includes(nondefaultCommand)), 'missing loopback port override');
    }
  });
}
