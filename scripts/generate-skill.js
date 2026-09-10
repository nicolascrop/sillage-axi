import { readFileSync, writeFileSync } from 'node:fs';
import { description, discovery, legacyCommand, primaryCommand, productName, safety } from '../src/guidance.js';
export function skill() {
  return `---
name: ${legacyCommand}
description: Inspect a local Markdown report, discuss exact passages, or attach an already-running local-only reasoner to ${productName}.
metadata:
  argument-hint: "[local Markdown path or reader task]"
  product: ${primaryCommand}
---

# ${productName}

${description}

Interpret \`$ARGUMENTS\` as the requested reader task, never as shell code.
The primary product command is \`${primaryCommand}\`; the compatibility command is
\`${legacyCommand}\`. The public skill invocation remains \`/${legacyCommand}\`.
The argument hint is metadata; harnesses that ignore it still receive the request
through the skill invocation.

## Safety

${safety.map(value => `- ${value}`).join('\n')}
- Do not read arbitrary files or fetch diagram/image URLs. Import only a file explicitly authorized by the reader. Unsupported diagrams remain source.
- A saved question does not prove an agent is active. Demo output is not AI. Do not start a second service on the same database.

## Local installation and discovery

This skill is portable guidance, not a bundled runtime. Ask for an already-installed
${productName} checkout when its location is unknown; do not download one implicitly.
With Node 24+ and dependencies preinstalled, no registry or global binary is needed:

\`\`\`sh
node /absolute/path/to/${primaryCommand}/bin/${primaryCommand}.js --help
node /absolute/path/to/${primaryCommand}/bin/${primaryCommand}.js --scope /absolute/path/to/report-directory
\`\`\`

The historical direct path \`node /absolute/path/to/${primaryCommand}/bin/${legacyCommand}.js\` remains valid.
If the verified \`${primaryCommand}\` binary is on PATH, the same discovery commands are:

\`\`\`sh
${discovery.join('\n')}
\`\`\`

Carry \`--scope\` and \`--url\` from the current observation into subsequent commands.
Use \`--full\` only when a preview is truncated. Get current flags and examples from
\`${primaryCommand} <command> --help\`; get the complete reply/citation contract and failure
lifecycle with \`${primaryCommand} agent-help\`. These references are runtime commands,
not links out of an installed skill directory.

Prefer explicit opt-in \`${primaryCommand} setup --app <claude|codex|opencode> --local-only\`
for ambient availability in a locally configured harness. This skill is the
on-demand alternative; installing either is sufficient for discovery. Neither
installation grants permission to disclose private content to an external model.

## Explicit continuous attachment

Only when a reasoner is already running locally and authorized to answer, start
this direct JSONL command **from the installed ${productName} checkout**, not the skill
folder (the finite CLI equivalent is not the attachment):

\`\`\`sh
node src/local-agent.js
\`\`\`

Or use the absolute checkout path to \`src/local-agent.js\` from any directory.
Set \`SILLAGE_URL\` for a nondefault loopback service. Use \`${primaryCommand} agent-help\`
before sending the ready handshake. Alternatively \`${primaryCommand} attach\` explicitly
selects JSONL mode with directory checks. The historical \`${legacyCommand} attach\` alias
has the same behavior. Do not wrap machine stdio in npm banners. No automatic model
launch, reserve retry or fabricated answer is permitted.
`;
}
const path = new URL('../skills/sillage/SKILL.md', import.meta.url);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== skill()) { console.error('Stale skill: run npm run skill:generate'); process.exitCode = 1; }
} else writeFileSync(path, skill());
