import assert from "node:assert/strict";
import test from "node:test";

import {
  createWhiteboardPersistencePayload,
  findDuplicateElementIds,
  prepareExcalidrawSkeletons,
  repairSavedSceneTextMetrics,
  sceneIsImageFallback,
  summarizeSceneEdits,
  SUMMARY_MAX_LINE_CHARS,
} from "../src/whiteboard-core.js";

function rect(id, opts = {}) {
  return { id, type: "rectangle", x: 0, y: 0, width: 100, height: 40, ...opts };
}

function boundLabel(id, containerId, text) {
  return { id, type: "text", containerId, text, x: 10, y: 10, width: 80, height: 20 };
}

// ---------------------------------------------------------------------------
// sceneIsImageFallback
// ---------------------------------------------------------------------------

test("sceneIsImageFallback is true only for a non-empty all-image scene", () => {
  assert.equal(sceneIsImageFallback([{ id: "i1", type: "image" }]), true);
  assert.equal(sceneIsImageFallback([{ id: "i1", type: "image" }, rect("r1")]), false);
  assert.equal(sceneIsImageFallback([]), false);
  assert.equal(sceneIsImageFallback(null), false);
});

test("sceneIsImageFallback ignores deleted elements", () => {
  assert.equal(
    sceneIsImageFallback([
      { id: "i1", type: "image" },
      { ...rect("r1"), isDeleted: true },
    ]),
    true,
  );
});

// ---------------------------------------------------------------------------
// findDuplicateElementIds
// ---------------------------------------------------------------------------

test("findDuplicateElementIds finds repeated ids (parallel-edge upstream bug)", () => {
  assert.deepEqual(findDuplicateElementIds([rect("A"), rect("B"), rect("A")]), ["A"]);
  assert.deepEqual(findDuplicateElementIds([rect("A"), rect("B")]), []);
  assert.deepEqual(findDuplicateElementIds([]), []);
});

// ---------------------------------------------------------------------------
// repairSavedSceneTextMetrics
// ---------------------------------------------------------------------------

test("saved text repair only expands metrics", () => {
  const text = {
    id: "label",
    type: "text",
    x: 42,
    y: 17,
    width: 80,
    height: 20,
    text: "Edited label",
    originalText: "Edited label",
    containerId: "box",
    strokeColor: "#e03131",
    boundElements: [{ id: "arrow", type: "arrow" }],
    customData: { userEdit: true },
  };
  const { elements, repaired } = repairSavedSceneTextMetrics([text, rect("box")], {
    measure: () => ({ width: 118.5, height: 24 }),
  });
  assert.equal(repaired, 1);
  assert.deepEqual(elements[0], { ...text, width: 118.5, height: 24 });
  assert.strictEqual(elements[1].id, "box");
});

test("whiteboard persistence payload keeps migration and baseline fields together", () => {
  const scene = { elements: [rect("edited")] };
  const baselineElements = [rect("original")];
  assert.deepEqual(
    createWhiteboardPersistencePayload({ sceneSourceHash: "hash-1", textMetricsVersion: 1, baselineElements }, scene),
    {
      sourceHash: "hash-1",
      textMetricsVersion: 1,
      scene,
      baseline: { elements: baselineElements },
    },
  );
});

// ---------------------------------------------------------------------------
// summarizeSceneEdits
// ---------------------------------------------------------------------------

test("summarizeSceneEdits reports no changes for an identical scene", () => {
  const baseline = [rect("Login"), boundLabel("t1", "Login", "Login page")];
  const { stats, totalChanges, lines } = summarizeSceneEdits(baseline, structuredClone(baseline));
  assert.deepEqual(stats, { added: 0, removed: 0, moved: 0, relabeled: 0, drawn: 0 });
  assert.equal(totalChanges, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /No element changes/);
});

test("summarizeSceneEdits counts moved and resized elements once", () => {
  const baseline = [rect("Auth")];
  const edited = [rect("Auth", { x: 120, y: -35, width: 140 })];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.equal(stats.moved, 1);
  assert.match(lines[0], /Moved by \(120, -35\) and resized by \(40, 0\)/);
  assert.match(lines[0], /\(Auth\)/);
});

test("summarizeSceneEdits ignores sub-epsilon jitter", () => {
  const baseline = [rect("Auth")];
  const edited = [rect("Auth", { x: 1.4, y: -1.2 })];
  assert.equal(summarizeSceneEdits(baseline, edited).totalChanges, 0);
});

test("summarizeSceneEdits reports relabeled bound text against the container", () => {
  const baseline = [rect("Auth"), boundLabel("t1", "Auth", "Valid?")];
  const edited = [rect("Auth"), boundLabel("t1", "Auth", "Session valid?")];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.deepEqual(stats, { added: 0, removed: 0, moved: 0, relabeled: 1, drawn: 0 });
  assert.match(lines[0], /Relabeled rectangle \(Auth\): "Valid\?" -> "Session valid\?"/);
});

