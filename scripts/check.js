import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
for (const file of ['src', 'bin', 'extensions', 'scripts', 'public', 'test', 'test-support'].flatMap(files).filter(path => path.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const skill = spawnSync(process.execPath, ['scripts/generate-skill.js', '--check'], { stdio: 'inherit' });
process.exitCode = skill.status || 0;
