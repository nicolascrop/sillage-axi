import { commands, helpFor } from './guidance.js';
import { listFields } from './inspection.js';
export class Usage extends Error {}
export function required(options, keys) {
  for (const key of keys) if (options[key] === undefined || options[key] === '') throw new Usage(`--${key} is required`);
}
export function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Usage(`--${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}
export function validate(name, options, args = []) {
  const spec = commands[name];
  if (!spec) throw new Usage(`Unknown command ${name}; commands: ${Object.keys(commands).join(', ')}`);
  for (const key of Object.keys(options)) if (!['url', 'scope'].includes(key) && !(key in spec.flags)) {
    throw new Usage(`Unrecognized flag --${key}. Valid flags: ${helpFor(name).flags.join(', ')}`);
  }
  if (args.length !== (spec.args || 0)) throw new Usage(`Expected ${spec.args || 0} positional arguments. ${spec.usage}`);
  for (const [key, type] of Object.entries(spec.flags)) if (key in options && type === 'boolean' && options[key] !== true) throw new Usage(`--${key} takes no value`);
  if ('revision' in options) options.revision = integer(String(options.revision), 'revision');
  if ('limit' in options) options.limit = integer(String(options.limit), 'limit', 1, 100);
  if ('offset' in options) options.offset = integer(String(options.offset), 'offset', 0);
  if ('fields' in options) {
    const fields = String(options.fields).split(',');
    if (new Set(fields).size !== fields.length || fields.some(key => !listFields[name]?.includes(key))) throw new Usage(`--fields must select from ${listFields[name]?.join(',')}`);
    options.fields = fields;
  }
  if (name === 'block') required(options, ['revision']);
  if (name === 'import') {
    required(options, ['file', 'title', 'key', 'expected']);
    options.expected = options.expected === 'null' ? null : integer(String(options.expected), 'expected');
    if (options.title.length > 200 || !options.title.trim()) throw new Usage('--title must contain 1–200 characters');
  }
  if (name === 'question') {
    required(options, ['revision', 'block', 'quote', 'text', 'key']);
    for (const [key, max] of [['block', 100], ['quote', 20_000], ['text', 4000]]) if (!options[key].trim() || options[key].length > max) throw new Usage(`--${key} must contain 1–${max} characters`);
  }
  if ('key' in options && (!options.key.trim() || options.key.length > 100)) throw new Usage('--key must contain 1–100 characters');
  if (args.some(arg => !/^[a-zA-Z0-9_-]{1,100}$/.test(arg))) throw new Usage('Invalid identifier');
  if (name === 'setup') {
    required(options, ['app', 'local-only']);
    if (!['claude', 'codex', 'opencode'].includes(options.app)) throw new Usage('--app must be claude, codex or opencode');
  }
  return { name, options, args };
}
export function parse(argv) {
  const words = [...argv];
  const name = words[0] && !words[0].startsWith('-') ? words.shift() : 'home';
  const spec = commands[name];
  if (words.includes('--help') || words.includes('-h')) return { help: commands[name] ? name : 'home' };
  if (!spec) throw new Usage(`Unknown command ${name}; commands: ${Object.keys(commands).join(', ')}`);
  if (words.length === 1 && ['--version', '-v', '-V'].includes(words[0])) return { version: true };
  const options = {}; const args = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.startsWith('-')) { args.push(word); continue; }
    const [key, ...rest] = word.slice(2).split('=');
    const type = ['url', 'scope'].includes(key) ? 'value' : spec.flags[key];
    if (!word.startsWith('--') || !type) throw new Usage(`Unrecognized flag ${word}. Valid flags: ${helpFor(name).flags.join(', ')}`);
    if (key in options) throw new Usage(`Duplicate flag --${key}`);
    if (type === 'boolean') {
      if (rest.length) throw new Usage(`--${key} takes no value`);
      options[key] = true;
    } else {
      const value = rest.length ? rest.join('=') : words[++i];
      if (value === undefined || value === '' || value.startsWith('--')) throw new Usage(`--${key} needs a value`);
      options[key] = value;
    }
  }
  return validate(name, options, args);
}
