/**
 * Per-tab annotation model.
 *
 * One flat Map of items, one coordinate space: normalized (0..1), relative to the
 * page's annotation layer, *unrotated*. Pixel conversion lives in PageProjector.
 *
 * Item shapes:
 *   {kind:'draw',          page, points:[{nx,ny}], color:'#…', thickness}
 *   {kind:'highlight',     page, points:[{nx,ny}], color:'rgba(…)', thickness}
 *   {kind:'textHighlight', page, rects:[{nx,ny,nw,nh}], color:'#hex'}
 *   {kind:'text',          page, rect:{nx,ny,nw}, text, format:{…}}
 */
export class AnnotationStore {
  constructor() {
    this.items = new Map();
    this._next = 1;
  }

  add(item) {
    const id = `a${this._next++}`;
    const stored = { ...item, id };
    this.items.set(id, stored);
    return stored;
  }

  get(id) {
    return this.items.get(id);
  }

  update(id, patch) {
    const item = this.items.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    return item;
  }

  remove(id) {
    return this.items.delete(id);
  }

  removeWhere(pred) {
    for (const [id, item] of this.items) {
      if (pred(item)) this.items.delete(id);
    }
  }

  // ponytail: flat scan; index per kind/page only if a page ever holds thousands.
  forPage(page, kind) {
    const out = [];
    for (const item of this.items.values()) {
      if (item.page === page && item.kind === kind) out.push(item);
    }
    return out;
  }

  byPageMap(kind) {
    const byPage = new Map();
    for (const item of this.items.values()) {
      if (item.kind !== kind) continue;
      if (!byPage.has(item.page)) byPage.set(item.page, []);
      byPage.get(item.page).push(item);
    }
    return byPage;
  }

  toJSON() {
    return [...this.items.values()];
  }

  fromJSON(items) {
    this.items.clear();
    this._next = 1;
    for (const item of items || []) {
      const id = item?.id || `a${this._next}`;
      this.items.set(id, { ...item, id });
      const n = parseInt(String(id).slice(1), 10);
      if (Number.isFinite(n) && n >= this._next) this._next = n + 1;
    }
  }

  clear() {
    this.items.clear();
  }
}
