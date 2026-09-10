import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { output, failure, version } from './entry.js';
import { parse, Usage } from './arguments.js';
import { description, discovery, helpFor, primaryCommand } from './guidance.js';
import { localUrl } from './agent-client.js';
import { isTruncated } from './inspection.js';

// Keep the exported path stable for direct ESM consumers; CLI invocations use their
// actual path so setup can repair either the new command or the old alias.
export const executable = fileURLToPath(new URL('../bin/sillage.js', import.meta.url));
const primaryExecutable = fileURLToPath(new URL('../bin/sillage-axi.js', import.meta.url));
export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function invocation() {
  const candidate = process.argv[1] ? resolve(process.argv[1]) : null;
  if (!candidate) return { executable, command: primaryCommand };
  let actual;
  try { actual = realpathSync(candidate); } catch { return { executable, command: primaryCommand }; }
  if (![executable, primaryExecutable].some(path => {
    try { return realpathSync(path) === actual; } catch { return false; }
  })) return { executable, command: primaryCommand };
  const directLegacy = basename(candidate) === 'sillage.js';
  return { executable: candidate, command: directLegacy ? `node ${shellQuote(candidate)}` : primaryCommand };
}
function usageFor(usage, command) {
  return usage.startsWith(primaryCommand) ? `${command}${usage.slice(primaryCommand.length)}` : usage;
}
function helpForInvocation(name, command) {
  const help = helpFor(name);
  if (command === primaryCommand) return help;
  return { ...help, usage: help.usage.replaceAll(primaryCommand, command), examples: help.examples.map(example => example.replaceAll(primaryCommand, command)) };
}
function connection(options, command = primaryCommand) {
  let scope;
  try { scope = realpathSync(resolve(options.scope || process.cwd())); }
  catch { throw new Usage('--scope must name an existing local directory'); }
  if (!statSync(scope).isDirectory()) throw new Usage('--scope must name a directory');
  let config = {};
  if (!options.url && !process.env.SILLAGE_URL) {
    try { config = JSON.parse(readFileSync(resolve(scope, '.sillage/config.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Usage(`Invalid scoped configuration; repair with ${command} setup --app <app> --local-only --url <loopback-origin>`); }
  }
  let origin;
  try { origin = localUrl(options.url || process.env.SILLAGE_URL || config.url || 'http://127.0.0.1:3210'); }
  catch { throw new Usage('--url / SILLAGE_URL must be an http://127.0.0.1:PORT or http://localhost:PORT origin'); }
  return { scope, origin };
}
async function request(origin, path, body, method = 'POST', scope) {
  let response;
  try {
    response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : method, redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1', ...(scope ? { 'X-Sillage-Scope': encodeURIComponent(scope) } : {}) }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { throw Object.assign(new Error(body === undefined ? 'Local service unavailable; start or reconnect the selected service.' : 'Local service unavailable; no write acknowledgement received. Reuse the same operation key for an import/question retry.'), { kind: 'unavailable' }); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Local service returned an invalid response; check the URL and Sillage AXI version.'); }
  if (data.service === 'out_of_scope') throw Object.assign(new Error('Service belongs to another directory; select its directory explicitly with --scope.'), { kind: 'out_of_scope' });
  if (!response.ok) throw new Error(response.status === 409 ? 'Operation conflicts with saved state. Inspect the current revision/thread; do not change a retry payload under its key.'
    : response.status === 404 ? 'Exact item or inspection endpoint not found; check the ID, revision and running Sillage AXI version.'
      : `Local request rejected (${response.status}); check the command parameters and service version.`);
  return data;
}
const inspectionPath = (scope, view, options = {}, id) => `/api/inspect?${new URLSearchParams({ scope, view,
  ...Object.fromEntries(Object.entries(options).filter(([key]) => ['revision', 'fields', 'limit', 'offset', 'full'].includes(key)).map(([k, v]) => [k, String(v)])), ...(id ? { id } : {}) })}`;
export async function main(argv) {
  const current = invocation();
  let command = 'home'; let next = `${current.command} --help`;
  try {
    const parsed = parse(argv);
    if (parsed.help) return output(helpForInvocation(parsed.help, current.command));
    if (parsed.version) { console.log(version); return; }
    const { name, options, args } = parsed; command = name;
    next = usageFor(helpFor(name).usage, current.command);
    if (name === 'agent-help') return output({ protocol: readFileSync(new URL('../docs/agent-protocol.md', import.meta.url), 'utf8'), lifecycle: readFileSync(new URL('../docs/local-agent.md', import.meta.url), 'utf8') });
    const { scope, origin } = connection(options, current.command);
    const write = (path, body, method = 'POST') => request(origin, path, body, method, scope);
    const suffix = ` --scope ${shellQuote(scope)} --url ${shellQuote(origin)}`;
    const hint = text => `${usageFor(text, current.command)}${suffix}`;
    next = hint(helpFor(name).usage);
    if (name === 'setup') {
      const { setup } = await import('./setup.js');
      return output(await setup({ ...options, scope, origin, executable: current.executable }));
    }
    if (name === 'serve') {
      if (options.url) throw new Usage(`serve uses SILLAGE_PORT, not --url; for example SILLAGE_PORT=3211 ${current.command} serve`);
      process.chdir(scope);
      const { serve } = await import('./server.js');
      return serve();
    }
    if (name === 'context' && realpathSync(process.cwd()) !== scope) return output({ service: 'out_of_scope', privacy: 'No reader content disclosed.' });
    if (['home', 'context', 'document', 'blocks', 'block', 'threads', 'thread'].includes(name)) {
      let data;
      try { data = await request(origin, inspectionPath(scope, name, options, args[0])); }
      catch (error) {
        if (!['home', 'context'].includes(name) || !error.kind) throw error;
        data = { service: error.kind };
      }
      const help = [];
      if (name === 'home') {
        if (data.service === 'unavailable') help.push(`${current.command} serve --scope ${shellQuote(scope)} (set SILLAGE_PORT to match ${origin}; no service was started)`);
        else if (data.service === 'out_of_scope') help.push(`${current.command} --scope <service-directory> --url <loopback-origin>`);
        else if (!data.document) help.push(hint(commandsImportExample()));
        else help.push(...discovery.slice(0, 2).map(hint));
        const displayExecutable = current.executable;
        data = { bin: displayExecutable.startsWith(`${homedir()}/`) ? `~${displayExecutable.slice(homedir().length)}` : displayExecutable, description, ...data };
      } else if (name === 'context') {
        help.push(`Only a separately authorized local-only reasoner may invoke ${current.command} to inspect reader content.`);
      } else if (name === 'blocks' || name === 'threads') {
        if (data.total) help.push(hint(name === 'blocks' ? `${primaryCommand} block <id> --revision ${data.revision_id}` : `${primaryCommand} thread <id>`));
        else if (name === 'blocks' && data.current_revision_id !== undefined) help.push(hint(commandsImportExample(data.current_revision_id)));
        else if (name === 'blocks' && data.revision_id === null) help.push(hint(commandsImportExample()));
        else if (data.revision_id === null) help.push(hint(commandsImportExample()));
        else help.push(hint(`${primaryCommand} blocks --revision ${data.revision_id}`));
        if (data.offset + data.shown < data.total) help.push(hint(`${primaryCommand} ${name}${name === 'blocks' ? ` --revision ${data.revision_id}` : ''} --offset ${data.offset + data.shown} --limit ${options.limit || 100}${options.fields ? ` --fields ${options.fields.join(',')}` : ''}`));
      }
      if (isTruncated(data)) help.push(hint(`${primaryCommand} ${name}${args[0] ? ` ${args[0]}` : ''}${name === 'document' ? ` --revision ${data.document.id}` : options.revision ? ` --revision ${options.revision}` : ''} --full`));
      return output({ ...data, ...(help.length ? { help } : {}) });
    }
    // Every mutation checks scope before reading a report file or consuming work.
    await request(origin, inspectionPath(scope, 'context'));
    if (name === 'attach') {
      const { runLocalAgent } = await import('./local-agent.js');
      return await runLocalAgent({ base: origin, scope }); // Explicit JSONL, not an AXI observation.
    }
    if (name === 'demo') {
      const { runFakeAgent } = await import('./fake-agent.js');
      return output(await runFakeAgent(origin, { scope }));
    }
    if (name === 'import') {
      if (statSync(options.file).size > 2_000_000) throw new Usage('--file exceeds 2 MB');
      const source = readFileSync(options.file, 'utf8');
      if (!source.trim() || source.length > 1_000_000 || source.split('\n').length > 20_000) throw new Usage('--file must contain nonempty Markdown within 1,000,000 characters and 20,000 lines');
      const doc = await write('/api/document', { title: options.title, source, operation_key: options.key, expected_revision_id: options.expected });
      return output({ revision_id: doc.id, operation_key: options.key, help: [hint(`${primaryCommand} document --revision ${doc.id}`)] });
    }
    if (name === 'question') {
      const thread = await write('/api/questions', { revision_id: options.revision, block_id: options.block, quote: options.quote, question: options.text, client_key: options.key });
      return output({ thread_id: thread.id, status: thread.request_status, help: [hint(`${primaryCommand} thread ${thread.id}`)] });
    }
    if (name === 'close') {
      const thread = await write(`/api/threads/${args[0]}`, { closed: true }, 'PATCH');
      return output({ thread_id: thread.id, closed: Boolean(thread.closed) });
    }
  } catch (error) {
    await failure(error instanceof Usage ? 'usage' : 'runtime', error instanceof Usage || !error.code ? error.message : 'Local operation failed; check file permissions and service configuration.', [next, ...(command === 'home' ? [] : [`${current.command} --help`])]);
  }
}
function commandsImportExample(expected = null) {
  return `${primaryCommand} import --file <path> --title <title> --key <operation-key> --expected ${expected === null ? 'null' : expected}`;
}
