import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
// Only packaged bytes are public; never interpret a reader-supplied filesystem path.
export function whiteboardAssets() {
  const root = fileURLToPath(new URL('../dist/whiteboard/', import.meta.url));
  const paths = new Map();
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), name + '/');
      else if (entry.isFile() && /\.(js|css|woff2?|ttf)$/.test(name)) paths.set('/whiteboard-assets/' + name, join(dir, entry.name));
    }
  }
  try { visit(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return path => {
    const file = paths.get(path);
    if (!file) return null;
    if (!realpathSync(file).startsWith(realpathSync(root) + sep)) return null;
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.woff') ? 'font/woff' : 'font/ttf';
    return { body: readFileSync(file), type };
  };
}
export const whiteboardFrameHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sillage whiteboard</title><link rel="stylesheet" href="/whiteboard-assets/whiteboard.css"></head><body><script src="/whiteboard-assets/whiteboard.js"></script></body></html>';
export function whiteboardCsp(origin) {
  const assets = `${origin}/whiteboard-assets/`;
  return `default-src 'none'; script-src ${assets}; style-src ${assets} 'unsafe-inline'; img-src data: blob:; font-src ${assets} data:; connect-src ${assets}; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'self'; form-action 'none'; sandbox allow-scripts`;
}
