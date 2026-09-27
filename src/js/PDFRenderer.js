import * as pdfjsLib from 'pdfjs-dist';
import { exportPdf } from '../core/exportPdf.js';
import { webSave } from '../platform/webSave.js';
import { electronSave } from '../platform/electronSave.js';

// Set up PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

export class PDFRenderer {
  constructor(app) {
    this.app = app;
    this.documents = new Map();
    this.pageElements = new Map();
    this.originalPdfBytes = new Map();
    this.pageSizes = new Map();
    this.viewer = document.getElementById('pdf-viewer');
    this.container = document.getElementById('pdf-container');
    this.tabViewers = new Map();
    this._renderTokens = new Map();

    this.setupObserver();
    this.setupScrollListener();
  }

  async loadDocument(data, tabId) {
    try {
      // Store authoritative original bytes for this tab (defensive copy).
      const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
      this.originalPdfBytes.set(tabId, bytes);

      // Best-effort: also keep on tab (legacy callers). Do not assume it stays intact.
      const tab = this.app?.tabManager?.getTab?.(tabId);
      if (tab) tab.fileData = bytes;

      const loadingTask = pdfjsLib.getDocument({ data: bytes });
      const pdfDoc = await loadingTask.promise;

      // A new document in this tab starts with a clean annotation store.
      this.app.annotationManager?.storeFor?.(tabId).clear();

      this.documents.set(tabId, pdfDoc);
      this.pageElements.set(tabId, []);

      // One pass over the page proxies; every later zoom/rotate/layout sizes
      // pages from this cache instead of calling back into pdf.js.
      await this.buildPageSizes(pdfDoc, tabId);

      // Update page count immediately after document is loaded
      this.app.updateUI();

      await this.renderDocument(tabId);

      return pdfDoc;
    } catch (error) {
      console.error('Error loading PDF:', error);
      alert('Error loading PDF: ' + error.message);
      throw error;
    }
  }

