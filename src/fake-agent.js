import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { localClient } from './agent-client.js';
export { localUrl } from './agent-client.js';

/** One finite poll, no network beyond loopback, no secrets, no provider SDK. */
export async function runFakeAgent(base = 'http://127.0.0.1:3210') {
  const post = localClient(base);
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
