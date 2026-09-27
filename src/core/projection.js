/**
 * Annotation coordinate boundary.
 *
 * Stored geometry is normalized (0..1), relative to a page's annotation layer,
 * *unrotated*. Pixel space is what the DOM and the canvases use. Rotation is
 * applied here and nowhere else — callers hold one PageProjector per page per
 * paint pass instead of threading `rotationDeg` through every method.
 */

/**
 * Rotate a normalized point by clockwise degrees (0/90/180/270).
 */
export function rotateNormalizedPoint(nx, ny, rotationDeg) {
  const rot = ((rotationDeg % 360) + 360) % 360;
  switch (rot) {
    case 90:
      return { nx: 1 - ny, ny: nx };
    case 180:
      return { nx: 1 - nx, ny: 1 - ny };
    case 270:
      return { nx: ny, ny: 1 - nx };
    default:
      return { nx, ny };
  }
}

/**
 * Layer size in CSS pixels, tolerant of pre-layout (0) measurements.
 */
export function sizeOf(el) {
  return {
    w: el?.offsetWidth || el?.clientWidth || parseFloat(el?.style?.width) || 1,
    h: el?.offsetHeight || el?.clientHeight || parseFloat(el?.style?.height) || 1,
  };
}

export class PageProjector {
  constructor(layer, rotationDeg = 0) {
    this.layer = layer;
    this.rotationDeg = rotationDeg;
    const { w, h } = sizeOf(layer);
    this.w = w;
    this.h = h;
  }

  /** Pointer event → pixels relative to the layer. */
  localXY(e) {
    const rect = this.layer.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /**
   * Unrotated page size in px. At 90/270 the layer box is the page box swapped,
   * so normalized-to-px sizes must use these, not w/h.
   */
  pageSize() {
    const swap = (((this.rotationDeg % 360) + 360) % 360) % 180 !== 0;
    return swap ? { w: this.h, h: this.w } : { w: this.w, h: this.h };
  }

  /** Layer pixels → normalized, unrotated. Inverse of toScreenPoint. */
  toNormPoint(x, y) {
    const p = rotateNormalizedPoint(x / this.w, y / this.h, -this.rotationDeg);
    return { nx: p.nx, ny: p.ny };
  }

  /** Rotate corners, return their bounding box. Inverse of toScreenRect. */
  toNormRect({ x, y, w, h }) {
    const corners = [
      this.toNormPoint(x, y),
      this.toNormPoint(x + w, y),
      this.toNormPoint(x, y + h),
      this.toNormPoint(x + w, y + h)
    ];
    const xs = corners.map(p => p.nx);
    const ys = corners.map(p => p.ny);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { nx: minX, ny: minY, nw: Math.max(...xs) - minX, nh: Math.max(...ys) - minY };
  }

  toScreenPoint({ nx, ny }) {
    const r = rotateNormalizedPoint(nx, ny, this.rotationDeg);
    return { x: r.nx * this.w, y: r.ny * this.h };
  }

  /** Rotate corners, return their bounding box. */
  toScreenRect(rect) {
    const corners = [
      { nx: rect.nx, ny: rect.ny },
      { nx: rect.nx + rect.nw, ny: rect.ny },
      { nx: rect.nx, ny: rect.ny + rect.nh },
      { nx: rect.nx + rect.nw, ny: rect.ny + rect.nh }
    ].map(p => rotateNormalizedPoint(p.nx, p.ny, this.rotationDeg));

    const minX = Math.min(...corners.map(p => p.nx));
    const maxX = Math.max(...corners.map(p => p.nx));
    const minY = Math.min(...corners.map(p => p.ny));
    const maxY = Math.max(...corners.map(p => p.ny));

    return { x: minX * this.w, y: minY * this.h, w: (maxX - minX) * this.w, h: (maxY - minY) * this.h };
  }

  /**
   * Stored path → pixel path. Legacy pixel-based paths (pre-normalization) are
   * returned as-is.
   */
  toScreenPath(pathData) {
    if (!pathData || !Array.isArray(pathData.points) || pathData.points.length === 0) return pathData;
    const first = pathData.points[0];
    const isNormalized = pathData.normalized || (first && typeof first.nx === 'number');
    if (!isNormalized) return pathData; // legacy pixel coords
    return {
      ...pathData,
      points: pathData.points.map(p => this.toScreenPoint(p))
    };
  }
}
