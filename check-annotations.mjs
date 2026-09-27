/**
 * Manual check for annotation coordinate round-trips (C1/C2 fixes).
 * Run: node check-annotations.mjs
 */
import assert from 'assert';
import { PageProjector, rotateNormalizedPoint } from './src/core/projection.js';
import { EraserEngine } from './src/js/EraserEngine.js';
import { AnnotationStore } from './src/js/AnnotationStore.js';
import { AnnotationManager } from './src/js/AnnotationManager.js';

const layer = { offsetWidth: 100, offsetHeight: 200 };
const pixelRect = { x: 25, y: 50, w: 10, h: 20 };
const proj = (rotationDeg = 0) => new PageProjector(layer, rotationDeg);

// 1. round-trip: pixel -> normalized -> pixel
const norm = proj().toNormRect(pixelRect);
for (const [k, want] of Object.entries({ nx: 0.25, ny: 0.25, nw: 0.1, nh: 0.1 })) {
  assert.ok(Math.abs(norm[k] - want) < 1e-9, `${k}: ${norm[k]}`);
}
const back = proj().toScreenRect(norm);
for (const k of ['x', 'y', 'w', 'h']) {
  assert.ok(Math.abs(back[k] - pixelRect[k]) < 1e-9, `${k}: ${back[k]}`); // float round-trip
}

// 2. rotation is applied on read: top-left rect under 90deg lands top-right
assert.deepStrictEqual(proj(90).toScreenRect({ nx: 0, ny: 0, nw: 0.5, nh: 0.25 }), { x: 75, y: 0, w: 25, h: 100 });
assert.deepStrictEqual(rotateNormalizedPoint(0, 0, 90), { nx: 1, ny: 0 });

// 2b. pointer -> normalized -> pointer is the identity at every rotation
const rotatedLayer = { offsetWidth: 200, offsetHeight: 100 }; // 90deg view of a 100x200 page
for (const deg of [0, 90, 180, 270]) {
  const p = new PageProjector(rotatedLayer, deg);
  for (const [x, y] of [[0, 0], [37, 61], [200, 100]]) {
    const back = p.toScreenPoint(p.toNormPoint(x, y));
    assert.ok(Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9, `${deg}deg ${x},${y} -> ${back.x},${back.y}`);
  }
}

// 3. eraser hits a projected stored rect, misses a distant one (the C1 regression)
const eraser = new EraserEngine();
const hit = AnnotationManager.prototype.eraserIntersectsRect;
const ctx = { eraserEngine: { getRadius: () => 10 } };
const stored = proj().toNormRect(pixelRect);
assert.strictEqual(hit.call(ctx, 30, 60, proj().toScreenRect(stored)), true);
assert.strictEqual(hit.call(ctx, 90, 190, proj().toScreenRect(stored)), false);

// 4. eraser on a stored (normalized) freehand path (the C2 regression)
const storedPath = {
  points: [[20, 40], [80, 160]].map(([x, y]) => proj().toNormPoint(x, y)),
  normalized: true,
};
assert.strictEqual(eraser.erasePaths([storedPath], 50, 100).erasedPaths.length, 0,
  'stored normalized points must not hit as pixels');

const pixelPath = proj().toScreenPath(storedPath);
assert.deepStrictEqual(pixelPath.points, [{ x: 20, y: 40 }, { x: 80, y: 160 }]);
assert.strictEqual(eraser.erasePaths([pixelPath], 50, 100).erasedPaths.length, 1);
assert.strictEqual(eraser.erasePaths([pixelPath], 10, 190).survivingPaths.length, 1);

// 5. store: page/kind scoping, id assignment, unscoped removeWhere stays safe
const store = new AnnotationStore();
const d1 = store.add({ kind: 'draw', page: 1, points: [{ nx: 0, ny: 0 }] });
const h1 = store.add({ kind: 'highlight', page: 1, points: [] });
store.add({ kind: 'draw', page: 2, points: [] });
assert.strictEqual(d1.id, 'a1');
assert.deepStrictEqual(store.forPage(1, 'draw'), [d1]);
assert.strictEqual(store.byPageMap('draw').get(2).length, 1);
store.removeWhere(item => item === d1); // must not take h1 with it
assert.deepStrictEqual(store.forPage(1, 'draw'), []);
assert.strictEqual(store.get(h1.id), h1);

// 6. store: update / remove / JSON round-trip
store.update(h1.id, { color: '#abc123' });
assert.strictEqual(store.get(h1.id).color, '#abc123');
assert.strictEqual(store.update('nope', { color: '#000' }), null);

const snapshot = store.toJSON();
const restored = new AnnotationStore();
restored.fromJSON(snapshot);
assert.deepStrictEqual(restored.toJSON(), snapshot);
assert.strictEqual(restored.add({ kind: 'draw', page: 3 }).id, 'a4', 'id counter must continue after restore');

store.remove(h1.id);
assert.strictEqual(store.get(h1.id), undefined);

console.log('ok: annotation coordinate round-trips + eraser hit-testing + store scoping');
