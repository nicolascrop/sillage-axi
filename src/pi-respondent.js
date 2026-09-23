import { PassThrough } from 'node:stream';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { localUrl } from './agent-client.js';
import { runLocalAgent } from './local-agent.js';

// Transport only. Pi's CURRENT session owns reasoning; no SDK, credentials,
// model subprocess, provider selection, report-file read or service startup.
export class PiRespondent {
  constructor({ bridge = runLocalAgent, onRequest, onState = () => {}, acknowledgementMs = 15_000 } = {}) {
    this.bridge = bridge;
    this.onRequest = onRequest;
    this.onState = onState;
    this.acknowledgementMs = acknowledgementMs;
    this.state = 'stopped';
  }
  setState(state) { this.state = state; this.onState(state); }
  waitFor(type) {
    if (this.waiter) throw new Error('A bridge acknowledgement is already pending');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reject(new Error(`No ${type} acknowledgement; disconnect and inspect before reattaching`)), this.acknowledgementMs);
      this.waiter = { type, resolve, reject, timer };
    });
  }
  reject(error) {
    if (!this.waiter) return;
    clearTimeout(this.waiter.timer);
    this.waiter.reject(error);
    this.waiter = null;
  }
  send(value) {
    const line = JSON.stringify(value);
    if (line.length > 100_000) throw new Error('JSONL reply exceeds 100,000 characters');
    this.input.write(line + '\n');
  }
  event(value) {
    if (value.type === 'request') {
      if (this.closing) return;
      this.pending = value.request;
      this.setState('answering');
      try { this.onRequest(value.request); }
      catch (error) { this.reject(error); this.input.end(); }
    } else if (value.type === 'expired') {
      this.closing = true;
      this.pending = null;
      this.reject(new Error('Answer lease expired; the saved failure cannot be replaced'));
      // Do not keep advertising a reasoner that missed its answering deadline.
      this.input.end();
    } else if (value.type === 'error') {
      this.reject(new Error(value.error));
      // Invalid answers may be corrected on the same live lease. Transport
      // failure is followed by stopped from the bridge and never auto-reconnects.
    } else if (value.type === 'stopped') {
      this.pending = null;
      this.reject(new Error('Sillage bridge stopped; replies are paused'));
      this.setState('stopped');
    }
    if (this.waiter?.type === value.type) {
      clearTimeout(this.waiter.timer);
      this.waiter.resolve(value);
      this.waiter = null;
    }
  }
  async connect({ scope, url, revisionId }) {
    if (this.running) throw new Error('Already attached; disconnect before changing scope');
    if (!isAbsolute(scope)) throw new Error('An absolute service scope is required');
    scope = realpathSync(scope);
    const base = localUrl(url);
    if (revisionId !== undefined && (!Number.isSafeInteger(revisionId) || revisionId < 1)) throw new Error('Invalid handoff revision ID');
    this.closing = false;
    this.input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let partial = '';
    output.on('data', chunk => {
      partial += chunk;
      let end;
      while ((end = partial.indexOf('\n')) !== -1) {
        const line = partial.slice(0, end); partial = partial.slice(end + 1);
        try { this.event(JSON.parse(line)); }
        catch (error) { this.reject(error); this.input.end(); }
      }
    });
    this.setState('connecting');
    const connected = this.waitFor('connected');
    this.running = Promise.resolve().then(() => this.bridge({ base, scope, input: this.input, output }))
      .catch(error => this.reject(error))
      .finally(() => {
        this.pending = null;
        this.reject(new Error('Sillage bridge stopped'));
        this.setState('stopped');
        this.running = null;
        output.destroy();
      });
    try {
      this.send({ type: 'ready', worker: 'pi-current-session', ...(revisionId ? { handoff_revision_id: revisionId } : {}) });
      await connected;
      // A request can follow connected in the same chunk.
      this.setState(this.pending ? 'answering' : 'listening');
      return { state: this.state, scope, url: base };
    } catch (error) { await this.disconnect(); throw error; }
  }
  async answer({ request_id, status, body, citations }) {
    if (!this.pending || this.pending.request_id !== request_id || this.state !== 'answering') throw new Error('No live request with that ID; do not answer an expired or previous attachment');
    if (this.pending.lease_until <= Date.now()) throw new Error('Answer lease expired');
    if (this.waiter) throw new Error('An answer save is already pending');
    // Validate before creating the acknowledgement waiter.
    const payload = { type: 'answer', request_id, status, body, citations };
    if (JSON.stringify(payload).length > 100_000) throw new Error('JSONL reply exceeds 100,000 characters');
    const saved = this.waitFor('saved');
    this.send(payload);
    try {
      const result = await saved;
      this.pending = null;
      this.setState('listening');
      return result;
    } catch (error) {
      // A timeout is an uncertain save, not permission to fabricate success.
      if (error.message.startsWith('No saved')) await this.disconnect();
      throw error;
    }
  }
  async disconnect() {
    this.closing = true;
    this.pending = null;
    if (this.running) this.setState('disconnecting');
    this.reject(new Error('Respondent disconnected'));
    this.input?.end();
    await this.running;
    this.pending = null;
    this.setState('stopped');
  }
}
