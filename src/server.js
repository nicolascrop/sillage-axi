import http from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { legacyGate, isEntry, failure } from './entry.js';
const handled = await legacyGate(import.meta.url, 'serve');
const { Store, Problem } = handled ? {} : await import('./store.js');
const { LocalRelay } = handled ? {} : await import('./relay.js');
const { inspect } = handled ? {} : await import('./inspection.js');
const { validate } = handled ? {} : await import('./arguments.js');

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/sillage.svg', ['sillage.svg', 'image/svg+xml']],
]);
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
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

export function createApp({ dbPath = '.data/sillage.sqlite', now, scopeRoot = process.cwd() } = {}) {
  const scope = realpathSync(scopeRoot);
  const store = new Store(dbPath, { now });
  store.recoverLocalReservations();
  const relay = new LocalRelay(store, now);
  const sweep = setInterval(() => relay.sweep(), 1000);
  sweep.unref();
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
      if (req.headers['x-sillage-scope'] && req.headers['x-sillage-scope'] !== encodeURIComponent(scope)) return send(409, { service: 'out_of_scope' });
      const path = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        return send(200, readFileSync(new URL(`../public/${file}`, import.meta.url)), type);
      }
      if (req.method === 'GET' && path === '/api/inspect') {
        const query = new URL(req.url, `http://${req.headers.host}`).searchParams;
        if (query.get('scope') !== scope) return send(409, { service: 'out_of_scope' });
        const view = query.get('view') || 'home';
        if (!['home', 'context', 'document', 'blocks', 'block', 'threads', 'thread'].includes(view)) throw new Problem(400, 'Unknown inspection view');
        if ([...query.keys()].some(key => !['scope', 'view', 'id', 'revision', 'fields', 'limit', 'offset', 'full'].includes(key))) throw new Problem(400, 'Unknown inspection parameter');
        if (new Set(query.keys()).size !== [...query.keys()].length) throw new Problem(400, 'Duplicate inspection parameter');
        const options = Object.fromEntries([...query].filter(([key]) => !['view', 'id', 'scope'].includes(key)));
        if ('full' in options) options.full = options.full === 'true' ? true : options.full;
        try {
          validate(view, options, query.has('id') ? [query.get('id')] : []);
          return send(200, inspect(store, relay, { view, id: query.get('id'), ...options }));
        } catch (error) { throw new Problem(error.status || 400, error.message); }
      }
      relay.sweep();
      if (req.method === 'GET' && path === '/api/state') return send(200, { revision_id: store.revisionId(), agent: relay.status() });
      if (req.method === 'GET' && path === '/api/document') return send(200, store.current());
      if (req.method === 'GET' && path === '/api/threads') return send(200, store.threads());
      const threadPath = path.match(/^\/api\/threads\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && threadPath) return send(200, store.thread(threadPath[1]));
      if (!['POST', 'PATCH'].includes(req.method)) throw new Problem(404, 'Route not found');
      const input = await jsonBody(req);
      if (req.method === 'POST' && path === '/api/document') return send(201, store.importReport(input));
      if (req.method === 'POST' && path === '/api/questions') return send(201, store.question(input));
      if (req.method === 'PATCH' && threadPath) return send(200, store.updateThread(threadPath[1], input));
      if (req.method === 'POST' && path === '/api/agent/connect') return send(200, relay.connect(input));
      if (req.method === 'POST' && path === '/api/agent/heartbeat') return send(200, relay.heartbeat(input));
      if (req.method === 'POST' && path === '/api/agent/disconnect') return send(200, relay.disconnect(input));
      if (req.method === 'POST' && path === '/api/agent/reserve') {
        if (!('session_id' in input) && relay.status().state === 'active') {
          throw new Problem(409, 'A connected local agent owns the queue; demo/legacy workers must wait until it disconnects');
        }
        if ('session_id' in input) return send(200, { request: relay.reserve(input) });
        const { worker, lease_seconds } = input;
        return send(200, { request: store.reserve({ worker, lease_seconds }) });
      }
      const answerPath = path.match(/^\/api\/agent\/requests\/([a-f0-9-]+)\/answer$/);
      if (req.method === 'POST' && answerPath) {
        const result = store.answer(answerPath[1], input);
        relay.answered(answerPath[1]);
        return send(200, result);
      }
      throw new Problem(404, 'Route not found');
    } catch (error) {
      if (!(error instanceof Problem)) console.error('Local request failed:', error);
      if (!res.headersSent) send(error.status || 500, { error: error instanceof Problem ? error.message : 'Local storage/server error' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('close', () => {
    clearInterval(sweep);
    relay.fail('The local service stopped before the agent finished. Reconnect and ask again.');
    store.close();
  });
  return { server, store, relay };
}

export async function serve() {
  process.umask(0o077);
  const port = Number(process.env.SILLAGE_PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    await failure('usage', 'Invalid SILLAGE_PORT: expected an integer from 1 to 65535', 'SILLAGE_PORT=3210 node src/server.js');
    return;
  }
  let app;
  try {
    app = createApp({ dbPath: process.env.SILLAGE_DB || '.data/sillage.sqlite' });
    app.server.on('error', async () => {
      app.server.close();
      await failure('service', 'Cannot listen on the local port', 'Choose a free SILLAGE_PORT; run only one service per SILLAGE_DB.');
    });
    app.server.listen(port, '127.0.0.1', () => console.error(`Sillage AXI: http://127.0.0.1:${port} (local only)`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.server.close());
  } catch {
    await failure('storage', 'Cannot open the local database; it may be inaccessible or use an unsupported schema', 'Check SILLAGE_DB permissions and use a compatible Sillage AXI version; do not delete reader data.');
  }
}
if (isEntry(import.meta.url) && !handled) await serve();
