import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Build-only patch of the pinned converter. Keep Mermaid's security fixes and
// render-ID scoping intact; teach old DOM queries about that exact prefix.
export function mermaidCompatibility() {
  return { name: 'mermaid-scoped-ids', setup(build) {
    let patched = 0;
    const helper = fileURLToPath(new URL('../src/mermaid-container.js', import.meta.url));
    build.onEnd(() => {
      if (patched !== 2) throw new Error('Pinned Mermaid converter changed; re-probe native conversion');
    });
    build.onLoad({ filter: /@excalidraw\/mermaid-to-excalidraw\/dist\/parser\/class\.js$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const match = '.filter((el) => regex.test(el.id))';
      if (source.split(match).length !== 2) throw new Error('Pinned class ID lookup changed; re-probe before upgrading');
      patched++;
      return { contents: `import { unscopedMermaidId } from ${JSON.stringify(helper)};\n${source.replace(match, '.filter((el) => regex.test(unscopedMermaidId(el.id, containerEl.id)))')}`, loader: 'js' };
    });
    build.onLoad({ filter: /@excalidraw\/mermaid-to-excalidraw\/dist\/parseMermaid\.js$/ }, async ({ path }) => {
      let source = await readFile(path, 'utf8');
      const insertion = 'svgContainer.innerHTML = svg;';
      const dbQuery = 'diagram.db, svgContainer';
      const diagramQuery = 'diagram, svgContainer';
      if (source.split(insertion).length !== 2 || source.split(dbQuery).length !== 4 || source.split(diagramQuery).length !== 3) {
        throw new Error('Pinned Mermaid converter queries changed; refusing an unverified patch');
      }
      source = source.replace(insertion, `${insertion}\nconst queryContainer = mermaidContainer(svgContainer, renderId);`)
        .replaceAll(dbQuery, 'diagram.db, queryContainer').replaceAll(diagramQuery, 'diagram, queryContainer');
      patched++;
      return { contents: `import { mermaidContainer } from ${JSON.stringify(helper)};\n${source}`, loader: 'js' };
    });
  } };
}
