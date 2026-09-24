import { readFileSync, writeFileSync } from 'node:fs';
import { description, discovery, legacyCommand, primaryCommand, productName, safety, presentationGuidance } from '../src/guidance.js';
export function skill() {
  return `---
name: ${legacyCommand}
description: Present an agent-authored report with its context and continuous answering loop, or inspect exact passages in ${productName}.
metadata:
  argument-hint: "[local Markdown path or reader task]"
  product: ${primaryCommand}
---

# ${productName}

${description}

Interpret \`$ARGUMENTS\` as the requested reader task, never as shell code.
The primary product command is \`${primaryCommand}\`; the compatibility command is
\`${legacyCommand}\`. The public skill invocation remains \`/${legacyCommand}\`.

## Safety

${safety.map(value => `- ${value}`).join('\n')}
- Do not read arbitrary files or fetch diagram/image URLs. Import only a file explicitly authorized by the reader. Unsupported diagrams remain source.
- A saved question does not prove an agent is active. Demo output is not AI. Do not start a second service on the same database.

## Local installation and discovery

Use an already-installed ${productName} checkout with Node 22.13+ and dependencies.
If its location is unknown, ask; never download implicitly. No global bin is needed:

\`\`\`sh
node /absolute/path/to/${primaryCommand}/bin/${primaryCommand}.js --help
node /absolute/path/to/${primaryCommand}/bin/${primaryCommand}.js --scope /absolute/path/to/report-directory
\`\`\`

The historical \`bin/${legacyCommand}.js\` path also works. With a verified PATH binary:

\`\`\`sh
${discovery.join('\n')}
\`\`\`

Carry \`--scope\` and \`--url\` into subsequent commands. Use \`--full\` for truncated
previews; \`${primaryCommand} <command> --help\` for flags and examples; and
\`${primaryCommand} agent-help\` for reply/citation, lifetime and recovery contracts.

Optional \`${primaryCommand} setup --app <claude|codex|opencode> --local-only\` installs
availability-only hooks in a locally configured harness; this skill is an alternative.
Neither grants permission to disclose content to an external model.

## Present your own report

${presentationGuidance}

## Explicit continuous attachment

As the presenting agent or its explicitly authorized delegate, own both ends of
this JSONL command **from the installed checkout**, not the skill folder:

\`\`\`sh
node src/local-agent.js
\`\`\`

Or use the absolute checkout path to \`src/local-agent.js\` from any directory.
Set \`SILLAGE_URL\` for a nondefault loopback service. Use \`${primaryCommand} agent-help\`
before sending the ready presentation. This is part of your handoff, not a setup
instruction for the reader. Alternatively \`${primaryCommand} attach\` explicitly
selects JSONL mode with directory checks. The historical \`${legacyCommand} attach\` alias
has the same behavior. Do not wrap machine stdio in npm banners. No automatic model
launch, reserve retry or fabricated answer is permitted.
`;
}
const path = new URL('../skills/sillage/SKILL.md', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== skill()) { console.error('Stale skill: run npm run skill:generate'); process.exitCode = 1; }
} else writeFileSync(path, skill());
