import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { renderReport, renderMarkdown } from './render.js';

export class Problem extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireValue(condition, status, message) {
  if (!condition) throw new Problem(status, message);
}
export function text(value, name, max = 2000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max,
    400, `${name} must be nonempty text (at most ${max} characters)`);
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const collapse = value => value.replace(/\s+/gu, ' ').trim();
function hasQuote(block, quote) {
  return [block.source, block.text].some(value => collapse(value).includes(collapse(quote)));
}

export class Store {
  constructor(path, { now = Date.now } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, 2].includes(version)) {
      this.db.close();
      throw new Error(`Unsupported Sillage AXI database schema ${version}; refusing to change it`);
    }
    const requestColumns = new Set(this.db.prepare('PRAGMA table_info(requests)').all().map(column => column.name));
    if (version < 2 && requestColumns.size > 0 && !requestColumns.has('managed')) {
      this.db.exec('ALTER TABLE requests ADD COLUMN managed INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS revisions (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
        html TEXT NOT NULL, toc TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS import_operations (
        operation_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
        revision_id INTEGER NOT NULL REFERENCES revisions(id)
      );
      CREATE TABLE IF NOT EXISTS revision_handoffs (
        revision_id INTEGER PRIMARY KEY REFERENCES revisions(id), context TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_turns (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id),
        conversation_id TEXT NOT NULL REFERENCES threads(id)
      );
      CREATE INDEX IF NOT EXISTS conversation_history ON conversation_turns(conversation_id);
      CREATE TABLE IF NOT EXISTS blocks (
        revision_id INTEGER NOT NULL REFERENCES revisions(id), id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        PRIMARY KEY (revision_id, id)
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, revision_id INTEGER NOT NULL, block_id TEXT NOT NULL,
        quote TEXT NOT NULL, context TEXT NOT NULL, created_at INTEGER NOT NULL,
        unread INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (revision_id, block_id) REFERENCES blocks(revision_id, id)
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id),
        client_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('waiting','reserved','answered','failed')),
        worker TEXT, managed INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
        answer_hash TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
        role TEXT NOT NULL CHECK(role IN ('user','agent')), body TEXT NOT NULL,
        citations TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(thread_id, role)
      );
      CREATE INDEX IF NOT EXISTS request_queue ON requests(status, created_at);
      PRAGMA user_version=2;
    `);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  blocks(revision) {
    return this.db.prepare('SELECT * FROM blocks WHERE revision_id=? ORDER BY ordinal').all(revision);
  }
  current() {
    const revision = this.db.prepare('SELECT * FROM revisions ORDER BY id DESC LIMIT 1').get();
    return revision ? { ...revision, toc: JSON.parse(revision.toc), blocks: this.blocks(revision.id) } : null;
  }
  revisionId() {
    return this.db.prepare('SELECT MAX(id) AS id FROM revisions').get().id;
  }
  revision(id) {
    const row = this.db.prepare('SELECT * FROM revisions WHERE id=?').get(id);
    requireValue(row, 404, 'Revision not found');
    return { ...row, toc: JSON.parse(row.toc), blocks: this.blocks(row.id) };
  }
  importReport({ title, source, expected_revision_id, operation_key, handoff }) {
    text(title, 'title', 200); text(source, 'source', 1_000_000);
    if (operation_key !== undefined) text(operation_key, 'operation_key', 100);
    if (handoff !== undefined) {
      requireValue(handoff && typeof handoff === 'object' && !Array.isArray(handoff) &&
        Object.keys(handoff).length === 3 && ['subject', 'repository', 'conversation'].every(key => key in handoff),
      400, 'handoff requires subject, repository and conversation text only');
      handoff = Object.fromEntries(['subject', 'repository', 'conversation'].map(key =>
        [key, text(handoff[key], `handoff ${key}`, 20_000)]));
      requireValue(operation_key !== undefined && expected_revision_id !== undefined, 400,
        'A handoff requires an operation_key and expected_revision_id');
    }
    const payloadHash = digest({ title, source, expected_revision_id, handoff });
    requireValue(source.split('\n').length <= 20_000, 400, 'Report exceeds 20,000 lines');
    return this.transaction(() => {
      // Reconcile a committed operation before checking today's revision guard.
      // The guard is part of the payload, so changing it under a key conflicts.
      if (operation_key !== undefined) {
        const prior = this.db.prepare('SELECT * FROM import_operations WHERE operation_key=?').get(operation_key);
        if (prior) {
          requireValue(prior.payload_hash === payloadHash, 409, 'operation_key reused with different import');
          return this.revision(prior.revision_id);
        }
      }
      const previous = this.current();
      if (expected_revision_id !== undefined) requireValue(expected_revision_id === (previous?.id ?? null),
        409, 'The report changed elsewhere. Live file updates paused; review the current report before reconnecting the file.');
      const rendered = renderReport(source, previous?.blocks);
      requireValue(rendered.blocks.length <= 5000, 400, 'Report exceeds 5,000 semantic blocks');
      const revision = Number(this.db.prepare(
        'INSERT INTO revisions(title,source,html,toc,created_at) VALUES(?,?,?,?,?)'
      ).run(title, source, rendered.html, JSON.stringify(rendered.toc), this.now()).lastInsertRowid);
      const insert = this.db.prepare(`INSERT INTO blocks
        (revision_id,id,ordinal,kind,source,text,start_line,end_line,fingerprint) VALUES(?,?,?,?,?,?,?,?,?)`);
      rendered.blocks.forEach((b, i) => insert.run(revision, b.id, i, b.kind, b.source,
        b.text, b.start_line, b.end_line, b.fingerprint));
      if (operation_key !== undefined) this.db.prepare(
        'INSERT INTO import_operations(operation_key,payload_hash,revision_id) VALUES(?,?,?)'
      ).run(operation_key, payloadHash, revision);
      if (handoff !== undefined) this.db.prepare('INSERT INTO revision_handoffs(revision_id,context) VALUES(?,?)')
        .run(revision, JSON.stringify(handoff));
      return this.current();
    });
  }
  handoff(revision) {
    const row = this.db.prepare('SELECT context FROM revision_handoffs WHERE revision_id=?').get(revision);
    return row ? { revision_id: revision, ...JSON.parse(row.context) } : null;
  }
  thread(id) {
    const thread = this.db.prepare(`SELECT t.*, r.id AS request_id, r.status AS request_status,
      r.attempts, r.lease_until, r.worker FROM threads t JOIN requests r ON r.thread_id=t.id WHERE t.id=?`).get(id);
    requireValue(thread, 404, 'Thread not found');
    const currentRevision = this.db.prepare('SELECT MAX(id) AS id FROM revisions').get().id;
    const matched = this.db.prepare('SELECT id FROM blocks WHERE revision_id=? AND id=?')
      .get(currentRevision, thread.block_id);
    return { ...thread, context: JSON.parse(thread.context),
      anchor_status: matched ? 'matched' : 'needs_review', current_revision_id: currentRevision,
      messages: this.db.prepare('SELECT * FROM messages WHERE thread_id=? ORDER BY created_at, rowid')
        .all(id).map(m => ({ ...m, citations: JSON.parse(m.citations) })),
    };
  }
  threads() {
    return this.db.prepare('SELECT id FROM threads ORDER BY created_at DESC, rowid DESC').all()
      .map(({ id }) => this.thread(id));
  }
  conversationId(id) {
    return this.db.prepare('SELECT conversation_id FROM conversation_turns WHERE thread_id=?').get(id)?.conversation_id ?? id;
  }
  conversation(id) {
    const root = this.thread(this.conversationId(id));
    const turns = [root, ...this.db.prepare('SELECT thread_id FROM conversation_turns WHERE conversation_id=? ORDER BY rowid')
      .all(root.id).map(row => this.thread(row.thread_id))];
    const latest = turns.at(-1);
    return { ...root, request_id: latest.request_id, request_status: latest.request_status,
      worker: latest.worker, unread: turns.some(turn => turn.unread) ? 1 : 0,
      messages: turns.flatMap(turn => turn.messages.map(message => ({ ...message, worker: turn.worker,
        ...(message.role === 'agent' ? { html: renderMarkdown(message.body) } : {}) }))) };
  }
  conversations() {
    return this.db.prepare('SELECT id FROM threads WHERE id NOT IN (SELECT thread_id FROM conversation_turns) ORDER BY created_at DESC,rowid DESC')
      .all().map(row => this.conversation(row.id));
  }
  updateConversation(id, input) {
    return this.transaction(() => {
      const root = this.conversationId(id);
      this.updateThread(root, input);
      // Reading a conversation acknowledges all turns, including late replies.
      if ('unread' in input) for (const row of this.db.prepare('SELECT thread_id FROM conversation_turns WHERE conversation_id=?').all(root)) {
        this.updateThread(row.thread_id, { unread: input.unread });
      }
      return this.conversation(root);
    });
  }
  followup(id, { question, client_key }) {
    const root = this.thread(this.conversationId(id));
    this.question({ revision_id: root.revision_id, block_id: root.block_id, quote: root.quote,
      question, client_key }, root.id);
    return this.conversation(root.id);
  }
  question(input, conversationId) {
    const { revision_id, block_id, quote, question, client_key } = input;
    text(block_id, 'block_id', 100); text(quote, 'quote', 20_000);
    text(question, 'question', 4000); text(client_key, 'client_key', 100);
    requireValue(Number.isSafeInteger(revision_id), 400, 'revision_id must be an integer');
    const payloadHash = digest({ revision_id, block_id, quote, question, conversation_id: conversationId });
    return this.transaction(() => {
      const duplicate = this.db.prepare('SELECT * FROM requests WHERE client_key=?').get(client_key);
      if (duplicate) {
        requireValue(duplicate.payload_hash === payloadHash, 409, 'client_key reused with different question');
        return this.thread(duplicate.thread_id);
      }
      if (conversationId) {
        const conversation = this.conversation(conversationId);
        requireValue(['answered', 'failed'].includes(conversation.request_status), 409,
          'Wait for the current reply before sending another message');
      }
      const blocks = this.blocks(revision_id);
      const block = blocks.find(b => b.id === block_id);
      requireValue(block, 404, 'Passage not found in the specified revision');
      requireValue(hasQuote(block, quote), 400, 'Quote must occur in the passage source or visible text');
      const context = { block, before: blocks[block.ordinal - 1]?.source ?? '',
        after: blocks[block.ordinal + 1]?.source ?? '' };
      const threadId = randomUUID();
      const now = this.now();
      this.db.prepare(`INSERT INTO threads(id,revision_id,block_id,quote,context,created_at)
        VALUES(?,?,?,?,?,?)`).run(threadId, revision_id, block_id, quote, JSON.stringify(context), now);
      this.db.prepare(`INSERT INTO requests(id,thread_id,client_key,payload_hash,status,created_at)
        VALUES(?,?,?,?,'waiting',?)`).run(randomUUID(), threadId, client_key, payloadHash, now);
      this.db.prepare(`INSERT INTO messages(id,thread_id,role,body,status,created_at)
        VALUES(?,?,'user',?,'saved',?)`).run(randomUUID(), threadId, question, now);
      if (conversationId) this.db.prepare('INSERT INTO conversation_turns(thread_id,conversation_id) VALUES(?,?)')
        .run(threadId, conversationId);
      return this.thread(threadId);
    });
  }
  updateThread(id, input) {
    this.thread(id);
    requireValue(Object.keys(input).length > 0 && Object.keys(input).every(k =>
      ['unread', 'closed'].includes(k) && typeof input[k] === 'boolean'), 400, 'Only boolean unread/closed fields are accepted');
    for (const key of ['unread', 'closed']) {
      if (key in input) this.db.prepare(`UPDATE threads SET ${key}=? WHERE id=?`).run(Number(input[key]), id);
    }
    return this.thread(id);
  }
  reserve({ worker, lease_seconds = 60, managed = false }) {
    text(worker, 'worker', 100);
    requireValue(typeof managed === 'boolean', 400, 'managed must be a boolean');
    requireValue(Number.isInteger(lease_seconds) && lease_seconds >= 5 && lease_seconds <= 300,
      400, 'lease_seconds must be an integer from 5 to 300');
    return this.transaction(() => {
      const now = this.now();
      const request = this.db.prepare(`SELECT * FROM requests WHERE status='waiting'
        OR (status='reserved' AND lease_until<=?) ORDER BY created_at, rowid LIMIT 1`).get(now);
      if (!request) return null;
      const token = randomUUID();
      const until = now + lease_seconds * 1000;
      this.db.prepare(`UPDATE requests SET status='reserved',worker=?,managed=?,lease_token=?,lease_until=?,
        attempts=attempts+1 WHERE id=?`).run(worker, Number(managed), token, until, request.id);
      const thread = this.thread(request.thread_id);
      const document = this.db.prepare('SELECT id,title,source,created_at FROM revisions WHERE id=?')
        .get(thread.revision_id);
      const handoff = this.handoff(document.id);
      const conversationId = this.conversationId(thread.id);
      const history = conversationId === thread.id ? null : this.conversation(conversationId).messages
        .filter(message => message.thread_id !== thread.id)
        .map(({ html, ...message }) => message);
      return { ...(handoff ? { handoff } : {}), ...(history ? { conversation_id: conversationId, history } : {}), protocol: 'sillage-agent-v1', request_id: request.id, lease_token: token,
        lease_until: until, attempt: request.attempts + 1, thread_id: thread.id,
        document, block: thread.context.block, quote: thread.quote, context: thread.context,
        question: thread.messages[0].body, anchor_status: thread.anchor_status };
    });
  }
  recoverLocalReservations() {
    const abandoned = this.db.prepare("SELECT id AS request_id,lease_token FROM requests WHERE status='reserved' AND managed=1").all();
    for (const request of abandoned) this.failReservation(request,
      'The local service restarted before the agent finished. Reconnect and ask again.');
  }
  // Internal lifecycle failure only: compare the exact reservation so a timeout
  // never overwrites another worker's lease or an already terminal result.
  failReservation(request, body) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM requests WHERE id=?').get(request.request_id);
      if (!row || row.status !== 'reserved' || row.lease_token !== request.lease_token) return false;
      this.db.prepare(`INSERT INTO messages(id,thread_id,role,body,citations,status,created_at)
        VALUES(?,?,'agent',?,'[]','failed',?)`).run(randomUUID(), row.thread_id, body, this.now());
      this.db.prepare("UPDATE requests SET status='failed',answer_hash=? WHERE id=?")
        .run(digest({ status: 'failed', body, citations: [] }), row.id);
      this.db.prepare('UPDATE threads SET unread=1 WHERE id=?').run(row.thread_id);
      return true;
    });
  }
  answer(id, { lease_token, status, body, citations = [] }) {
    text(lease_token, 'lease_token', 100); text(body, 'body', 20_000);
    requireValue(['answered', 'failed'].includes(status), 400, 'status must be answered or failed');
    requireValue(Array.isArray(citations) && citations.length <= 20, 400, 'At most 20 citations are accepted');
    const normalizedCitations = citations.map(c => {
      requireValue(c && Number.isSafeInteger(c.revision_id), 400, 'Citation needs an integer revision_id');
      return { revision_id: c.revision_id, block_id: text(c.block_id, 'citation block_id', 100),
        quote: text(c.quote, 'citation quote', 20_000) };
    });
    const answerHash = digest({ status, body, citations: normalizedCitations });
    return this.transaction(() => {
      const request = this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
      requireValue(request, 404, 'Request not found');
      requireValue(request.lease_token === lease_token, 409, 'Stale or invalid reservation');
      if (request.answer_hash) {
        requireValue(request.answer_hash === answerHash, 409, 'A different terminal answer is already stored');
        return { duplicate: true, thread: this.thread(request.thread_id) };
      }
      requireValue(request.status === 'reserved' && request.lease_until > this.now(),
        409, 'Reservation expired; poll for a new reservation');
      const thread = this.thread(request.thread_id);
      for (const citation of normalizedCitations) {
        requireValue(citation.revision_id === thread.revision_id, 400, 'Citations must use the supplied document revision');
        const block = this.db.prepare('SELECT * FROM blocks WHERE revision_id=? AND id=?')
          .get(citation.revision_id, citation.block_id);
        requireValue(block && hasQuote(block, citation.quote), 400, 'Citation quote does not match its passage');
      }
      this.db.prepare(`INSERT INTO messages(id,thread_id,role,body,citations,status,created_at)
        VALUES(?,?,'agent',?,?,?,?)`).run(randomUUID(), thread.id, body, JSON.stringify(normalizedCitations), status, this.now());
      this.db.prepare('UPDATE requests SET status=?,answer_hash=? WHERE id=?').run(status, answerHash, id);
      this.db.prepare('UPDATE threads SET unread=1 WHERE id=?').run(thread.id);
      return { duplicate: false, thread: this.thread(thread.id) };
    });
  }
}