  async buildPageSizes(doc, tabId) {
    const sizes = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const { width, height } = page.getViewport({ scale: 1, rotation: 0 });
      sizes.push({ w: width, h: height });
    }
    this.pageSizes.set(tabId, sizes);
  }

  /**
   * Page box in CSS pixels, straight from the size cache (no pdf.js call).
   */
  pageBox(tabId, pageNum, zoom, rotation) {
    const base = this.pageSizes.get(tabId)?.[pageNum - 1];
    if (!base) return null;
    const swap = (((rotation % 360) + 360) % 360) % 180 !== 0;
    return { w: (swap ? base.h : base.w) * zoom, h: (swap ? base.w : base.h) * zoom };
  }

  /** One page-flow container per tab; created on first render. */
  ensureTabViewer(tabId) {
    let viewer = this.tabViewers.get(tabId);
    if (!viewer || !viewer.isConnected) {
      viewer = document.createElement('div');
      viewer.className = 'tab-viewer';
      viewer.dataset.tab = tabId;
      this.tabViewers.set(tabId, viewer);
    }
    if (viewer.parentElement !== this.viewer) this.viewer.appendChild(viewer);
    return viewer;
  }

  getTabViewer(tabId) {
    return this.tabViewers.get(tabId) || null;
  }

  /** Show exactly one tab's viewer; hide the rest and the empty state. */
  showTabViewer(tabId) {
    this.hideAllTabViewers();
    const viewer = this.tabViewers.get(tabId);
    if (viewer) viewer.style.display = 'flex';
    const emptyState = this.viewer.querySelector('.empty-state');
    if (emptyState) emptyState.style.display = 'none';
  }

  hideAllTabViewers() {
    for (const el of this.tabViewers.values()) el.style.display = 'none';
  }

  /** Page-flow styles for one viewer element, single or two-page. */
  applyLayout(el, pageLayout) {
    if (pageLayout === 'two-page') {
      el.classList.add('two-page-layout');
      el.style.display = 'flex';
      el.style.flexDirection = 'row';
      el.style.flexWrap = 'wrap';
      el.style.justifyContent = 'center';
      el.style.alignItems = 'flex-start';
      el.style.gap = '20px';
    } else {
      el.classList.remove('two-page-layout');
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      el.style.flexWrap = 'nowrap';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'flex-start';
      el.style.gap = '0';
    }
  }

  /**
   * Rebuild the tab's page containers and re-materialize what is on screen.
   * Placeholders are sized from the page-size cache, so this is synchronous
   * except for the pages actually being rendered.
   */
  async renderDocument(tabId) {
    const doc = this.documents.get(tabId);
    if (!doc) return;

    const tab = this.app.tabManager.getTab(tabId);
    if (!tab) return;

    const token = (this._renderTokens.get(tabId) || 0) + 1;
    this._renderTokens.set(tabId, token);

    // The focused text box may be mid-edit; persist its live DOM first.
    this.app.annotationManager?.textTool?.flushActive();

    const viewer = this.ensureTabViewer(tabId);
    if (tabId === this.app.tabManager.getActiveTab()?.id) this.showTabViewer(tabId);
    this.applyLayout(viewer, tab.pageLayout || 'single');

    const zoom = tab.zoom || 1.0;
    const rotation = tab.rotation || 0;

    let pages = this.pageElements.get(tabId);
    const rebuild = !pages || pages.length !== doc.numPages || pages[0]?.parentElement !== viewer;

    if (rebuild) {
      viewer.innerHTML = '';
      pages = [];
      for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
        const el = this.createPageContainer(tabId, pageNum, zoom, rotation);
        viewer.appendChild(el);
        pages.push(el);
      }
      this.pageElements.set(tabId, pages);
    } else {
      // Reuse the containers so text boxes survive; their pixels are stale at
      // the new scale, so drop those and let the sweep below repaint.
      for (const el of pages) this.resizePageContainer(tabId, el, zoom, rotation);
    }

    this.app.annotationManager?.textTool?.reflowForTab?.(tabId);

    await this.materializeVisible(tabId, token);
  }

  /** Empty page box with its layers; canvas/text content arrives on materialize. */
  createPageContainer(tabId, pageNum, zoom, rotation) {
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-container';
    pageContainer.dataset.page = pageNum;
    pageContainer.dataset.tab = tabId;
    this.sizePageContainer(pageContainer, tabId, pageNum, zoom, rotation);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'text-layer';

    const annotationLayerDiv = document.createElement('div');
    annotationLayerDiv.className = 'annotation-layer';
    annotationLayerDiv.dataset.page = pageNum;
    annotationLayerDiv.dataset.tab = tabId;

    pageContainer.appendChild(textLayerDiv);
    pageContainer.appendChild(annotationLayerDiv);

    this.observer.observe(pageContainer);
    return pageContainer;
  }

  sizePageContainer(el, tabId, pageNum, zoom, rotation) {
    const box = this.pageBox(tabId, pageNum, zoom, rotation);
    if (!box) return;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
  }

  resizePageContainer(tabId, el, zoom, rotation) {
    this.dematerializePage(el);
    this.sizePageContainer(el, tabId, Number(el.dataset.page), zoom, rotation);
  }

  /** Drop rendered pixels; the store can always repaint annotations later. */
  dematerializePage(pageEl) {
    if (!pageEl) return;
    pageEl._renderTask?.cancel();
    pageEl._renderTask = null;
    delete pageEl.dataset.materialized;

    const canvas = pageEl.querySelector('canvas.pdf-page');
    if (canvas) this.freeCanvas(canvas);
    pageEl.querySelector('.text-layer')?.replaceChildren();
    this.app.annotationManager?.unpaintPage?.(pageEl);
  }

  freeCanvas(canvas) {
    // Zeroing first releases the backing store immediately instead of waiting
    // for GC — at DPR 2 a single page canvas is tens of MB.
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }

  isCurrent(tabId, token, pageEl) {
    return (
      this._renderTokens.get(tabId) === token &&
      pageEl.isConnected &&
      tabId === this.app.tabManager.getActiveTab()?.id
    );
  }

  async materializePage(tabId, pageEl, token = this._renderTokens.get(tabId)) {
    if (!pageEl?.isConnected || pageEl.dataset.materialized === '1' || pageEl.dataset.rendering === '1') return;

    const doc = this.documents.get(tabId);
    const tab = this.app.tabManager.getTab(tabId);
    if (!doc || !tab) return;
    if (tabId !== this.app.tabManager.getActiveTab()?.id) return;

    pageEl.dataset.rendering = '1';
    try {
      const pageNum = Number(pageEl.dataset.page);
      const page = await doc.getPage(pageNum);
      if (!this.isCurrent(tabId, token, pageEl)) return;
      const viewport = page.getViewport({ scale: tab.zoom || 1.0, rotation: tab.rotation || 0 });

      const dpr = window.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const renderTask = page.render({ canvasContext: context, viewport });
      pageEl._renderTask = renderTask;
      try {
        await renderTask.promise;
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') throw err;
        return;
      } finally {
        pageEl._renderTask = null;
      }

      if (!this.isCurrent(tabId, token, pageEl)) {
        this.freeCanvas(canvas);
        return;
      }

      pageEl.insertBefore(canvas, pageEl.firstChild);
      await this.buildTextLayer(page, viewport, pageEl.querySelector('.text-layer'));

      if (!this.isCurrent(tabId, token, pageEl)) {
        this.freeCanvas(canvas);
        pageEl.querySelector('.text-layer')?.replaceChildren();
        return;
      }

      pageEl.dataset.materialized = '1';
      this.app.annotationManager?.restorePage?.(tabId, pageEl);
    } finally {
      delete pageEl.dataset.rendering;
    }
  }

  async buildTextLayer(page, viewport, textLayerDiv) {
    if (!textLayerDiv) return;
    textLayerDiv.replaceChildren();
    try {
      const textContent = await page.getTextContent();
      const frag = document.createDocumentFragment();
      for (const item of textContent.items) {
        const span = document.createElement('span');
        // Use PDF.js Util to get transform for each text item
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        // Scaled height from the combined transform (pdf.js TextLayer does the same);
        // item.height alone is unscaled and drifts from the glyphs at zoom != 1.
        const fontHeight = Math.hypot(tx[2], tx[3]);
        span.style.position = 'absolute';
        span.style.left = `${tx[4]}px`;
        span.style.top = `${tx[5] - fontHeight}px`;
        span.style.fontSize = `${fontHeight}px`;
        span.style.fontFamily = item.fontName;
        span.textContent = item.str;
        span.style.color = 'transparent';
        span.style.whiteSpace = 'pre';
        frag.appendChild(span);
      }
      textLayerDiv.appendChild(frag);
    } catch (e) {
      console.error('Error rendering text layer:', e);
    }
  }

  /** Materialize every page intersecting the viewport (plus a margin). */
  materializeVisible(tabId, token = this._renderTokens.get(tabId)) {
    const pages = this.pageElements.get(tabId);
    if (!pages || !pages.length) return Promise.resolve();

    const margin = 800;
    const containerRect = this.container.getBoundingClientRect();
    const tasks = [];
    for (const el of pages) {
      const r = el.getBoundingClientRect();
      if (r.bottom + margin >= containerRect.top && r.top - margin <= containerRect.bottom) {
        tasks.push(this.materializePage(tabId, el, token));
      }
    }
    return Promise.all(tasks);
  }

  /** Free pixels for pages outside the viewport margin (post-print sweep). */
  dematerializeOffscreen(tabId) {
    const pages = this.pageElements.get(tabId) || [];
    const margin = 800;
    const containerRect = this.container.getBoundingClientRect();
    for (const el of pages) {
      if (el.dataset.materialized !== '1') continue;
      const r = el.getBoundingClientRect();
      if (r.bottom + margin < containerRect.top || r.top - margin > containerRect.bottom) {
        this.dematerializePage(el);
      }
    }
  }

  async ensurePageRendered(tabId, pageNum) {
    const el = this.pageElements.get(tabId)?.[pageNum - 1];
    if (!el || el.dataset.materialized === '1') return;
    await this.materializePage(tabId, el);
  }

  async materializeAll(tabId) {
    const pages = this.pageElements.get(tabId) || [];
    const token = this._renderTokens.get(tabId);
    for (const el of pages) {
      if (this.isCurrent(tabId, token, el)) await this.materializePage(tabId, el, token);
    }
  }

  setupObserver() {
    this.observer = new IntersectionObserver((entries) => {
      const activeId = this.app.tabManager.getActiveTab()?.id;
      for (const entry of entries) {
        const el = entry.target;
        const tabId = el.dataset.tab;
        if (entry.isIntersecting) {
          if (tabId === activeId) this.materializePage(tabId, el);
        } else {
          this.dematerializePage(el);
        }
      }
    }, { root: this.container, rootMargin: '800px 0px', threshold: 0 });
  }

  switchToTab(tabId) {
    // Re-hydrate tab.fileData from authoritative bytes if it was corrupted/zeroed.
    const tab = this.app?.tabManager?.getTab?.(tabId);
    const authoritative = this.originalPdfBytes.get(tabId);
    if (
      tab &&
      authoritative instanceof Uint8Array &&
      authoritative.length > 0 &&
      (!(tab.fileData instanceof Uint8Array) || tab.fileData.length === 0)
    ) {
      // Important: keep a *copy* to avoid subtle detachment/mutation bugs.
      tab.fileData = new Uint8Array(authoritative);
    }

    const doc = this.documents.get(tabId);
    if (!doc) {
      this.app.showEmptyState();
      return;
    }

    const viewer = this.getTabViewer(tabId);
    if (!viewer) {
      // First time this tab is shown: build its pages.
      this.renderDocument(tabId);
      return;
    }

    // The container keeps its DOM, so scroll survives without re-appending.
    this.showTabViewer(tabId);
    this.applyLayout(viewer, tab.pageLayout || 'single');
    this.container.scrollTop = tab.scrollPosition || 0;
  }

  closeDocument(tabId) {
    const doc = this.documents.get(tabId);
    if (doc) {
      doc.destroy();
    }
    (this.pageElements.get(tabId) || []).forEach(el => this.observer.unobserve(el));
    this._renderTokens.delete(tabId);
    this.tabViewers.get(tabId)?.remove();
    this.tabViewers.delete(tabId);
    this.documents.delete(tabId);
    this.pageElements.delete(tabId);
    this.originalPdfBytes.delete(tabId);
    this.pageSizes.delete(tabId);
  }

  getDocument(tabId) {
    return this.documents.get(tabId);
  }

  async setZoom(tabId, zoom) {
    const tab = this.app.tabManager.getTab(tabId);
    if (!tab) return;

    tab.zoom = zoom;
    await this.renderDocument(tabId);
  }

  async fitToWidth(tabId, containerWidth) {
    const base = this.pageSizes.get(tabId)?.[0];
    if (!base) return;

    this.app.tabManager.updateTab(tabId, { zoom: containerWidth / base.w });
    await this.renderDocument(tabId);
  }

  async setRotation(tabId, rotation) {
    const tab = this.app.tabManager.getTab(tabId);
    if (!tab) return;

    const currentPage = tab.currentPage || 1;
    
    await this.renderDocument(tabId);
    
    // Restore the current page position after rotation
    await this.goToPage(tabId, currentPage);
  }

  async setPageLayout(tabId, layout) {
    await this.renderDocument(tabId);
  }

  async goToPage(tabId, pageNum) {
    const pages = this.pageElements.get(tabId);
    if (!pages || pageNum < 1 || pageNum > pages.length) return;

    const pageContainer = pages[pageNum - 1];
    if (pageContainer) {
      // Callers (search, outline) read the page DOM right after; render it first.
      await this.ensurePageRendered(tabId, pageNum);
      pageContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
      
      this.app.tabManager.updateTab(tabId, { currentPage: pageNum });
      document.getElementById('page-number').value = pageNum;
      
      // Update sidebar
      this.app.sidebar.updateCurrentPage(tabId, pageNum);
    }
  }

  setupScrollListener() {
    let scrollTimeout;
    
    this.container.addEventListener('scroll', () => {
      const activeTab = this.app.tabManager.getActiveTab();
      if (!activeTab) return;

      // Save scroll position
      this.app.tabManager.updateTab(activeTab.id, { 
        scrollPosition: this.container.scrollTop 
      });

      // Debounce page detection
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        this.detectCurrentPage(activeTab.id);
      }, 100);
    });
  }

  detectCurrentPage(tabId) {
    const pages = this.pageElements.get(tabId);
    if (!pages) return;

    const containerRect = this.container.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;

    for (let i = 0; i < pages.length; i++) {
      const pageRect = pages[i].getBoundingClientRect();
      
      if (pageRect.top <= containerCenter && pageRect.bottom >= containerCenter) {
        const pageNum = i + 1;
        const tab = this.app.tabManager.getTab(tabId);
        
        if (tab && tab.currentPage !== pageNum) {
          this.app.tabManager.updateTab(tabId, { currentPage: pageNum });
          document.getElementById('page-number').value = pageNum;
          this.app.sidebar.updateCurrentPage(tabId, pageNum);
        }
        break;
      }
    }
  }

  async exportPDF(tabId) {
    const tab = this.app.tabManager.getTab(tabId);
    const originalBytes = this.originalPdfBytes.get(tabId);
    if (!tab || !(originalBytes instanceof Uint8Array) || originalBytes.length === 0) return null;

    const store = this.app.annotationManager?.storeFor?.(tabId);
    if (!store) return null;

    const outBytes = await exportPdf(originalBytes, store, {
      tabId,
      rotationDeg: tab.rotation || 0
    });

    return Array.from(outBytes);
  }

  /**
   * Platform-specific delivery for already-exported PDF bytes.
   *
   * @param {Uint8Array|number[]} pdfBytes
   * @param {{ platform: 'web'|'electron', filename?: string, filePath?: string }} opts
   */
  async saveExportedPdf(pdfBytes, opts = {}) {
    const platform = opts.platform || (window.electronAPI ? 'electron' : 'web');

    if (platform === 'electron') {
      return await electronSave(pdfBytes, { filePath: opts.filePath });
    }

    webSave(pdfBytes, { filename: opts.filename });
    return { success: true };
  }
}
