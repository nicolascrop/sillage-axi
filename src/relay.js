import { randomUUID } from 'node:crypto';
import { Problem, text } from './store.js';

// One explicitly connected local worker. Presence is ephemeral, never inferred
// from a queued question or from the deterministic demo adapter.
export class LocalRelay {
  constructor(store, now = Date.now) {
    this.store = store;
    this.now = now;
    this.session = null;
    this.pending = null;
  }
  sweep() {
    if (this.pending && this.pending.lease_until <= this.now()) {
      this.fail('The connected local agent did not finish within 120 seconds. Ask again when it is ready.');
    }
    if (this.session && this.session.until <= this.now()) {
      this.fail('The local agent disconnected before answering. The original question is preserved; reconnect and ask again.');
      this.session = null;
    }
  }
  fail(body) {
    if (this.pending) this.store.failReservation(this.pending, body);
    this.pending = null;
  }
  status() {
    this.sweep();
    return { state: this.session ? 'active' : 'unavailable', worker: this.session?.worker ?? null,
      busy: Boolean(this.pending), heartbeat_seconds: 5, expires_seconds: 20 };
  }
  connect({ worker, handoff_revision_id, presentation }) {
    text(worker, 'worker', 86); // leave room for the persisted local-session: marker
    if (worker === 'deterministic-fake-v1') throw new Problem(400, 'The demo adapter is not an active local agent');
    this.sweep();
    if (this.session) throw new Problem(409, 'A local agent is already connected; disconnect it or wait for its presence to expire');
    if (presentation !== undefined && handoff_revision_id !== undefined) throw new Problem(400, 'Choose presentation or handoff_revision_id');
    if (presentation !== undefined) {
      if (!presentation || !presentation.handoff) throw new Problem(400, 'presentation requires a report and handoff');
      handoff_revision_id = this.store.importReport(presentation).id;
    }
    let handoff;
    let document;
    if (handoff_revision_id !== undefined) {
      if (!Number.isSafeInteger(handoff_revision_id)) throw new Problem(400, 'handoff_revision_id must be an integer');
      handoff = this.store.handoff(handoff_revision_id);
      if (!handoff) throw new Problem(404, 'No handoff for this exact revision');
      const { id, title, source, created_at } = this.store.revision(handoff_revision_id);
      document = { id, title, source, created_at, ...this.store.documentLanguage(id) };
    }
    this.session = { id: randomUUID(), worker, until: this.now() + 20_000 };
    return { session_id: this.session.id, ...this.status(), ...(handoff ? { handoff, document } : {}) };
  }
  requireSession({ session_id }) {
    this.sweep();
    if (!this.session || this.session.id !== session_id) throw new Problem(409, 'Local agent session expired; connect again');
    this.session.until = this.now() + 20_000;
  }
  heartbeat(input) { this.requireSession(input); return this.status(); }
  disconnect(input) {
    this.requireSession(input);
    this.fail('The local agent stopped before answering. Ask again after reconnecting.');
    this.session = null;
    return this.status();
  }
  reserve(input) {
    this.requireSession(input);
    if (this.pending) return null;
    this.pending = this.store.reserve({ worker: `local-session:${this.session.worker}`, lease_seconds: 120, managed: true });
    return this.pending;
  }
  answered(id) {
    if (this.pending?.request_id === id) this.pending = null;
  }
}
