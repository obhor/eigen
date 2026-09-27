import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { rotateNormalizedPoint } from './projection.js';

function clamp01(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function hexToRgb01(hex) {
  if (typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return { r, g, b };
}

function parseCssColorToRgb01(color) {
  if (typeof color !== 'string') return { r: 0, g: 0, b: 0, a: 1 };
  const c = color.trim();

  // rgba(r,g,b,a)
  let m = c.match(/^rgba\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([0-9]*\.?[0-9]+)\s*\)\s*$/i);
  if (m) {
    return {
      r: clamp01(parseInt(m[1], 10) / 255),
      g: clamp01(parseInt(m[2], 10) / 255),
      b: clamp01(parseInt(m[3], 10) / 255),
      a: clamp01(parseFloat(m[4]))
    };
  }

  // rgb(r,g,b)
  m = c.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)\s*$/i);
  if (m) {
    return {
      r: clamp01(parseInt(m[1], 10) / 255),
      g: clamp01(parseInt(m[2], 10) / 255),
      b: clamp01(parseInt(m[3], 10) / 255),
      a: 1
    };
  }

  // #RRGGBB
  if (c.startsWith('#')) {
    const { r, g, b } = hexToRgb01(c);
    return { r, g, b, a: 1 };
  }

  // fallback
  return { r: 0, g: 0, b: 0, a: 1 };
}

// Helvetica/WinAnsi can't encode arbitrary unicode; anything outside Latin-1
// becomes '?' rather than throwing mid-export.
function sanitizeForWinAnsi(text) {
  return String(text).replace(/[^\u0020-\u007e\u00a0-\u00ff]/g, '?');
}

/** Greedy word wrap to maxWidth; explicit newlines always break. */
function wrapText(font, text, size, maxWidth) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function ensureUint8Array(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (Array.isArray(bytes)) return new Uint8Array(bytes);
  if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer);
  throw new Error('exportPdf: originalPdfBytes must be a Uint8Array or number[]');
}

function safeGetPageIndex(pageNumber1Based, pageCount) {
  const idx = (pageNumber1Based | 0) - 1;
  if (idx < 0 || idx >= pageCount) return null;
  return idx;
}

/**
 * Shared export engine.
 *
 * Flattens the tab's AnnotationStore into PDF page content using pdf-lib.
 * This produces a real modified PDF that will open in external viewers.
 *
 * Input:
 *  - originalPdfBytes: Uint8Array | number[]
 *  - store: AnnotationStore for the tab being exported (items live in normalized,
 *    layer-relative, unrotated coords — see src/core/projection.js)
 *  - options: { tabId, rotationDeg }
 */
