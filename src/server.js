import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, Problem } from './store.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json' || req.headers['x-sillage-local'] !== '1') {
    throw new Problem(415, 'Use application/json and X-Sillage-Local: 1');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 2_000_000) chunks.push(chunk);
  }
  if (size > 2_000_000) throw new Problem(413, 'Request exceeds 2 MB');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Problem(400, 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Problem(400, 'Expected a JSON object');
  return body;
}

export function createApp({ dbPath = '.data/sillage.sqlite', now } = {}) {
  const store = new Store(dbPath, { now });
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { ...securityHeaders, 'Content-Type': type });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host) ||
        (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
        throw new Problem(403, 'Local same-origin requests only');
      }
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        return send(200, readFileSync(new URL(`../public/${file}`, import.meta.url)), type);
      }
      if (req.method === 'GET' && path === '/api/document') return send(200, store.current());
      if (req.method === 'GET' && path === '/api/threads') return send(200, store.threads());
      const threadPath = path.match(/^\/api\/threads\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && threadPath) return send(200, store.thread(threadPath[1]));
      if (!['POST', 'PATCH'].includes(req.method)) throw new Problem(404, 'Route not found');
      const input = await jsonBody(req);
      if (req.method === 'POST' && path === '/api/document') return send(201, store.importReport(input));
      if (req.method === 'POST' && path === '/api/questions') return send(201, store.question(input));
      if (req.method === 'PATCH' && threadPath) return send(200, store.updateThread(threadPath[1], input));
      if (req.method === 'POST' && path === '/api/agent/reserve') return send(200, { request: store.reserve(input) });
      const answerPath = path.match(/^\/api\/agent\/requests\/([a-f0-9-]+)\/answer$/);
      if (req.method === 'POST' && answerPath) return send(200, store.answer(answerPath[1], input));
      throw new Problem(404, 'Route not found');
    } catch (error) {
      if (!(error instanceof Problem)) console.error('Local request failed:', error);
      if (!res.headersSent) send(error.status || 500, { error: error instanceof Problem ? error.message : 'Local storage/server error' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => store.close());
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  const port = Number(process.env.SILLAGE_PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SILLAGE_PORT');
  const { server } = createApp({ dbPath: process.env.SILLAGE_DB || '.data/sillage.sqlite' });
  server.listen(port, '127.0.0.1', () => console.log(`Sillage: http://127.0.0.1:${port} (local only)`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
