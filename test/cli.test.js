import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { decode } from '@toon-format/toon';
import { createApp } from '../src/server.js';
import { commands } from '../src/guidance.js';
import { preview as textPreview } from '../src/inspection.js';
import { DatabaseSync } from 'node:sqlite';
import { temporaryDb, questionInput } from '../test-support/helpers.js';

const exec = promisify(execFile);
const root = resolve('.');
const bin = join(root, 'bin/sillage.js');
async function run(args = [], { entry = bin, cwd = root, env = {} } = {}) {
  try {
    const result = await exec(process.execPath, [entry, ...args], { cwd, env: { ...process.env, SILLAGE_URL: '', ...env }, timeout: 6000, maxBuffer: 4_000_000 });
    return { ...result, status: 0 };
  } catch (error) { return { stdout: error.stdout, stderr: error.stderr, status: error.code }; }
}
async function service(t) {
  const path = temporaryDb(t); const scope = dirname(path);
  const app = createApp({ dbPath: path, scopeRoot: scope });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, scope, url, cli: args => run(args, { cwd: scope, env: { SILLAGE_URL: url } }) };
}

test('all entrypoints: help/version/unknown input are finite and leave a nonempty queue untouched', async t => {
  const app = await service(t);
  const doc = app.store.importReport({ title: 'Private', source: '# Heading\n\nExact context.' });
  const thread = app.store.question(questionInput(doc));
  for (const file of ['bin/sillage.js', 'bin/sillage-axi.js', 'src/server.js', 'src/fake-agent.js', 'src/local-agent.js']) {
    for (const args of [['--help'], ['-h'], ['--version'], ['-v'], ['-V'], ['--bogus'], ['invented-command'], ['--bogus', '--help'], ['invented-command', '--help']]) {
      const db = join(app.scope, `${file.replaceAll('/', '-')}.sqlite`);
      const result = await run(args, { entry: join(root, file), cwd: app.scope, env: { SILLAGE_URL: app.url, SILLAGE_DB: db, SILLAGE_PORT: 'invalid' } });
      const invalid = args.some(arg => ['--bogus', 'invented-command'].includes(arg));
      assert.equal(result.status, invalid ? 2 : 0, `${file} ${args}: ${result.stderr}`);
      assert.equal(existsSync(db), false);
      assert.equal(app.store.thread(thread.id).request_status, 'waiting');
      assert.equal(app.store.thread(thread.id).attempts, 0);
      if (['--version', '-v', '-V'].includes(args[0])) assert.equal(result.stdout, '0.1.0\n');
      else assert.ok(decode(result.stdout));
      assert.doesNotMatch(result.stderr, /Error:|at .*\.js/);
    }
  }
});

test('every command has help before config/network; scoped unknown flags and missing inputs reject before effects', async t => {
  const scope = dirname(temporaryDb(t));
  for (const name of Object.keys(commands)) {
    for (const flag of ['--help', '--version']) {
      const result = await run([...(name === 'home' ? [] : [name]), flag], { cwd: scope, env: { SILLAGE_URL: 'https://example.invalid' } });
      assert.equal(result.status, 0, `${name} ${flag}`);
      if (flag === '--help') assert.ok(decode(result.stdout).examples.length >= 2);
    }
  }
  for (const args of [['blocks', '--stat', 'closed'], ['thread'], ['threads', 'extra'], ['blocks', '--limit', '0'], ['blocks', '--limit', '2.5'], ['blocks', '--offset', '-1'], ['blocks', '--fields', 'source'], ['blocks', '--fields', 'id,id'], ['document', '--full=false'], ['import', '--file', 'missing'], ['question', '--revision', 'x'], ['setup', '--app', 'claude'], ['document', '--bogus', '--help'], ['invented-command', '--help']]) {
    const result = await run(args, { cwd: scope, env: { SILLAGE_URL: 'https://example.invalid' } });
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(decode(result.stdout).error.code, 'usage');
    assert.doesNotMatch(result.stdout, /https:\/\/example.invalid/);
  }
  assert.equal(existsSync(join(scope, '.sillage')), false);
  assert.equal(existsSync(join(scope, '.data')), false);
});