export async function exportPdf(originalPdfBytes, store, options = {}) {
  const { tabId, rotationDeg = 0 } = options;
  if (!tabId) throw new Error('exportPdf: options.tabId is required');

  const pdfBytes = ensureUint8Array(originalPdfBytes);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const pageCount = pages.length;

  function mapNormToPdfXY(page, nx, ny) {
    const { width, height } = page.getSize();
    // UI normalized space is top-left origin; PDF is bottom-left.
    const x = clamp01(nx) * width;
    const y = (1 - clamp01(ny)) * height;
    return { x, y };
  }

  function drawPolyline(page, points, stroke, thickness, opacity = 1) {
    for (let i = 1; i < points.length; i++) {
      const a = rotateNormalizedPoint(points[i - 1].nx, points[i - 1].ny, rotationDeg);
      const b = rotateNormalizedPoint(points[i].nx, points[i].ny, rotationDeg);

      page.drawLine({
        start: mapNormToPdfXY(page, a.nx, a.ny),
        end: mapNormToPdfXY(page, b.nx, b.ny),
        thickness: Math.max(0.1, thickness || 1),
        color: stroke,
        opacity
      });
    }
  }

  // 1) draw strokes
  for (const [pageNum, paths] of store.byPageMap('draw')) {
    const idx = safeGetPageIndex(pageNum, pageCount);
    if (idx == null) continue;
    const page = pages[idx];

    for (const p of paths) {
      const pts = p.points;
      if (!Array.isArray(pts) || pts.length < 2) continue;
      const { r, g, b } = parseCssColorToRgb01(p.color || '#000000');
      drawPolyline(page, pts, rgb(r, g, b), p.thickness || 3);
    }
  }

  // 2) freehand highlights — drawn as semi-transparent polylines
  for (const [pageNum, paths] of store.byPageMap('highlight')) {
    const idx = safeGetPageIndex(pageNum, pageCount);
    if (idx == null) continue;
    const page = pages[idx];

    for (const p of paths) {
      const pts = p.points;
      if (!Array.isArray(pts) || pts.length < 2) continue;

      // highlight colors are stored as rgba(...)
      const { r, g, b, a } = parseCssColorToRgb01(p.color || '#FFF176');
      // UI uses ~0.25 alpha; keep conservative
      drawPolyline(page, pts, rgb(r, g, b), p.thickness || 12, clamp01(a * 0.5));
    }
  }

  // 3) text highlight rectangles
  for (const [pageNum, items] of store.byPageMap('textHighlight')) {
    const idx = safeGetPageIndex(pageNum, pageCount);
    if (idx == null) continue;
    const page = pages[idx];
    const { width, height } = page.getSize();

    for (const item of items) {
      if (!Array.isArray(item.rects) || item.rects.length === 0) continue;
      const { r, g, b } = parseCssColorToRgb01(item.color || '#FFF176');

      item.rects.forEach(rn => {
        // Rotate four corners in normalized space then bound
        const corners = [
          rotateNormalizedPoint(rn.nx, rn.ny, rotationDeg),
          rotateNormalizedPoint(rn.nx + rn.nw, rn.ny, rotationDeg),
          rotateNormalizedPoint(rn.nx, rn.ny + rn.nh, rotationDeg),
          rotateNormalizedPoint(rn.nx + rn.nw, rn.ny + rn.nh, rotationDeg)
        ];

        const minX = Math.min(...corners.map(c => c.nx));
        const maxX = Math.max(...corners.map(c => c.nx));
        const minY = Math.min(...corners.map(c => c.ny));
        const maxY = Math.max(...corners.map(c => c.ny));

        const x = clamp01(minX) * width;
        const yTop = clamp01(minY);
        const yBottom = clamp01(maxY);

        const rectW = clamp01(maxX) * width - clamp01(minX) * width;
        const rectH = (yBottom - yTop) * height;

        // PDF origin is bottom-left: y = (1 - (yTop + rectHNorm)) * height
        const y = (1 - yBottom) * height;

        page.drawRectangle({
          x,
          y,
          width: rectW,
          height: rectH,
          color: rgb(r, g, b),
          opacity: 0.25,
          borderWidth: 0
        });
      });
    }
  }

  // 4) text boxes — Helvetica, greedy word wrap to the box width.
  // Layout is approximate: no letter-spacing, no box background, padding skipped.
  // fontSize is stored in CSS px, which is 1pt at zoom 1.
  const textBoxes = [...store.byPageMap('text')];
  if (textBoxes.length) {
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    for (const [pageNum, items] of textBoxes) {
      const idx = safeGetPageIndex(pageNum, pageCount);
      if (idx == null) continue;
      const page = pages[idx];
      const { width } = page.getSize();

      for (const item of items) {
        const text = sanitizeForWinAnsi(item.text || '').trim();
        if (!text || !item.rect) continue;

        const size = Math.max(4, item.format?.fontSize || 16);
        const { r, g, b } = parseCssColorToRgb01(item.format?.color || '#000000');
        const anchor = rotateNormalizedPoint(item.rect.nx, item.rect.ny, rotationDeg);
        const { x, y } = mapNormToPdfXY(page, anchor.nx, anchor.ny);
        const maxWidth = Math.max(size, clamp01(item.rect.nw) * width);

        // First line's top sits on the anchor; Helvetica ascender ~0.8em.
        let dy = size * 0.8;
        for (const line of wrapText(font, text, size, maxWidth)) {
          page.drawText(line, { x, y: y - dy, font, size, color: rgb(r, g, b) });
          dy += size * 1.3;
        }
      }
    }
  }

  const out = await pdfDoc.save();
  return out;
}
