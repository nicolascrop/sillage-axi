import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Builtins only: version probes never evaluate SQLite, rendering, or the CLI graph.
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const isEntry = meta => Boolean(process.argv[1]) && meta === pathToFileURL(resolve(process.argv[1])).href;
export async function output(value) {
  const { encode } = await import('@toon-format/toon');
  process.stdout.write(`${encode(value)}\n`);
}
export async function failure(code, message, help) {
  await output({ error: { code, message }, help: Array.isArray(help) ? help : [help] });
  process.exitCode = code === 'usage' ? 2 : 1;
}
export async function legacyGate(meta, command) {
  if (!isEntry(meta)) return false;
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
    console.log(version); return true;
  }
  if (args.includes('--help') || args.includes('-h')) {
    const { helpFor } = await import('./guidance.js');
    const script = `node src/${command === 'serve' ? 'server' : command === 'demo' ? 'fake-agent' : 'local-agent'}.js`;
    await output({ ...helpFor(command), usage: script, flags: ['--help', '-h', '--version', '-v', '-V'],
      defaults: command === 'serve' ? 'SILLAGE_PORT=3210; SILLAGE_DB=.data/sillage.sqlite' : 'SILLAGE_URL=http://127.0.0.1:3210',
      examples: [script, `${script} --help`] }); return true;
  }
  if (args.length) {
    await failure('usage', `Unrecognized argument ${args[0]}`, 'Valid flags: --help, -h, --version, -v, -V. Runtime settings use SILLAGE_* environment variables.');
    return true;
  }
  if (command === 'serve') {
    const port = Number(process.env.SILLAGE_PORT || 3210);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      await failure('usage', 'Invalid SILLAGE_PORT: expected an integer from 1 to 65535', 'SILLAGE_PORT=3210 node src/server.js');
      return true;
    }
  }
  return false;
}