test('empty inspection hints identify the next executable local command', async t => {
  const app = await service(t);
  const noReportThreads = decode((await app.cli(['threads'])).stdout);
  assert.equal(noReportThreads.revision_id, null);
  assert.ok(noReportThreads.help[0].includes('--expected null'));

  const historicalEmptyRevision = Number(app.store.db.prepare(
    'INSERT INTO revisions(title,source,html,toc,created_at) VALUES(?,?,?,?,?)'
  ).run('Historical empty', '<!-- comment -->', '', '[]', Date.now()).lastInsertRowid);
  const doc = app.store.importReport({ title: 'Report', source: '# Heading\n\nExact context.' });
  const reportThreads = decode((await app.cli(['threads'])).stdout);
  assert.equal(reportThreads.revision_id, doc.id);
  assert.ok(reportThreads.help[0].includes(`node '${bin}' blocks --revision ${doc.id}`));

  const historicalBlocks = decode((await app.cli(['blocks', '--revision', String(historicalEmptyRevision)])).stdout);
  assert.equal(historicalBlocks.revision_id, historicalEmptyRevision);
  assert.equal(historicalBlocks.current_revision_id, doc.id);
  assert.ok(historicalBlocks.help[0].includes(`--expected ${doc.id}`));
  assert.doesNotMatch(historicalBlocks.help[0], new RegExp(`--expected ${historicalEmptyRevision}\\b`));

  const currentEmptyRevision = Number(app.store.db.prepare(
    'INSERT INTO revisions(title,source,html,toc,created_at) VALUES(?,?,?,?,?)'
  ).run('Empty', '<!-- comment -->', '', '[]', Date.now()).lastInsertRowid);
  const emptyBlocks = decode((await app.cli(['blocks'])).stdout);
  assert.equal(emptyBlocks.revision_id, currentEmptyRevision);
  assert.equal(emptyBlocks.current_revision_id, currentEmptyRevision);
  assert.ok(emptyBlocks.help[0].includes(`--expected ${currentEmptyRevision}`));
});

