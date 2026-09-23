// Local-only Lavish-compatible editor bundle. No fetch/install at build or run time.
import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../src/entry.js';
import { mermaidCompatibility } from './mermaid-compatibility.js';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function buildWhiteboard() {
  await mkdir(`${root}dist/whiteboard`, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: { whiteboard: 'src/whiteboard-frame.js' },
    outdir: 'dist/whiteboard', bundle: true, minify: true, format: 'iife', platform: 'browser',
    conditions: ['production'], loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    // Font registration runs during module evaluation, before frame main().
    banner: { js: 'window.EXCALIDRAW_ASSET_PATH = new URL("/whiteboard-assets/", location.href).href;' },
    plugins: [mermaidCompatibility(), { name: 'local-font-fallback', setup(build) {
      let patched = 0;
      build.onEnd(() => { if (patched !== 1) throw new Error('Pinned Excalidraw font module changed; local fallback was not verified'); });
      build.onLoad({ filter: /@excalidraw\/excalidraw\/dist\/prod\/chunk-K2UTITRG\.js$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const fallback = '`https://esm.sh/${M.PKG_NAME?`${M.PKG_NAME}@${M.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`';
        if (source.split(fallback).length !== 2) throw new Error('Pinned Excalidraw font fallback changed; re-probe before upgrading');
        patched++;
        return { contents: source.replace(fallback, 'window.EXCALIDRAW_ASSET_PATH'), loader: 'js' };
      });
    } }],
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IS_PREACT': '"false"' } });
  // Include ALL families, including Xiaolai: unlike Lavish, no CDN font fallback is allowed.
  await cp(`${root}node_modules/@excalidraw/excalidraw/dist/prod/fonts`, `${root}dist/whiteboard/fonts`, { recursive: true });
}
if (isEntry(import.meta.url)) await buildWhiteboard();
