// SQLite adaptation of Lavish's sidecars: immutable versions, exact report/block
// provenance, optimistic concurrency and bounded feedback through ordinary v1 turns.
import { createHash } from 'node:crypto';
import { Problem, text } from './store.js';
import { findDuplicateElementIds, isTextMetricsExpansion, sanitizeWhiteboardAppState, sceneIsImageFallback, summarizeSceneEdits } from './whiteboard-core.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireValue = (ok, status, message) => { if (!ok) throw new Problem(status, message); };
const types = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'arrow', 'line', 'freedraw', 'image', 'frame', 'magicframe']);
function elements(value) {
  requireValue(Array.isArray(value) && value.length <= 5000, 400, 'Scene requires at most 5,000 elements');
  const result = value.map(e => {
    requireValue(e && typeof e === 'object' && types.has(e.type), 400, 'Unsupported scene element');
    text(e.id, 'element id', 200);
    for (const key of ['x', 'y', 'width', 'height']) requireValue(Number.isFinite(e[key]) && Math.abs(e[key]) <= 1e7, 400, 'Invalid element geometry');
    if (e.text !== undefined) requireValue(typeof e.text === 'string' && e.text.length <= 20_000, 400, 'Scene text exceeds 20,000 characters');
    if (e.points !== undefined) requireValue(Array.isArray(e.points) && e.points.length <= 20_000 && e.points.every(p => Array.isArray(p) && p.length === 2 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 1e7)), 400, 'Invalid drawing points');
    // No clickable navigation, embeddables, arbitrary metadata or remote file paths.
    const { link, customData, ...safe } = e;
    return safe;
  });
  requireValue(!findDuplicateElementIds(result).length, 400, 'Duplicate element IDs');
  return result;
}
export function validateScene(scene) {
  requireValue(scene && typeof scene === 'object', 400, 'Scene required');
  const files = scene.files || {};
  requireValue(typeof files === 'object' && !Array.isArray(files) && Object.keys(files).length <= 128, 400, 'At most 128 local images');
  const safeFiles = Object.fromEntries(Object.entries(files).map(([id, f]) => {
    text(id, 'file id', 200);
    requireValue(f && /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(f.dataURL), 400, 'Images must be embedded data, never remote URLs');
    return [id, { id, dataURL: f.dataURL, mimeType: f.dataURL.slice(5, f.dataURL.indexOf(';')), created: Number(f.created) || 0 }];
  }));
  const raw = sanitizeWhiteboardAppState(scene.appState);
  const appState = {};
  for (const key of ['scrollX', 'scrollY']) if (Number.isFinite(raw[key])) appState[key] = raw[key];
  if (Number.isFinite(raw.zoom?.value) && raw.zoom.value >= 0.1 && raw.zoom.value <= 30) appState.zoom = { value: raw.zoom.value };
  return { elements: elements(scene.elements), files: safeFiles, appState };
}
export class Whiteboards {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS whiteboard_versions (
      id INTEGER PRIMARY KEY, revision_id INTEGER NOT NULL, block_id TEXT NOT NULL,
      source_hash TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
      text_metrics_version INTEGER NOT NULL, scene TEXT NOT NULL, baseline TEXT NOT NULL, created_at INTEGER NOT NULL,
      FOREIGN KEY (revision_id, block_id) REFERENCES blocks(revision_id,id)
    );
    CREATE INDEX IF NOT EXISTS whiteboard_history ON whiteboard_versions(revision_id,block_id,id);
    CREATE TABLE IF NOT EXISTS whiteboard_operations (
      operation_key TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, snapshot_id INTEGER NOT NULL REFERENCES whiteboard_versions(id)
    );
    CREATE TABLE IF NOT EXISTS whiteboard_lineage (
      snapshot_id INTEGER PRIMARY KEY REFERENCES whiteboard_versions(id), parent_id INTEGER NOT NULL REFERENCES whiteboard_versions(id)
    );`);
  }
  diagram(revision, blockId) {
    requireValue(Number.isSafeInteger(revision) && revision > 0, 400, 'revision_id must be a positive integer');
    const doc = this.store.revision(revision);
    const diagram = doc.diagrams.find(d => d.block_id === blockId);
    requireValue(diagram, 404, 'Mermaid diagram not found in the specified revision');
    return { ...diagram, index: doc.diagrams.indexOf(diagram), revision_id: doc.id };
  }
  decode(row) {
    return row ? { id: row.id, revision_id: row.revision_id, block_id: row.block_id, source_hash: row.source_hash,
      text_metrics_version: row.text_metrics_version, created_at: row.created_at,
      derived_from: this.db.prepare('SELECT parent_id FROM whiteboard_lineage WHERE snapshot_id=?').get(row.id)?.parent_id ?? null,
      scene: JSON.parse(row.scene), baseline: JSON.parse(row.baseline) } : null;
  }
  latest(revision, blockId) {
    return this.decode(this.db.prepare('SELECT * FROM whiteboard_versions WHERE revision_id=? AND block_id=? ORDER BY id DESC LIMIT 1').get(revision, blockId));
  }
  load(revision, blockId) {
    const diagram = this.diagram(revision, blockId);
    // The renderer carries this ID only through exact, unambiguous, continuous
    // source matches. Never fall back to diagram position or a fuzzy source match.
    const saved = this.latest(revision, blockId) || this.decode(this.db.prepare(`SELECT * FROM whiteboard_versions
      WHERE revision_id<? AND block_id=? AND source_hash=? ORDER BY id DESC LIMIT 1`).get(revision, blockId, diagram.source_hash));
    return { diagram, saved };
  }
  snapshot(id) {
    requireValue(Number.isSafeInteger(id) && id > 0, 400, 'snapshot_id must be a positive integer');
    const row = this.db.prepare('SELECT * FROM whiteboard_versions WHERE id=?').get(id);
    requireValue(row, 404, 'Whiteboard snapshot not found');
    return this.decode(row);
  }
  history() {
    return this.db.prepare(`SELECT id,revision_id,block_id,source_hash,created_at FROM whiteboard_versions
      WHERE id IN (SELECT MAX(id) FROM whiteboard_versions GROUP BY revision_id,block_id)
      ORDER BY id DESC LIMIT 100`).all();
  }
  save(revision, blockId, input) {
    const diagram = this.diagram(revision, blockId);
    text(input.operation_key, 'operation_key', 100);
    requireValue(input.source_hash === diagram.source_hash, 409, 'Source hash does not match this exact diagram revision; never merge stale scenes');
    requireValue(input.expected_version === null || Number.isSafeInteger(input.expected_version), 400, 'expected_version must be an integer or null');
    const scene = validateScene(input.scene);
    const baseline = { elements: elements(input.baseline?.elements) };
    requireValue(Number.isSafeInteger(input.text_metrics_version) && input.text_metrics_version >= 0 && input.text_metrics_version <= 1, 400, 'Unsupported text metrics version');
    const payloadHash = hash({ revision, blockId, ...input });
    requireValue(JSON.stringify(input).length <= 20_000_000, 413, 'Whiteboard exceeds 20 MB');
    return this.store.transaction(() => {
      const replay = this.db.prepare('SELECT * FROM whiteboard_operations WHERE operation_key=?').get(input.operation_key);
      if (replay) {
        requireValue(replay.payload_hash === payloadHash, 409, 'operation_key reused with different scene');
        return this.snapshot(replay.snapshot_id);
      }
      const previous = this.latest(revision, blockId);
      requireValue((previous?.id ?? null) === input.expected_version, 409, 'Whiteboard changed in another editor. Reload to inspect saved history; your pending edits have not overwritten it.');
      const parent = previous || (input.derived_from ? this.snapshot(input.derived_from) : null);
      requireValue(!parent || (parent.block_id === blockId && parent.source_hash === diagram.source_hash && parent.revision_id <= revision), 409, 'Cannot inherit an unmatched diagram');
      requireValue(!parent || input.text_metrics_version >= parent.text_metrics_version, 409, 'Text metrics version cannot go backwards');
      const metricsRepair = parent && input.text_metrics_version > parent.text_metrics_version && isTextMetricsExpansion(parent.baseline.elements, baseline.elements);
      requireValue(!parent || hash(parent.baseline) === hash(baseline) || metricsRepair, 409, 'The conversion baseline is immutable');
      // View-only polls do not inflate scene history, but their operation keys
      // still reconcile an uncertain acknowledgement after subsequent edits.
      if (previous && hash(previous.scene) === hash(scene) && !metricsRepair) {
        this.db.prepare('INSERT INTO whiteboard_operations VALUES(?,?,?)').run(input.operation_key, payloadHash, previous.id);
        return previous;
      }
      const id = Number(this.db.prepare(`INSERT INTO whiteboard_versions
        (revision_id,block_id,source_hash,operation_key,payload_hash,text_metrics_version,scene,baseline,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(revision, blockId, diagram.source_hash, input.operation_key, payloadHash,
        input.text_metrics_version, JSON.stringify(scene), JSON.stringify(baseline), this.store.now()).lastInsertRowid);
      this.db.prepare('INSERT INTO whiteboard_operations VALUES(?,?,?)').run(input.operation_key, payloadHash, id);
      const origin = previous?.derived_from || (parent?.revision_id < revision ? parent.id : null);
      if (origin) this.db.prepare('INSERT INTO whiteboard_lineage VALUES(?,?)').run(id, origin);
      return this.snapshot(id);
    });
  }
  feedback(revision, blockId, { snapshot_id, note = '', client_key }) {
    const diagram = this.diagram(revision, blockId);
    const saved = this.snapshot(snapshot_id);
    requireValue(saved.revision_id === revision && saved.block_id === blockId && saved.source_hash === diagram.source_hash, 409, 'Feedback snapshot belongs to another diagram or revision');
    requireValue(typeof note === 'string' && note.length <= 2000, 400, 'Feedback note exceeds 2,000 characters');
    const summary = summarizeSceneEdits(saved.baseline.elements, saved.scene.elements);
    const whiteboard = { type: 'excalidraw-scene', revision_id: revision, block_id: blockId,
      source_hash: saved.source_hash, snapshot_id: saved.id, derived_from: saved.derived_from, image_fallback: sceneIsImageFallback(saved.baseline.elements),
      summary_lines: summary.lines, stats: summary.stats,
      delivery: 'Bounded text/geometry summary only, not scene JSON or pixels. Style-only edits and freehand meaning may be absent. Ask the reader if unclear. Mermaid remains authoritative; no scene-to-source conversion.' };
    return this.store.question({ revision_id: revision, block_id: blockId, quote: diagram.source.slice(0, 2000),
      question: `Whiteboard feedback (revision ${revision})${note.trim() ? ': ' + note.trim() : '.'}`,
      client_key }, undefined, whiteboard);
  }
}
