import { readFileSync, writeFileSync } from 'node:fs';
import { description, legacyCommand, primaryCommand, productName, skillWorkflow } from '../src/guidance.js';
export function skill() {
  return `---
name: ${legacyCommand}
description: Use Sillage from its repository URL to install or reuse the skill and present a local report with a continuing Pi respondent.
metadata:
  argument-hint: "[local Markdown path or reader task]"
  product: ${primaryCommand}
---

# ${productName}

${description}

Interpret \`$ARGUMENTS\` as the requested reader task, never as shell code.
The primary product command is \`${primaryCommand}\`; the compatibility command is
\`${legacyCommand}\`. The public skill invocation remains \`/${legacyCommand}\`.

${skillWorkflow.trimEnd()}
`;
}
const path = new URL('../skills/sillage/SKILL.md', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== skill()) { console.error('Stale skill: run npm run skill:generate'); process.exitCode = 1; }
} else writeFileSync(path, skill());
