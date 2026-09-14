import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { legacyGate, isEntry, failure } from './entry.js';
import { whiteboardAssets, whiteboardFrameHtml, whiteboardCsp } from './whiteboard-assets.js';
const handled = await legacyGate(import.meta.url, 'serve');
const { Store, Problem } = handled ? {} : await import('./store.js');
const { LocalRelay } = handled ? {} : await import('./relay.js');
const { inspect } = handled ? {} : await import('./inspection.js');
const { validate } = handled ? {} : await import('./arguments.js');

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/whiteboards.js', ['whiteboards.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/sillage.svg', ['sillage.svg', 'image/svg+xml']],
]);
const securityHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
async function jsonBody(req, max = 2_000_000) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json' || req.headers['x-sillage-local'] !== '1') {
    throw new Problem(415, 'Use application/json and X-Sillage-Local: 1');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= max) chunks.push(chunk);
  }
  if (size > max) throw new Problem(413, `Request exceeds ${max / 1_000_000} MB`);
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
  const bundledAsset = whiteboardAssets();
  // Page-scoped end acknowledgements, not respondent handles or durable sessions.
  // Unknown/evicted keys refuse instead of ever disconnecting a newer respondent.
  const reviews = new Map();
  const sweep = setInterval(() => relay.sweep(), 1000);
  sweep.unref();
  const server = http.createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8', headers = {}) => {
      res.writeHead(status, { ...securityHeaders, 'Content-Type': type, ...headers });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const port = server.address().port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      const path = new URL(req.url, `http://${hosts[0]}`).pathname;
      // Opaque frames may fetch only non-secret, allowlisted packaged bytes.
      if (hosts.includes(req.headers.host) && req.method === 'GET' && path.startsWith('/whiteboard-assets/')) {
        const asset = bundledAsset(path);
        if (!asset) throw new Problem(404, 'Bundled whiteboard asset not found');
        return send(200, asset.body, asset.type, { 'Access-Control-Allow-Origin': '*',
          'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-cache' });
      }
      if (!hosts.includes(req.headers.host) ||
        (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
        throw new Problem(403, 'Local same-origin requests only');
      }
      if (req.headers['x-sillage-scope'] && req.headers['x-sillage-scope'] !== encodeURIComponent(scope)) return send(409, { service: 'out_of_scope' });
      if (req.method === 'GET' && path === '/whiteboard-frame') return send(200, whiteboardFrameHtml, 'text/html; charset=utf-8', {
        'Content-Security-Policy': whiteboardCsp(`http://${req.headers.host}`),
      });
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path);
        let body = readFileSync(new URL(`../public/${file}`, import.meta.url));
        if (path === '/') {
          const key = randomUUID();
          if (reviews.size >= 1000) reviews.delete(reviews.keys().next().value);
          reviews.set(key, { ended: false });
          body = body.toString().replace('<meta name="sillage-review" content="">', `<meta name="sillage-review" content="${key}">`);
        }
        return send(200, body, type);
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
      if (req.method === 'GET' && path === '/api/conversations') return send(200, store.conversations());
      const conversationPath = path.match(/^\/api\/conversations\/([a-f0-9-]+)(\/questions)?$/);
      if (req.method === 'GET' && conversationPath && !conversationPath[2]) return send(200, store.conversation(conversationPath[1]));
      const threadPath = path.match(/^\/api\/threads\/([a-f0-9-]+)$/);
      if (req.method === 'GET' && threadPath) return send(200, store.thread(threadPath[1]));
      const whiteboardPath = path.match(/^\/api\/whiteboards\/(\d+)\/([a-f0-9-]+)(\/feedback)?$/);
      const snapshotPath = path.match(/^\/api\/whiteboard-snapshots\/(\d+)$/);
      if (req.method === 'GET' && path === '/api/whiteboards') return send(200, store.whiteboards.history());
      if (req.method === 'GET' && snapshotPath) return send(200, store.whiteboards.snapshot(Number(snapshotPath[1])));
      if (req.method === 'GET' && whiteboardPath && !whiteboardPath[3]) return send(200, store.whiteboards.load(Number(whiteboardPath[1]), whiteboardPath[2]));
      if (!['POST', 'PATCH'].includes(req.method)) throw new Problem(404, 'Route not found');
      const input = await jsonBody(req, whiteboardPath && !whiteboardPath[3] ? 20_000_000 : 2_000_000);
      if (req.method === 'POST' && path === '/review/end') {
        if (Object.keys(input).some(key => !['review_key', 'revision_id'].includes(key)) ||
          typeof input.review_key !== 'string' || !(input.revision_id === null || Number.isSafeInteger(input.revision_id))) {
          throw new Problem(400, 'Expected the current review key and revision');
        }
        const review = reviews.get(input.review_key);
        if (!review) throw new Problem(409, 'This review page has expired. Reload before ending the review.');
        if (!review.ended) {
          if (input.revision_id !== store.revisionId()) throw new Problem(409, 'The report changed. Review the latest revision before ending the session.');
          // Resolve only the active respondent here; never send its handle to a page.
          if (relay.status().state === 'active') relay.disconnect({ session_id: relay.session.id });
          review.ended = true;
        }
        return send(200, { ended: true });
      }
      if (req.method === 'POST' && whiteboardPath) return send(201, whiteboardPath[3]
        ? store.whiteboards.feedback(Number(whiteboardPath[1]), whiteboardPath[2], input)
        : store.whiteboards.save(Number(whiteboardPath[1]), whiteboardPath[2], input));
      if (conversationPath && req.method === 'POST' && conversationPath[2]) return send(201, store.followup(conversationPath[1], input));
      if (conversationPath && req.method === 'PATCH' && !conversationPath[2]) return send(200, store.updateConversation(conversationPath[1], input));
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
  try {
    const { buildWhiteboard } = await import('../scripts/build-whiteboard.js');
    await buildWhiteboard();
  } catch {
    await failure('assets', 'Cannot build the local whiteboard assets', 'Install the pinned dependencies with npm ci --ignore-scripts, then run npm run build in the Sillage checkout. No reader data was changed.');
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
