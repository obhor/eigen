/**
 * Round-trip check for the export engine (audit item 9):
 * AnnotationStore → exportPdf → parse with pdf.js (a different parser than
 * pdf-lib, which wrote it) → assert pages, geometry, colors and opacity.
 * Run: node check-export-roundtrip.mjs
 */
import assert from 'assert';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { exportPdf } from './src/core/exportPdf.js';
import { AnnotationStore } from './src/js/AnnotationStore.js';

const W = 300;
const H = 400;
const TOL = 0.01;

const base = await (async () => {
  const doc = await PDFDocument.create();
  doc.addPage([W, H]);
  doc.addPage([W, H]);
  return doc.save();
})();

function annotations() {
  const store = new AnnotationStore();
  store.add({
    kind: 'draw', page: 1, color: '#ff0000', thickness: 4,
    points: [{ nx: 0.1, ny: 0.1 }, { nx: 0.5, ny: 0.5 }, { nx: 0.9, ny: 0.1 }],
  });
  store.add({
    kind: 'highlight', page: 1, color: 'rgba(255, 241, 118, 0.5)', thickness: 12,
    points: [{ nx: 0.2, ny: 0.8 }, { nx: 0.6, ny: 0.8 }],
  });
  store.add({
    kind: 'textHighlight', page: 2, color: '#7cff6b',
    rects: [{ nx: 0.25, ny: 0.25, nw: 0.5, nh: 0.1 }],
  });
  store.add({
    kind: 'text', page: 1, text: 'Hello Eigen',
    rect: { nx: 0.3, ny: 0.4, nw: 0.4 },
    format: { fontSize: 16, color: '#0000ff' },
  });
  store.add({
    kind: 'text', page: 2, text: 'alpha beta gamma delta epsilon zeta',
    rect: { nx: 0.1, ny: 0.1, nw: 0.2 },
    format: { fontSize: 12, color: '#000000' },
  });
  return store;
}

async function parse(bytes) {
  return pdfjsLib.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
}

/**
 * Painted paths in op order: { paint: 'stroke'|'fill', color: [r,g,b], bbox: [x0,y0,x1,y1] }.
 * pdf-lib emits rectangles as a translation `transform` plus a local-space
 * path, so the walker tracks the current translation (and save/restore stack).
 */
function paintedPaths(ops) {
  const out = [];
  let strokeColor = null;
  let fillColor = null;
  let pending = null;
  const identity = [1, 0, 0, 1, 0, 0];
  let ctm = identity;
  const stack = [];
  ops.fnArray.forEach((fn, i) => {
    const args = ops.argsArray[i];
    if (fn === pdfjsLib.OPS.save) stack.push(ctm);
    if (fn === pdfjsLib.OPS.restore) ctm = stack.pop() ?? identity;
    if (fn === pdfjsLib.OPS.transform) {
      const [a, b, c, d, e, f] = args;
      const [a1, b1, c1, d1, e1, f1] = ctm;
      ctm = [
        a1 * a + b1 * c, a1 * b + b1 * d,
        c1 * a + d1 * c, c1 * b + d1 * d,
        e1 * a + f1 * c + e, e1 * b + f1 * d + f,
      ];
      assert.ok(ctm[0] === 1 && ctm[1] === 0 && ctm[2] === 0 && ctm[3] === 1,
        `paintedPaths: unexpected scaled/rotated CTM [${ctm}]`);
    }
    if (fn === pdfjsLib.OPS.setStrokeRGBColor) strokeColor = Array.from(args);
    if (fn === pdfjsLib.OPS.setFillRGBColor) fillColor = Array.from(args);
    if (fn === pdfjsLib.OPS.constructPath) {
      const [x0, y0, x1, y1] = args[2];
      pending = { bbox: [x0 + ctm[4], y0 + ctm[5], x1 + ctm[4], y1 + ctm[5]] };
    }
    if (pending && fn === pdfjsLib.OPS.stroke) { out.push({ ...pending, paint: 'stroke', color: strokeColor }); pending = null; }
    if (pending && (fn === pdfjsLib.OPS.fill || fn === pdfjsLib.OPS.fillStroke)) { out.push({ ...pending, paint: 'fill', color: fillColor }); pending = null; }
  });
  return out;
}

function assertBBox(paths, { paint, color }, expected, label) {
  const sameColor = paths.filter(p => p.paint === paint && p.color && color.every((c, i) => Math.abs(p.color[i] - c) <= 1));
  const match = sameColor.filter(p => expected.every((want, i) => Math.abs(p.bbox[i] - want) < TOL));
  assert.strictEqual(match.length, 1,
    `${label}: expected exactly 1 ${paint} rgb ${color} at [${expected}], got ${match.length} of ${sameColor.length} same-color paths`);
}

// 1. empty store: export succeeds, page count survives, nothing is painted
{
  const bare = await exportPdf(base, new AnnotationStore(), { tabId: 't' });
  const pdf = await parse(bare);
  assert.strictEqual(pdf.numPages, 2);
  const ops = await (await pdf.getPage(1)).getOperatorList();
  assert.strictEqual(paintedPaths(ops).length, 0);
}

