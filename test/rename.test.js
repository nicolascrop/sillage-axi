import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executable } from '../src/cli.js';

const root = resolve('.');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lockfile = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

test('package identity is renamed additively and lockfile metadata agrees', () => {
  assert.equal(packageJson.name, 'sillage-axi');
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.repository.url, 'git+https://github.com/nicolascrop/sillage-axi.git');
  assert.equal(packageJson.homepage, 'https://github.com/nicolascrop/sillage-axi#readme');
  assert.equal(packageJson.bugs.url, 'https://github.com/nicolascrop/sillage-axi/issues');
  assert.deepEqual(packageJson.bin, { 'sillage-axi': 'bin/sillage-axi.js', sillage: 'bin/sillage.js' });
  assert.equal(lockfile.name, packageJson.name);
  assert.equal(lockfile.packages[''].name, packageJson.name);
  assert.deepEqual(lockfile.packages[''].bin, packageJson.bin);
  assert.equal(packageJson.scripts.start, 'node src/server.js');
  assert.equal(packageJson.scripts['fake-agent'], 'node src/fake-agent.js');
  assert.equal(packageJson.scripts['local-agent'], 'node src/local-agent.js');
  assert.equal(executable, join(root, 'bin/sillage.js'));
});

test('new and historical CLI paths are finite outside the checkout', t => {
  mkdirSync(join(root, '.data/test'), { recursive: true });
  const outside = mkdtempSync(join(root, '.data/test/rename-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const file of ['bin/sillage-axi.js', 'bin/sillage.js']) {
    const entry = join(root, file);
    const version = spawnSync(process.execPath, [entry, '--version'], { cwd: outside, encoding: 'utf8' });
    assert.equal(version.status, 0, `${file} --version: ${version.stderr}`);
    assert.equal(version.stdout, '0.1.0\n');
    const help = spawnSync(process.execPath, [entry, '--help'], { cwd: outside, encoding: 'utf8' });
    assert.equal(help.status, 0, `${file} --help: ${help.stderr}`);
    assert.match(help.stdout, /sillage-axi/);
    assert.equal(existsSync(join(outside, '.data')), false);
    assert.equal(existsSync(join(outside, '.sillage')), false);
  }
});

test('embedded main keeps setup hooks on a Sillage entrypoint', t => {
  mkdirSync(join(root, '.data/test'), { recursive: true });
  const outside = mkdtempSync(join(root, '.data/test/rename-embedded-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const consumer = join(outside, 'consumer.mjs');
  const emptyPath = join(outside, 'empty-bin');
  mkdirSync(emptyPath);
  writeFileSync(consumer, `import { main } from ${JSON.stringify(pathToFileURL(join(root, 'src/cli.js')).href)};
await main(['setup', '--app', 'claude', '--local-only', '--url', 'http://127.0.0.1:1']);
`);
  const result = spawnSync(process.execPath, [consumer], {
    cwd: outside,
    encoding: 'utf8',
    env: { ...process.env, PATH: emptyPath, HOME: outside },
  });
  assert.equal(result.status, 0, result.stderr);
  const command = JSON.parse(readFileSync(join(outside, '.claude/settings.json'))).hooks.SessionStart[0].hooks[0].command;
  assert.equal(command, `'${process.execPath}' '${executable}' 'context' '--scope' '${outside}' '--url' 'http://127.0.0.1:1' # sillage-managed-context-v1`);
});

test('migration documentation and installed skill state the additive mapping once', () => {
  const migration = readFileSync(join(root, 'docs/migration-sillage-axi.md'), 'utf8');
  for (const text of ['sillage-axi', 'sillage', 'bin/sillage.js', 'sillage-agent-v1', 'X-Sillage-Local', '.data/sillage.sqlite', '/sillage']) {
    assert.match(migration, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const skill = readFileSync(join(root, 'skills/sillage/SKILL.md'), 'utf8');
  assert.match(skill, /^name: sillage$/m);
  assert.match(skill, /^  product: sillage-axi$/m);
  assert.match(skill, /The public skill invocation remains `\/sillage`/);
  assert.match(skill, /sillage-axi document/);
  assert.doesNotMatch(skill, /\\n/);
  assert.doesNotMatch(skill, /\.\.\//);
  assert.equal(execFileSync(process.execPath, ['scripts/generate-skill.js', '--check'], { encoding: 'utf8' }), '');
});
