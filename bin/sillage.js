#!/usr/bin/env node
import { version } from '../src/entry.js';
const args = process.argv.slice(2);
if (args.length === 1 && ['--version', '-v', '-V'].includes(args[0])) {
  console.log(version);
} else {
  const { main } = await import('../src/cli.js');
  await main(args);
}