// 2. geometry per rotation. Store is unrotated; export rotates before mapping
// to PDF points. Expectations are hand-computed from the rotation convention.
const cases = {
  0: {
    draw: [[30, 200, 150, 360], [150, 200, 270, 360]],
    highlight: [60, 80, 180, 80],
    textHighlight: [75, 260, 225, 300],
  },
  90: {
    draw: [[150, 200, 270, 360], [150, 40, 270, 200]],
    highlight: [60, 160, 60, 320],
    textHighlight: [195, 100, 225, 300],
  },
  180: {
    draw: [[150, 40, 270, 200], [30, 40, 150, 200]],
    highlight: [120, 320, 240, 320],
    textHighlight: [75, 100, 225, 140],
  },
  270: {
    draw: [[30, 40, 150, 200], [30, 200, 150, 360]],
    highlight: [240, 80, 240, 240],
    textHighlight: [75, 100, 105, 300],
  },
};

for (const [deg, want] of Object.entries(cases)) {
  const out = await exportPdf(base, annotations(), { tabId: 't', rotationDeg: Number(deg) });
  const pdf = await parse(out);
  assert.strictEqual(pdf.numPages, 2, `${deg}deg: page count`);

  const p1 = paintedPaths(await (await pdf.getPage(1)).getOperatorList());
  const strokes = p1.filter(p => p.paint === 'stroke');
  assert.strictEqual(strokes.length, 3, `${deg}deg: 2 draw lines + 1 highlight line`);
  assertBBox(strokes, { paint: 'stroke', color: [255, 0, 0] }, want.draw[0], `${deg}deg draw line 1`);
  assertBBox(strokes, { paint: 'stroke', color: [255, 0, 0] }, want.draw[1], `${deg}deg draw line 2`);
  assertBBox(strokes, { paint: 'stroke', color: [255, 241, 118] }, want.highlight, `${deg}deg highlight line`);

  // highlight is drawn at half the stored alpha
  const p1ops = await (await pdf.getPage(1)).getOperatorList();
  const alphas = [];
  p1ops.fnArray.forEach((fn, i) => {
    // pdf-lib emits 'CA' (stroke alpha); accept the fill key too.
    if (fn === pdfjsLib.OPS.setGState) alphas.push(...[].concat(...p1ops.argsArray[i]).filter(a => Array.isArray(a) && /^cA$/i.test(a[0])).map(a => a[1]));
  });
  assert.ok(alphas.includes(0.25), `${deg}deg: highlight opacity 0.5 * 0.5 = 0.25, got ${alphas}`);

  const p2 = paintedPaths(await (await pdf.getPage(2)).getOperatorList());
  assertBBox(p2, { paint: 'fill', color: [124, 255, 107] }, want.textHighlight, `${deg}deg textHighlight rect`);
}

// 3. text boxes are flattened as real text and rotate with the page
{
  // anchor (0.3, 0.4) at size 16 → baseline = (1 - ny) * 400 - 0.8 * 16
  const want = {
    0: { x: 90, y: 227.2 },
    90: { x: 180, y: 267.2 },
    180: { x: 210, y: 147.2 },
    270: { x: 120, y: 107.2 },
  };
  for (const [deg, expect] of Object.entries(want)) {
    const out = await exportPdf(base, annotations(), { tabId: 't', rotationDeg: Number(deg) });
    const items = (await (await (await parse(out)).getPage(1)).getTextContent()).items;
    assert.strictEqual(items.length, 1, `${deg}deg: one text item`);
    assert.strictEqual(items[0].str, 'Hello Eigen');
    const [fontSize, , , , x, y] = items[0].transform;
    assert.ok(Math.abs(fontSize - 16) < 0.01, `${deg}deg: font size ${fontSize}`);
    assert.ok(Math.abs(x - expect.x) < 1, `${deg}deg: x ${x} != ${expect.x}`);
    assert.ok(Math.abs(y - expect.y) < 2, `${deg}deg: baseline ${y} != ${expect.y}`);
  }

  // text wider than the box wraps; lines share x and stack downward
  // (pdf.js adds empty hasEOL marker items between lines — skip those)
  const out = await exportPdf(base, annotations(), { tabId: 't' });
  const lines = (await (await (await parse(out)).getPage(2)).getTextContent()).items
    .filter(i => i.str.trim() !== '');
  assert.ok(lines.length >= 2, `expected ≥2 wrapped lines, got ${lines.length}`);
  assert.strictEqual(lines.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim(),
    'alpha beta gamma delta epsilon zeta');
  const xs = lines.map(i => i.transform[4]);
  const ys = lines.map(i => i.transform[5]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 0.01, `wrapped lines share x: ${xs}`);
  assert.ok(ys.every((y, i) => i === 0 || y < ys[i - 1]), `wrapped lines go down: ${ys}`);
}

console.log('ok: export round-trip — pages, colors, opacity, rotated geometry, text layout');
