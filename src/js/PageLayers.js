/**
 * Per-page canvas registry.
 *
 * Two canvases per annotation layer, found by class — never by DOM order:
 *   draw-layer      z 10 — draw strokes
 *   highlight-layer z  9 — freehand highlights + text-selection rects
 * Text boxes (`.text-annotation-wrapper`, z 100) are plain DOM, not canvases.
 *
 * Canvases are created lazily at first paint: a page with no annotations of a
 * kind carries no canvas for it.
 */

export class PageLayers {
  static canvas(layer, kind) {
    let canvas = layer.querySelector(`.annotation-canvas.${kind}-layer`);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = `annotation-canvas ${kind}-layer`;
      layer.appendChild(canvas);
    }

    // Assigning width/height wipes the context, so only touch it when it changed.
    const w = layer.offsetWidth || layer.clientWidth || 1;
    const h = layer.offsetHeight || layer.clientHeight || 1;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return canvas;
  }

  static get(layer, kind) {
    return layer.querySelector(`.annotation-canvas.${kind}-layer`);
  }

  static clear(layer, kind) {
    const canvas = this.get(layer, kind);
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  /** Whole annotation layer, so canvases and text boxes hide together. */
  static hide(layer, hidden) {
    layer.style.display = hidden ? 'none' : '';
  }
}
