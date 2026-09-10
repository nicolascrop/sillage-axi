// Additive read-only projections. Existing v1 payloads and stored text stay intact.
export const listFields = {
  blocks: ['id', 'kind', 'start_line', 'end_line', 'ordinal', 'revision_id'],
  threads: ['id', 'request_status', 'anchor_status', 'closed', 'unread', 'revision_id', 'block_id', 'created_at'],
};
export function preview(value, full = false) {
  if (typeof value === 'string') {
    let end = full ? value.length : Math.min(value.length, 1000);
    // Do not turn half an astral character into a replacement character on stdout.
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
    return { text: value.slice(0, end), characters: value.length, truncated: end < value.length };
  }
  if (Array.isArray(value)) return value.map(item => previewTree(item, full));
  return value;
}
function previewTree(value, full) {
  if (Array.isArray(value)) return value.map(item => previewTree(item, full));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['source', 'text', 'quote', 'body', 'before', 'after'].includes(key) ? preview(item, full) : previewTree(item, full)]));
}
export function isTruncated(value) {
  return Boolean(value && typeof value === 'object' && (value.truncated === true || Object.values(value).some(isTruncated)));
}
export function inspect(store, relay, { view, id, revision, fields, limit = 100, offset = 0, full = false }) {
  const db = store.db;
  const current = store.revisionId();
  const counts = () => db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(t.unread),0) AS unread, COALESCE(SUM(t.closed),0) AS closed,
    COALESCE(SUM(r.status='waiting'),0) AS waiting,
    COALESCE(SUM(r.status='reserved'),0) AS reserved,
    COALESCE(SUM(r.status='answered'),0) AS answered,
    COALESCE(SUM(r.status='failed'),0) AS failed,
    COALESCE(SUM(NOT EXISTS(SELECT 1 FROM blocks b WHERE b.revision_id=? AND b.id=t.block_id)),0) AS needs_review
    FROM threads t JOIN requests r ON r.thread_id=t.id`).get(current);
  if (view === 'context') return { service: 'available', privacy: 'availability-only; no reader content disclosed' };
  if (view === 'home') return {
    service: 'available', document: current === null ? null : db.prepare('SELECT id,title FROM revisions WHERE id=?').get(current),
    agent: relay.session && relay.session.until > relay.now() ? 'active' : 'unavailable', threads: counts(),
  };
  if (view === 'threads') {
    const rows = db.prepare(`SELECT t.id,t.revision_id,t.block_id,t.closed,t.unread,t.created_at,r.status AS request_status,
      CASE WHEN EXISTS(SELECT 1 FROM blocks b WHERE b.revision_id=? AND b.id=t.block_id) THEN 'matched' ELSE 'needs_review' END AS anchor_status
      FROM threads t JOIN requests r ON r.thread_id=t.id ORDER BY t.created_at DESC,t.rowid DESC LIMIT ? OFFSET ?`).all(current, limit, offset);
    const totals = counts();
    return { revision_id: current, total: totals.total, shown: rows.length, offset, counts: totals,
      threads: project(rows, fields || listFields.threads.slice(0, 4)), ...(totals.total ? {} : { empty: '0 threads in this local report; no questions have been saved.' }) };
  }
  if (view === 'thread') return { thread: previewTree(store.thread(id), full) };
  const revisionId = revision ?? current;
  const row = revisionId === null ? null : db.prepare('SELECT id,title,source,created_at FROM revisions WHERE id=?').get(revisionId);
  if (!row) {
    if (revision !== undefined || view === 'block') throw Object.assign(new Error('Revision not found'), { status: 404 });
    return view === 'blocks' ? { revision_id: null, total: 0, shown: 0, offset, blocks: [], empty: '0 passages: no report has been imported.' }
      : { document: null, empty: '0 reports: import a local Markdown file explicitly.' };
  }
  if (view === 'document') return { document: { id: row.id, title: row.title, created_at: row.created_at, source: preview(row.source, full),
    blocks: db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE revision_id=?').get(row.id).n } };
  if (view === 'blocks') {
    const total = db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE revision_id=?').get(row.id).n;
    const rows = db.prepare('SELECT id,kind,start_line,end_line,ordinal,revision_id FROM blocks WHERE revision_id=? ORDER BY ordinal LIMIT ? OFFSET ?').all(row.id, limit, offset);
    return { revision_id: row.id, total, shown: rows.length, offset, blocks: project(rows, fields || listFields.blocks.slice(0, 4)),
      ...(total ? {} : { empty: '0 semantic passages in this revision.' }) };
  }
  const block = db.prepare('SELECT * FROM blocks WHERE revision_id=? AND id=?').get(row.id, id);
  if (!block) throw Object.assign(new Error('Passage not found in the specified revision'), { status: 404 });
  return { block: previewTree(block, full) };
}
function project(rows, fields) {
  return rows.map(row => Object.fromEntries(fields.map(key => [key, row[key]])));
}