test("summarizeSceneEdits reports added arrows with their endpoints", () => {
  const baseline = [rect("Home"), rect("Logout")];
  const edited = [
    ...structuredClone(baseline),
    {
      id: "arrow-1",
      type: "arrow",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      startBinding: { elementId: "Home" },
      endBinding: { elementId: "Logout" },
    },
  ];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.equal(stats.added, 1);
  assert.match(lines[0], /Added arrow \(arrow-1\) from rectangle \(Home\) to rectangle \(Logout\)/);
});

test("summarizeSceneEdits classifies freedraw strokes as drawn", () => {
  const baseline = [rect("A")];
  const edited = [...structuredClone(baseline), { id: "fd1", type: "freedraw", x: 33.7, y: 41.2 }];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.deepEqual(stats, { added: 0, removed: 0, moved: 0, relabeled: 0, drawn: 1 });
  assert.match(lines[0], /Drew a freehand mark near \(34, 41\)/);
});

test("summarizeSceneEdits reports removals, treating isDeleted as removed", () => {
  const baseline = [rect("A"), rect("B")];
  const edited = [rect("A"), { ...rect("B"), isDeleted: true }];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.equal(stats.removed, 1);
  assert.match(lines[0], /Removed rectangle \(B\)/);
});

test("summarizeSceneEdits does not report a new container's label as a separate add", () => {
  const baseline = [rect("A")];
  const edited = [...structuredClone(baseline), rect("New1"), boundLabel("t9", "New1", "Logout")];
  const { stats, lines } = summarizeSceneEdits(baseline, edited);
  assert.equal(stats.added, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Added rectangle "Logout" \(New1\)/);
});

test("summarizeSceneEdits bounds output lines and clamps line length", () => {
  const baseline = [];
  const edited = Array.from({ length: 60 }, (_, i) => rect(`el-${i}`, { text: "x".repeat(500) }));
  const { lines, stats } = summarizeSceneEdits(baseline, edited, { maxLines: 10 });
  assert.equal(stats.added, 60);
  assert.equal(lines.length, 11);
  assert.match(lines[10], /and 50 more changes/);
  assert.ok(lines[0].length <= SUMMARY_MAX_LINE_CHARS);
});


test('preflight preserves parallel edges and their binding targets before materialization', () => {
  const original = [
    rect('A'),
    rect('B'),
    { id: 'A_B', type: 'arrow', start: { id: 'A' }, end: { id: 'B' } },
    { id: 'A_B', type: 'arrow', start: { id: 'A' }, end: { id: 'B' } },
  ];
  const snapshot = structuredClone(original);
  const prepared = prepareExcalidrawSkeletons(original);
  const materialized = new Map(prepared.map((element) => [element.id, element]));
  const edges = [...materialized.values()].filter((element) => element.type === 'arrow');
  assert.equal(edges.length, 2);
  assert.deepEqual(edges.map((element) => element.id), ['A_B', 'A_B__duplicate_1']);
  assert.deepEqual(edges.map((element) => [element.start.id, element.end.id]), [['A', 'B'], ['A', 'B']]);
  assert.deepEqual(original, snapshot);
});

test('font-aware conversion materializes only after font loading, then again with actual metrics', async () => {
  const { convertExcalidrawSkeletonsAfterFontsLoad } = await import('../src/whiteboard-core.js');
  let loaded = false;
  const calls = [];
  const result = await convertExcalidrawSkeletonsAfterFontsLoad([{ id: 'text' }], {
    convert: skeletons => { calls.push(loaded ? 'real metrics' : 'fallback metrics'); return skeletons.map(e => ({ ...e, width: loaded ? 100 : 50 })); },
    loadFonts: async elements => { assert.equal(elements[0].width, 50); loaded = true; calls.push('fonts ready'); },
  });
  assert.deepEqual(calls, ['fallback metrics', 'fonts ready', 'real metrics']);
  assert.equal(result[0].width, 100);
});

test('edit summaries use authored labels rather than layout-inserted broken-word wrapping', () => {
  const baseline = [rect('B'), { ...boundLabel('label', 'B', 'Read\ny?'), originalText: 'Ready?' }];
  const edited = [rect('B'), { ...boundLabel('label', 'B', 'Pleas\ne add a safet\ny check'), originalText: 'Please add a safety check' }];
  const summary = summarizeSceneEdits(baseline, edited);
  assert.equal(summary.stats.relabeled, 1);
  assert.equal(summary.lines[0], 'Relabeled rectangle (B): "Ready?" -> "Please add a safety check"');
});
