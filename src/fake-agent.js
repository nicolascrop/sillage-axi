import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Agent URL must be an http://127.0.0.1:PORT or http://localhost:PORT origin');
  }
  return url.origin;
}

/** One finite poll, no network beyond loopback, no secrets, no provider SDK. */
export async function runFakeAgent(base = 'http://127.0.0.1:3210') {
  const origin = localUrl(base);
  const post = async (path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
    return data;
  };
  const { request } = await post('/api/agent/reserve', { worker: 'deterministic-fake-v1', lease_seconds: 60 });
  if (!request) return { status: 'idle' };
  const answer = await post(`/api/agent/requests/${request.request_id}/answer`, {
    lease_token: request.lease_token,
    status: 'answered',
    body: `Local fake agent — demonstration only, not an AI assessment.\n\nQuestion: ${request.question}\n\nThe saved passage in revision ${request.document.id} says:\n${request.quote.slice(0, 12000)}${request.quote.length > 12000 ? '\n[Display excerpt shortened; exact citation is retained.]' : ''}`,
    citations: [{ revision_id: request.document.id, block_id: request.block.id, quote: request.quote }],
  });
  return { status: 'answered', thread_id: answer.thread.id, request_id: request.request_id };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runFakeAgent(process.env.SILLAGE_URL || 'http://127.0.0.1:3210')
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
