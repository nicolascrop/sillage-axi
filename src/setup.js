import { existsSync, readFileSync, realpathSync, lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, delimiter, relative, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const marker = 'sillage-managed-context-v1';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function portable(executable) {
  const names = basename(executable) === 'sillage.js' ? ['sillage', 'sillage-axi'] : ['sillage-axi', 'sillage'];
  for (const directory of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      try {
        if (realpathSync(join(directory, name)) === realpathSync(executable)) return { file: name, args: [] };
      } catch { /* Not this executable; use the pinned absolute fallback. */ }
    }
  }
  return { file: process.execPath, args: [executable] };
}
function safePath(root, path) {
  let part = root;
  for (const name of relative(root, path).split('/')) {
    part = join(part, name);
    let stat;
    try { stat = lstatSync(part); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Refusing a symlink in managed project configuration; select a real project directory.');
  }
}
function jsonFile(path) {
  if (!existsSync(path)) return {};
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Invalid JSON configuration; repair the selected project file before setup. No files changed.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a configuration object; no files changed.');
  return data;
}
function updateJson(current, command, remove) {
  if (current.hooks !== undefined && (!current.hooks || typeof current.hooks !== 'object' || Array.isArray(current.hooks))) throw new Error('Invalid hooks object; no files changed.');
  const hooks = { ...current.hooks };
  const groups = hooks.SessionStart ?? [];
  if (!Array.isArray(groups) || groups.some(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks) || group.hooks.some(h => !h || typeof h !== 'object'))) throw new Error('Invalid SessionStart hooks; no files changed.');
  const updated = groups.flatMap(group => {
    const remaining = group.hooks.filter(hook => !(typeof hook.command === 'string' && hook.command.endsWith(` # ${marker}`)));
    return remaining.length === group.hooks.length ? [group] : remaining.length ? [{ ...group, hooks: remaining }] : [];
  });
  if (!remove) updated.push({ matcher: '', hooks: [{ type: 'command', command: `${command} # ${marker}`, timeout: 10 }] });
  if (updated.length) hooks.SessionStart = updated;
  else delete hooks.SessionStart;
  const next = { ...current };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return `${JSON.stringify(next, null, 2)}\n`;
}
function pluginSource(file, args) {
  return `// ${marker}\nimport { execFile } from 'node:child_process';\nexport default async () => ({\n  'experimental.chat.system.transform': async (_input, output) => {\n    const text = await new Promise(resolve => execFile(${JSON.stringify(file)}, ${JSON.stringify(args)}, { timeout: 10000, maxBuffer: 8192 }, (error, stdout) => resolve(error ? '' : stdout)));\n    if (text) output.system.push(text);\n  },\n});\n`;
}
function commit(path, content) {
  if (content === null) { if (existsSync(path)) unlinkSync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
export async function setup({ app, scope, origin, executable, remove = false }) {
  const target = resolve(scope, app === 'claude' ? '.claude/settings.json' : app === 'codex' ? '.codex/hooks.json' : '.opencode/plugins/sillage-context.js');
  const configPath = resolve(scope, '.sillage/config.json');
  for (const path of [target, configPath]) safePath(scope, path);
  const config = jsonFile(configPath);
  if (Object.keys(config).length && config.managed !== marker) throw new Error('Refusing unmanaged .sillage/config.json; no files changed.');
  const invocation = portable(executable);
  const args = [...invocation.args, 'context', '--scope', scope, '--url', origin];
  let content;
  if (app === 'opencode') {
    if (existsSync(target) && !readFileSync(target, 'utf8').startsWith(`// ${marker}\n`)) throw new Error('Refusing unmanaged OpenCode plugin; no files changed.');
    content = remove ? null : pluginSource(invocation.file, args);
  } else {
    const current = jsonFile(target);
    content = remove && !existsSync(target) ? null : updateJson(current, [invocation.file, ...args].map(quote).join(' '), remove);
  }
  // Preflight all configuration before writes; each replacement is atomic.
  // No user-home config, executable download, model launch or transcript capture.
  const changes = [[target, content]];
  if (!remove) changes.push([configPath, `${JSON.stringify({ managed: marker, url: origin }, null, 2)}\n`]);
  const changed = changes.filter(([path, next]) => (existsSync(path) ? readFileSync(path, 'utf8') : null) !== next);
  for (const [path, next] of changed) commit(path, next);
  return { setup: changed.length ? (remove ? 'removed' : 'installed') : 'unchanged', app, scope, privacy: 'Availability only; no report content or transcript capture.',
    ...(app === 'codex' && !remove ? { prerequisite: 'Explicitly enable [features].hooks = true in ~/.codex/config.toml for your local-only harness. Setup never edits user-home config.' } : {}) };
}
