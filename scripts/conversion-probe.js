// Build a file:// browser probe: no Sillage service, database, report or network.
// Open the printed file with chrome-devtools-axi; inspect window.conversionProbe.
import { build } from 'esbuild';
import { mermaidCompatibility } from './mermaid-compatibility.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const directory = resolve('.data/conversion-probe');
await mkdir(directory, { recursive: true });
await build({ stdin: { contents: `
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw';
const fixtures = {
  flowchart: 'flowchart TD\\n subgraph Logic\\n A[Start] --> B{Ready?}\\n B --> C[Run]\\n end',
  parallel: 'flowchart LR\\n A -->|one| B\\n A -->|two| B',
  sequence: 'sequenceDiagram\\n Alice->>Bob: Hello\\n Bob-->>Alice: Hi',
  class: 'classDiagram\\n Animal <|-- Duck\\n Animal : +name',
  er: 'erDiagram\\n CUSTOMER ||--o{ ORDER : places',
  state: 'stateDiagram-v2\\n [*] --> Idle\\n Idle --> Active',
  pie: 'pie title Pets\\n "Cats" : 3\\n "Dogs" : 2'
};
window.conversionProbe = { done: false, results: [] };
(async () => {
  for (const [name, source] of Object.entries(fixtures)) {
    try {
      const { elements } = await parseMermaidToExcalidraw(source);
      const image = elements.some(e => e.type === 'image');
      const pass = elements.length > 0 && image === (name === 'pie') &&
        (name !== 'flowchart' || elements.some(e => e.id === 'A' && e.type === 'rectangle')) &&
        (name !== 'parallel' || elements.filter(e => e.type === 'arrow').length === 2);
      window.conversionProbe.results.push({ name, pass, count: elements.length, types: [...new Set(elements.map(e => e.type))] });
    } catch (error) { window.conversionProbe.results.push({ name, pass: false, error: error.message }); }
  }
  window.conversionProbe.done = true;
  document.querySelector('pre').textContent = JSON.stringify(window.conversionProbe, null, 2);
})();`, resolveDir: process.cwd(), sourcefile: 'conversion-probe.js' }, outfile: `${directory}/probe.js`, bundle: true, format: 'iife', platform: 'browser', plugins: [mermaidCompatibility()] });
await writeFile(`${directory}/index.html`, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; connect-src 'none'"><title>Offline conversion probe</title><pre>Running local synthetic diagram conversions…</pre><script src="probe.js"></script>`);
console.log(pathToFileURL(`${directory}/index.html`).href);