test('home is scoped, content-first and read-only; offline probes never create data', async t => {
  const app = await service(t);
  let home = decode((await app.cli([])).stdout);
  assert.equal(home.document, null); assert.equal(home.threads.total, 0);
  assert.ok(home.help.some(h => h.includes('import')));
  for (const view of ['document', 'blocks', 'threads']) {
    const empty = decode((await app.cli([view])).stdout);
    assert.match(empty.empty, /^0 /);
  }
  const doc = app.store.importReport({ title: 'Secret-title', source: '# Report\n\nExact context.' });
  const thread = app.store.question(questionInput(doc));
  home = decode((await app.cli([])).stdout);
  assert.equal(home.document.title, 'Secret-title'); assert.equal(home.threads.waiting, 1);
  assert.equal(home.bin, bin.replace(process.env.HOME, '~'));
  assert.equal(app.store.thread(thread.id).attempts, 0);
  const other = join(app.scope, 'other'); mkdirSync(other);
  const outside = await run([], { cwd: other, env: { SILLAGE_URL: app.url } });
  assert.equal(outside.status, 0); assert.equal(decode(outside.stdout).service, 'out_of_scope');
  assert.doesNotMatch(outside.stdout, /Secret-title|Exact context/);
  const unavailable = await run(['--url', 'http://127.0.0.1:1'], { cwd: other });
  assert.equal(unavailable.status, 0); assert.equal(decode(unavailable.stdout).service, 'unavailable');
  assert.equal(existsSync(join(other, '.data')), false);
  const selected = await run(['--scope', app.scope, '--url', app.url], { cwd: other });
  assert.equal(decode(selected.stdout).document.id, doc.id);
  const blockedWrite = await fetch(`${app.url}/api/questions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1', 'X-Sillage-Scope': encodeURIComponent(other) }, body: JSON.stringify(questionInput(doc, { client_key: 'wrong-scope' })) });
  assert.equal(blockedWrite.status, 409); assert.equal(app.store.threads().length, 1);
});

test('TOON projections are bounded, exact on --full, paginated and aggregated with contextual hints', async t => {
  const app = await service(t);
  const source = '# "Unicode, 🐈"\n\nExact context.\n\n' + 'é 🐈, "q"\n'.repeat(12000);
  const doc = app.store.importReport({ title: 'Unicode, "q"', source });
  for (let n = 0; n < 105; n++) app.store.question(questionInput(doc, { client_key: `key-${n}` }));
  const detail = await app.cli(['document']); const preview = decode(detail.stdout);
  assert.equal(preview.document.source.characters, source.length);
  assert.equal(preview.document.source.text, source.slice(0, 1000));
  assert.ok(preview.help[0].includes(`--revision ${doc.id} --full`));
  assert.ok(detail.stdout.length < 2500);
  assert.equal(decode((await app.cli(['document', '--revision', String(doc.id), '--full'])).stdout).document.source.text, source);
  const list = decode((await app.cli(['threads'])).stdout);
  assert.equal(list.total, 105); assert.equal(list.shown, 100);
  assert.deepEqual(Object.keys(list.threads[0]), ['id', 'request_status', 'anchor_status', 'closed']);
  assert.equal(list.counts.waiting, 105); assert.ok(list.help.some(h => h.includes('--offset 100')));
  const last = decode((await app.cli(['threads', '--offset', '100', '--fields', 'id,revision_id'])).stdout);
  assert.equal(last.shown, 5); assert.equal(last.total, 105);
  assert.deepEqual(Object.keys(last.threads[0]), ['id', 'revision_id']);
  const thread = list.threads[0];
  for (let n = 0; n < 2; n++) assert.equal((await app.cli(['close', thread.id])).status, 0);
  const revised = app.store.importReport({ title: 'Changed', source: '# Changed\n\nUnrelated.' });
  assert.equal(decode((await app.cli(['threads'])).stdout).counts.needs_review, 105);
  const saved = decode((await app.cli(['thread', thread.id, '--full'])).stdout).thread;
  assert.equal(saved.revision_id, doc.id); assert.equal(saved.closed, 1);
  assert.equal(saved.quote.text, 'Exact context.');
  const small = decode((await app.cli(['document', '--revision', String(revised.id)])).stdout);
  assert.equal(small.help, undefined);
  const blocks = decode((await app.cli(['blocks', '--revision', String(doc.id), '--limit', '1'])).stdout);
  assert.equal(blocks.shown, 1); assert.ok(blocks.help.some(h => h.includes(`--revision ${doc.id} --offset 1`)));
  const block = doc.blocks.find(b => b.kind === 'paragraph');
  assert.equal(decode((await app.cli(['block', block.id, '--revision', String(doc.id), '--full'])).stdout).block.source.text, block.source);
  assert.equal((await app.cli(['block', block.id, '--revision', String(revised.id)])).status, 1);
});

test('finite CLI writes reuse keys; v1 demo remains JSON and the continuous bridge remains JSONL', async t => {
  const app = await service(t);
  writeFileSync(join(app.scope, 'report.md'), '# Heading\n\nExact context.');
  const args = ['import', '--file', 'report.md', '--title', 'Report', '--key', 'import-1', '--expected', 'null'];
  const first = decode((await app.cli(args)).stdout);
  assert.equal(decode((await app.cli(args)).stdout).revision_id, first.revision_id);
  const doc = app.store.current(); const block = doc.blocks.find(b => b.kind === 'paragraph');
  const question = ['question', '--revision', String(doc.id), '--block', block.id, '--quote', 'Exact context.', '--text', 'Why?', '--key', 'q-1'];
  const q = decode((await app.cli(question)).stdout);
  assert.equal(decode((await app.cli(question)).stdout).thread_id, q.thread_id);
  const demo = await run([], { entry: join(root, 'src/fake-agent.js'), env: { SILLAGE_URL: app.url } });
  assert.equal(JSON.parse(demo.stdout).status, 'answered');
  const counts = decode((await app.cli(['threads'])).stdout).counts;
  assert.equal(counts.answered, 1); assert.equal(counts.unread, 1); assert.equal(counts.waiting, 0);
  const bad = await app.cli([...args.slice(0, 4), 'Different', ...args.slice(5)]);
  assert.equal(bad.status, 1);
});

test('explicit CLI attachment retains JSONL readiness and EOF lifecycle', async t => {
  const app = await service(t);
  const child = spawn(process.execPath, [bin, 'attach'], { cwd: app.scope, env: { ...process.env, SILLAGE_URL: app.url }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end();
  const status = await new Promise(resolve => child.on('close', resolve));
  assert.equal(status, 0, stderr);
  assert.deepEqual(stdout.trim().split('\n').map(line => JSON.parse(line).type), ['ready-required', 'stopped']);
});

test('configuration/runtime failures are structured and no raw stack reaches stdout', async t => {
  const scope = dirname(temporaryDb(t));
  for (const entry of ['src/fake-agent.js', 'src/local-agent.js']) {
    const result = await run([], { entry: join(root, entry), cwd: scope, env: { SILLAGE_URL: 'https://example.invalid' } });
    assert.equal(result.status, 1); assert.ok(decode(result.stdout).help.length);
    assert.equal(result.stderr, '');
  }
  const badPort = await run([], { entry: join(root, 'src/server.js'), cwd: scope, env: { SILLAGE_PORT: 'invalid' } });
  assert.equal(badPort.status, 2); assert.ok(decode(badPort.stdout).error);
  assert.equal(existsSync(join(scope, '.data')), false);
  const future = join(scope, 'future.sqlite'); const db = new DatabaseSync(future);
  db.exec('PRAGMA user_version=999'); db.close();
  const incompatible = await run([], { entry: join(root, 'src/server.js'), cwd: scope, env: { SILLAGE_DB: future, SILLAGE_PORT: '3219' } });
  assert.equal(incompatible.status, 1); assert.equal(decode(incompatible.stdout).error.code, 'storage');
  assert.doesNotMatch(incompatible.stderr, /Error:|at .*\.js/);
  const missing = await run(['document', '--url', 'http://127.0.0.1:1'], { cwd: scope });
  assert.equal(missing.status, 1); assert.ok(decode(missing.stdout).help.length);
});

test('fast version stays near the Node floor and does not evaluate business dependencies', () => {
  function median(args) {
    const times = Array.from({ length: 5 }, () => { const start = performance.now(); assert.equal(spawnSync(process.execPath, args).status, 0); return performance.now() - start; });
    return times.sort((a, b) => a - b)[2];
  }
  const floor = median(['-e', 'console.log(1)']);
  for (const entry of ['bin/sillage.js', 'bin/sillage-axi.js', 'src/server.js', 'src/fake-agent.js', 'src/local-agent.js']) {
    assert.ok(median([entry, '--version']) < floor * 6, `${entry} exceeds relative Node floor`);
    const probe = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', env: { ...process.env, NODE_DEBUG: 'esm' } });
    assert.doesNotMatch(probe.stderr, /store\.js|render\.js|cli\.js|node:sqlite|@toon-format/);
  }
});

test('relocated checkout and copied-only skill work without a global binary or registry', async t => {
  const directory = dirname(temporaryDb(t));
  const checkout = join(directory, 'relocated'); mkdirSync(checkout);
  for (const path of ['src', 'bin', 'docs', 'package.json']) cpSync(join(root, path), join(checkout, path), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(checkout, 'node_modules'), 'dir');
  const installed = join(directory, 'installed-skill'); cpSync('skills/sillage', installed, { recursive: true });
  const skill = readFileSync(join(installed, 'SKILL.md'), 'utf8');
  assert.ok(skill.length < 5000); assert.doesNotMatch(skill, /\.\.\//);
  const frontmatter = skill.split('---')[1];
  assert.deepEqual([...frontmatter.matchAll(/^(\S[^:]*):/gm)].map(m => m[1]), ['name', 'description', 'metadata']);
  const result = await run(['agent-help'], { entry: join(checkout, 'bin/sillage.js'), cwd: directory });
  assert.equal(result.status, 0); assert.match(decode(result.stdout).protocol, /sillage-agent-v1/);
  assert.equal(spawnSync(process.execPath, ['scripts/generate-skill.js', '--check']).status, 0);
  cpSync('scripts', join(checkout, 'scripts'), { recursive: true });
  cpSync('skills', join(checkout, 'skills'), { recursive: true });
  writeFileSync(join(checkout, 'skills/sillage/SKILL.md'), `${skill}\nstale\n`);
  assert.equal(spawnSync(process.execPath, ['scripts/generate-skill.js', '--check'], { cwd: checkout }).status, 1);
});

test('thread previews preserve exact Unicode answers and citations via --full', async t => {
  const app = await service(t);
  const doc = app.store.importReport({ title: 'Unicode', source: '# Heading\n\nExact context.' });
  const thread = app.store.question(questionInput(doc));
  const request = app.store.reserve({ worker: 'test-only' });
  const body = 'é, "quoted" 🐈\n'.repeat(300);
  const citations = [{ revision_id: doc.id, block_id: thread.block_id, quote: 'Exact context.' }];
  app.store.answer(request.request_id, { lease_token: request.lease_token, status: 'answered', body, citations });
  const short = decode((await app.cli(['thread', thread.id])).stdout);
  assert.equal(short.thread.messages[1].body.characters, body.length);
  assert.ok(short.help[0].includes('--full'));
  const full = decode((await app.cli(['thread', thread.id, '--full'])).stdout);
  assert.equal(full.thread.messages[1].body.text, body);
  assert.equal(full.thread.messages[1].citations[0].quote.text, citations[0].quote);
  assert.equal(full.help, undefined);
  const split = textPreview(`${'a'.repeat(999)}🐈x`);
  assert.equal(split.text, 'a'.repeat(999)); assert.equal(split.characters, 1002);
  assert.equal(split.truncated, true);
});

test('additive inspection rejects unknown/duplicate parameters and foreign scopes', async t => {
  const app = await service(t);
  for (const query of ['view=threads&url=http://127.0.0.1:1', 'view=blocks&limit=2&limit=3', 'view=block', 'view=document&full=false', 'view=unknown', 'view=threads&fields=body']) {
    const response = await fetch(`${app.url}/api/inspect?scope=${encodeURIComponent(app.scope)}&${query}`);
    assert.equal(response.status, 400, query);
  }
  const response = await fetch(`${app.url}/api/inspect?view=home&scope=other`);
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { service: 'out_of_scope' });
  assert.equal(app.store.revisionId(), null);
});

test('offline local npm installation exposes a real executable outside the checkout', async t => {
  const directory = dirname(temporaryDb(t));
  await exec('npm', ['install', '--prefix', directory, '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', join(directory, 'cache'), root], { timeout: 15_000, env: { ...process.env, HOME: directory } });
  const installed = join(directory, 'node_modules/.bin/sillage');
  const installedPrimary = join(directory, 'node_modules/.bin/sillage-axi');
  for (const command of [installed, installedPrimary]) {
    assert.equal((await exec(command, ['--version'], { cwd: directory })).stdout, '0.1.0\n');
    const result = await exec(command, ['--url', 'http://127.0.0.1:1'], { cwd: directory });
    assert.equal(decode(result.stdout).service, 'unavailable');
  }
  assert.equal(existsSync(join(directory, '.data')), false);
});
