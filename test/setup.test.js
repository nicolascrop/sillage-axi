import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { decode } from '@toon-format/toon';
import { setup } from '../src/setup.js';
import { createApp } from '../src/server.js';
import { temporaryDb, questionInput } from '../test-support/helpers.js';
const exec = promisify(execFile);
const executable = resolve('bin/sillage.js');
const options = scope => ({ scope, origin: 'http://127.0.0.1:1', executable });

test('all integrations: explicit scoped install, idempotence, third-party preservation, removal and path repair', async t => {
  const scope = dirname(temporaryDb(t));
  const home = join(scope, 'home'); mkdirSync(home);
  const thirdParty = { hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo third-party' }] }], Stop: [{ hooks: [{ command: 'keep-stop' }] }] }, custom: 'keep' };
  for (const app of ['claude', 'codex', 'opencode']) {
    const target = join(scope, app === 'claude' ? '.claude/settings.json' : app === 'codex' ? '.codex/hooks.json' : '.opencode/plugins/sillage-context.js');
    mkdirSync(dirname(target), { recursive: true });
    if (app !== 'opencode') writeFileSync(target, JSON.stringify(thirdParty));
    const first = await setup({ ...options(scope), app });
    assert.equal(first.setup, 'installed');
    const bytes = readFileSync(target, 'utf8');
    assert.equal((await setup({ ...options(scope), app })).setup, 'unchanged');
    assert.equal(readFileSync(target, 'utf8'), bytes);
    assert.match(bytes, /context/); assert.match(bytes, /--scope/);
    if (app !== 'opencode') {
      const config = JSON.parse(bytes); assert.deepEqual(config.hooks.Stop, thirdParty.hooks.Stop);
      assert.equal(config.hooks.SessionStart.length, 2); assert.equal(config.custom, 'keep');
    }
    const relocated = join(scope, 'relocated sillage.js');
    writeFileSync(relocated, '// relocation target for installer test');
    await setup({ ...options(scope), app, executable: relocated });
    assert.ok(readFileSync(target, 'utf8').includes('relocated sillage.js'));
    await setup({ ...options(scope), app, remove: true });
    assert.equal((await setup({ ...options(scope), app, remove: true })).setup, 'unchanged');
    if (app === 'opencode') assert.equal(existsSync(target), false);
    else assert.deepEqual(JSON.parse(readFileSync(target)), thirdParty);
  }
  assert.equal(existsSync(join(home, '.codex')), false);
});

test('invalid or unmanaged config and symlinks refuse before changing files', async t => {
  const scope = dirname(temporaryDb(t));
  const dir = join(scope, '.claude'); mkdirSync(dir);
  const path = join(dir, 'settings.json');
  for (const invalid of ['{bad json', '[]', '{"hooks":[]}', '{"hooks":{"SessionStart":[{}]}}']) {
    writeFileSync(path, invalid);
    await assert.rejects(setup({ ...options(scope), app: 'claude' }));
    assert.equal(readFileSync(path, 'utf8'), invalid);
    assert.equal(existsSync(join(scope, '.sillage/config.json')), false);
  }
  const plugin = join(scope, '.opencode/plugins/sillage-context.js'); mkdirSync(dirname(plugin), { recursive: true }); writeFileSync(plugin, '// not managed');
  await assert.rejects(setup({ ...options(scope), app: 'opencode' }), /unmanaged/);
  assert.equal(readFileSync(plugin, 'utf8'), '// not managed');
  const other = join(scope, 'elsewhere'); mkdirSync(other); symlinkSync(other, join(scope, '.codex'));
  await assert.rejects(setup({ ...options(scope), app: 'codex' }), /symlink/);
  assert.equal(existsSync(join(other, 'hooks.json')), false);
});

test('hooks disclose availability only, are directory-scoped, and do not consume or capture reader data', async t => {
  const path = temporaryDb(t); const scope = dirname(path);
  const app = createApp({ dbPath: path, scopeRoot: scope });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const doc = app.store.importReport({ title: 'SECRET TITLE', source: '# SECRET REPORT\n\nExact context.' });
  const thread = app.store.question(questionInput(doc, { question: 'SECRET QUESTION' }));
  for (const harness of ['claude', 'codex']) {
    const result = await exec(process.execPath, [executable, 'setup', '--app', harness, '--local-only', '--url', origin], { cwd: scope, env: { ...process.env, HOME: scope } });
    assert.equal(decode(result.stdout).setup, 'installed');
    const config = JSON.parse(readFileSync(join(scope, harness === 'claude' ? '.claude/settings.json' : '.codex/hooks.json')));
    const command = config.hooks.SessionStart[0].hooks[0].command;
    const context = await exec('/bin/sh', ['-c', command], { cwd: scope });
    assert.equal(decode(context.stdout).service, 'available');
    assert.doesNotMatch(context.stdout, /SECRET|Exact context|revision_id|thread_id|worker|waiting/);
    const other = join(scope, `other-${harness}`); mkdirSync(other);
    const outside = await exec('/bin/sh', ['-c', command], { cwd: other });
    assert.equal(decode(outside.stdout).service, 'out_of_scope');
  }
  await setup({ scope, origin, executable, app: 'opencode' });
  const plugin = await import(pathToFileURL(join(scope, '.opencode/plugins/sillage-context.js')));
  const hooks = await plugin.default(); const output = { system: [] };
  // This test runs outside the selected scope: even plugin injection has no private data.
  await hooks['experimental.chat.system.transform']({}, output);
  assert.equal(decode(output.system[0]).service, 'out_of_scope');
  assert.equal(app.store.thread(thread.id).attempts, 0);
  assert.equal(existsSync(join(scope, '.codex/config.toml')), false);
});

test('PATH uses the verified executable only; collisions fall back to an absolute Node command', async t => {
  const scope = dirname(temporaryDb(t));
  const bins = join(scope, 'bins'); mkdirSync(bins);
  const collision = join(bins, 'sillage'); writeFileSync(collision, '#!/bin/sh\nexit 99', { mode: 0o755 });
  const args = [executable, 'setup', '--app', 'claude', '--local-only', '--url', 'http://127.0.0.1:1'];
  await exec(process.execPath, args, { cwd: scope, env: { ...process.env, PATH: bins, HOME: scope } });
  const command = () => JSON.parse(readFileSync(join(scope, '.claude/settings.json'))).hooks.SessionStart[0].hooks[0].command;
  assert.ok(command().startsWith(`'${process.execPath}'`));
  const verified = join(scope, 'verified'); mkdirSync(verified); symlinkSync(executable, join(verified, 'sillage'));
  await exec(process.execPath, args, { cwd: scope, env: { ...process.env, PATH: `${verified}:${dirname(process.execPath)}`, HOME: scope } });
  assert.ok(command().startsWith("'sillage' 'context'"));
});
