export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Agent URL must be an http://127.0.0.1:PORT or http://localhost:PORT origin');
  }
  return url.origin;
}
export function localClient(base, { scope } = {}) {
  const origin = localUrl(base);
  return async (path, body) => {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1', ...(scope ? { 'X-Sillage-Scope': encodeURIComponent(scope) } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
    return data;
  };
}
