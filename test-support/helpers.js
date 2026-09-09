import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
export function temporaryDb(t) {
  // All test writes stay inside the worktree, not the primary checkout or /tmp.
  mkdirSync('.data/test', { recursive: true });
  const directory = mkdtempSync(resolve('.data/test/run-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'test.sqlite');
}
export function questionInput(doc, changes = {}) {
  const block = doc.blocks.find(b => b.kind === 'paragraph');
  return { revision_id: doc.id, block_id: block.id, quote: 'Exact context.',
    question: 'Why?', client_key: 'client-one', ...changes };
}
