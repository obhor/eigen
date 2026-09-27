import { AnnotationStore } from './AnnotationStore.js';
import { PageLayers } from './PageLayers.js';
import { DrawToolState } from './DrawToolState.js';
import { DrawToolUI } from './DrawToolUI.js';
import { DrawingEngine } from './DrawingEngine.js';
import { EraserEngine } from './EraserEngine.js';
import { TextTool } from './TextTool.js';
import { PageProjector } from '../core/projection.js';

export class AnnotationManager {
  constructor(app) {
    this.app = app;
    this.activeTool = null;
    this.isDrawing = false;
    this.currentAnnotation = null;
    
    // Initialize Draw Tool System
    this.drawToolState = new DrawToolState();
    this.drawToolUI = new DrawToolUI(this.drawToolState);
    this.drawingEngine = new DrawingEngine(this.drawToolState);
    
    // Initialize Eraser Engine
    this.eraserEngine = new EraserEngine();
    
    // Initialize Text Tool
    this.textTool = new TextTool(this);
    
    // Tool settings (legacy for highlight/text)
    this.drawColor = '#000000';
    this.drawThickness = 3;
    this.highlightColor = '#FFFF00';
    this.highlightThickness = 20;
    this.highlightTextOnly = false;
    
    this.stores = new Map(); // tabId -> AnnotationStore
    this.annotationsHidden = false;

    this.setupEventListeners();
  }

  storeFor(tabId) {
    if (!this.stores.has(tabId)) this.stores.set(tabId, new AnnotationStore());
    return this.stores.get(tabId);
  }

  projectorFor(layer, tabId) {
    const rotationDeg = this.app.tabManager?.getTab(tabId)?.rotation || 0;
    return new PageProjector(layer, rotationDeg);
  }

  setupEventListeners() {
    const container = document.getElementById('pdf-container');
    
    container.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    container.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    container.addEventListener('mouseup', (e) => this.handleMouseUp(e));
    container.addEventListener('mouseleave', (e) => this.handleMouseUp(e));
  }

  /**
   * Mark tab as having changes and update save button state
   */
  markTabAsChanged(tabId) {
    this.app.tabManager.updateTab(tabId, { hasChanges: true });
    if (this.app.toolbar) {
      this.app.toolbar.markUnsavedChanges();
    }
  }

  setActiveTool(tool) {
    this.activeTool = tool;
    const container = document.getElementById('pdf-container');
    
    // Persist the active text box, then drop it if it was left empty
    this.textTool.flushActive();
    if (tool !== 'text') {
      this.textTool.removeEmptyTextBox();
    }
    
    // Update draw tool state and body class
    if (tool === 'draw') {
      this.drawToolState.setState({ enabled: true });
      document.body.classList.add('draw-tool-active');
    } else {
      this.drawToolState.setState({ enabled: false });
      document.body.classList.remove('draw-tool-active');
    }
    
    // Add eraser-active class for eraser tool
    if (tool === 'erase') {
      document.body.classList.add('eraser-tool-active');
    } else {
      document.body.classList.remove('eraser-tool-active');
    }
    
    // Add highlight-active class for highlight tool
    if (tool === 'highlight') {
      document.body.classList.add('highlight-tool-active');
    } else {
      document.body.classList.remove('highlight-tool-active');
    }
    
    // Add text-tool-active class for text tool
    if (tool === 'text') {
      document.body.classList.add('text-tool-active');
    } else {
      document.body.classList.remove('text-tool-active');
    }
    
    if (tool) {
      container.style.cursor = this.getToolCursor(tool);
    } else {
      container.style.cursor = 'default';
    }
  }

  /**
   * Toggle draw tool dropdown
   */
  toggleDrawToolDropdown(buttonElement) {
    this.drawToolUI.toggle(buttonElement);
  }

  getToolCursor(tool) {
    switch (tool) {
      case 'highlight':
        return 'text';
      case 'draw':
        return 'crosshair';
      case 'erase':
        return 'crosshair'; // CSS will override with custom cursor
      case 'text':
        return 'text';
      default:
        return 'default';
    }
  }

  handleMouseDown(e) {
    if (!this.activeTool) return;

    // Find annotation layer or get it from page structure
    let annotationLayer = e.target.closest('.annotation-layer');

    // If we're on a text span, get the annotation layer from page structure
    if (!annotationLayer && e.target.closest('.text-layer')) {
      const pageContainer = e.target.closest('.page-container');
      if (pageContainer) {
        annotationLayer = pageContainer.querySelector('.annotation-layer');
      }
    }

    if (!annotationLayer) return;

    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab) return;

    this.isDrawing = true;
    const { x, y } = new PageProjector(annotationLayer).localXY(e);

    if (this.activeTool === 'draw') {
      this.startNewDrawing(annotationLayer, x, y, activeTab.id);
    } else if (this.activeTool === 'highlight') {
      // For text-only mode, just track the annotation, text selection happens naturally
      if (this.highlightTextOnly) {
        this.currentAnnotation = {
          type: 'highlightText',
          layer: annotationLayer,
          tabId: activeTab.id
        };
      } else {
        // Normal freehand highlight
        this.startHighlightStroke(annotationLayer, x, y, activeTab.id);
      }
    } else if (this.activeTool === 'erase') {
      this.startErasing(annotationLayer, x, y, activeTab.id);
    } else if (this.activeTool === 'text') {
      // Don't create a new text box if clicking on an existing text annotation
      if (!e.target.closest('.text-annotation')) {
        this.addText(annotationLayer, x, y, activeTab.id);
      }
    }
  }

  /**
   * Start drawing with new DrawingEngine
   */
  startNewDrawing(annotationLayer, x, y, tabId) {
    const canvas = PageLayers.canvas(annotationLayer, 'draw');

    this.drawingEngine.initCanvas(canvas);
    this.drawingEngine.startDrawing(x, y);

    this.currentAnnotation = {
      type: 'draw',
      layer: annotationLayer,
      canvas: canvas,
      tabId: tabId,
      pageNum: parseInt(annotationLayer.dataset.page)
    };
  }

  handleMouseMove(e) {
    if (!this.isDrawing || !this.currentAnnotation) return;

    // Find annotation layer
    let annotationLayer = e.target.closest('.annotation-layer');
    
    // If we're on text, find annotation layer from page structure
    if (!annotationLayer && e.target.closest('.text-layer')) {
      const pageContainer = e.target.closest('.page-container');
      if (pageContainer) {
        annotationLayer = pageContainer.querySelector('.annotation-layer');
      }
    }
    
    if (!annotationLayer) return;

    const { x, y } = new PageProjector(annotationLayer).localXY(e);

    if (this.activeTool === 'draw') {
      this.drawingEngine.continueDrawing(x, y);
    } else if (this.activeTool === 'erase') {
      this.continueErasing(x, y);
    } else if (this.currentAnnotation.type === 'highlight') {
      // text-only mode tracks the annotation without a stroke
      this.continueHighlightStroke(x, y);
    }
  }

  handleMouseUp(e) {
    if (!this.isDrawing) return;

    this.isDrawing = false;
    
    if (this.currentAnnotation) {
      if (this.activeTool === 'draw') {
        this.finishNewDrawing();
      } else if (this.activeTool === 'erase') {
        this.finishErasing();
      } else if (this.activeTool === 'highlight') {
        this.finishHighlight();
      }
    }
  }

  /**
   * Finish highlight: text-selection rects in text-only mode, freehand otherwise.
   */
  finishHighlight() {
    if (this.currentAnnotation?.type === 'highlightText') {
      this.finishTextHighlight();
    } else {
      this.finishHighlightStroke();
    }
    this.currentAnnotation = null;
  }

  /**
   * Capture the current text selection as highlight rectangles.
   */
  finishTextHighlight() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const rects = selection.getRangeAt(0).getClientRects();
    if (rects.length === 0) return;

    const { layer, tabId } = this.currentAnnotation;
    const pageNum = parseInt(layer.dataset.page);
    const projector = this.projectorFor(layer, tabId);
    const layerRect = layer.getBoundingClientRect();

    const canvas = PageLayers.canvas(layer, 'highlight');
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = this.fillColorFor(this.highlightColor);
    ctx.globalAlpha = 1.0;

    const highlightRects = [];
    for (const rect of rects) {
      const pixelRect = {
        x: rect.left - layerRect.left,
        y: rect.top - layerRect.top,
        w: rect.width,
        h: rect.height
      };
      ctx.fillRect(pixelRect.x, pixelRect.y, pixelRect.w, pixelRect.h);
      highlightRects.push(projector.toNormRect(pixelRect));
    }

    this.storeFor(tabId).add({
      kind: 'textHighlight',
      page: pageNum,
      rects: highlightRects,
      color: this.highlightColor
    });

    this.markTabAsChanged(tabId);
    selection.removeAllRanges();
  }

  /** Highlights are painted as rgba so overlapping strokes stay uniform. */
  fillColorFor(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0.25)`;
  }

  /**
   * Finish drawing with new DrawingEngine
   */
  finishNewDrawing() {
    const pathData = this.drawingEngine.stopDrawing();

    if (pathData && this.currentAnnotation) {
      const { tabId, pageNum, layer } = this.currentAnnotation;

      // Normalize points to layer-relative coords so they survive zoom/layout changes.
      if (layer && Array.isArray(pathData.points)) {
        const projector = this.projectorFor(layer, tabId);
        this.storeFor(tabId).add({
          kind: 'draw',
          page: pageNum,
          points: pathData.points.map(p => projector.toNormPoint(p.x, p.y)),
          color: pathData.color,
          thickness: pathData.thickness
        });

        // Mark tab as changed
        this.markTabAsChanged(tabId);
      }
    }

    this.currentAnnotation = null;
  }

  /**
   * Start a freehand highlight stroke on the highlight layer.
   */
  startHighlightStroke(annotationLayer, x, y, tabId) {
    const canvas = PageLayers.canvas(annotationLayer, 'highlight');
    const ctx = canvas.getContext('2d');

    this.currentAnnotation = {
      type: 'highlight',
      layer: annotationLayer,
      canvas,
      ctx,
      tabId,
      points: [{ x, y }],
      color: this.fillColorFor(this.highlightColor),
      thickness: this.highlightThickness,
      // Restored before every extend so overlaps don't stack opacity.
      savedImageData: ctx.getImageData(0, 0, canvas.width, canvas.height)
    };

    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.strokeStyle = this.currentAnnotation.color;
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'lighten';
    ctx.lineWidth = this.currentAnnotation.thickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  continueHighlightStroke(x, y) {
    if (this.currentAnnotation?.type !== 'highlight') return;

    const { ctx, points, color, thickness, savedImageData } = this.currentAnnotation;
    points.push({ x, y });

    ctx.putImageData(savedImageData, 0, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1.0;
    ctx.globalCompositeOperation = 'lighten';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
  }

  finishHighlightStroke() {
    const { layer, tabId, points, color, thickness } = this.currentAnnotation || {};
    if (!tabId) return;

    const projector = this.projectorFor(layer, tabId);

    this.storeFor(tabId).add({
      kind: 'highlight',
      page: parseInt(layer.dataset.page),
      points: (points || []).map(p => projector.toNormPoint(p.x, p.y)),
      color,
      thickness
    });

    this.markTabAsChanged(tabId);
  }

  /**
   * Start erasing with new EraserEngine
   */
  startErasing(annotationLayer, x, y, tabId) {
    const pageNum = parseInt(annotationLayer.dataset.page);
    const rotationDeg = this.app.tabManager?.getTab(tabId)?.rotation || 0;
    const projector = this.projectorFor(annotationLayer, tabId);

    if (this.eraseAt(annotationLayer, tabId, pageNum, x, y, projector)) {
      this.markTabAsChanged(tabId);
    }

    this.currentAnnotation = { type: 'erase', layer: annotationLayer, tabId, pageNum, rotationDeg };
  }

  /**
   * Check if eraser circle intersects with a rectangle
   */
  eraserIntersectsRect(eraserX, eraserY, rect) {
    const radius = this.eraserEngine.getRadius();
    
    // Find closest point on rectangle to eraser center
    const closestX = Math.max(rect.x, Math.min(eraserX, rect.x + rect.w));
    const closestY = Math.max(rect.y, Math.min(eraserY, rect.y + rect.h));
    
    // Distance from eraser center to closest point
    const dx = eraserX - closestX;
    const dy = eraserY - closestY;
    const distSquared = dx * dx + dy * dy;
    
    return distSquared <= radius * radius;
  }

  /**
   * Remove every annotation kind under the eraser, then repaint the page.
   * Returns whether anything was erased.
   */
  eraseAt(layer, tabId, pageNum, x, y, projector) {
    const store = this.storeFor(tabId);
    const dead = [];

    for (const kind of ['draw', 'highlight']) {
      const items = store.forPage(pageNum, kind);
      if (items.length === 0) continue;
      // Stored paths are normalized; eraser math is in pixels.
      const pixelPaths = items.map(p => projector.toScreenPath(p));
      const { erasedPaths } = this.eraserEngine.erasePaths(pixelPaths, x, y);
      const hit = new Set(erasedPaths);
      dead.push(...items.filter((_, i) => hit.has(pixelPaths[i])));
    }

    const rects = store.forPage(pageNum, 'textHighlight');
    dead.push(...rects.filter(item => item.rects
      .map(r => projector.toScreenRect(r))
      .some(rect => this.eraserIntersectsRect(x, y, rect))));

    if (dead.length === 0) return false;

    store.removeWhere(item => dead.includes(item));
    this.paintPage(layer, tabId, pageNum, projector);
    return true;
  }

  /** Repaint both canvases of a page from the store. */
  paintPage(layer, tabId, pageNum, projector) {
    const store = this.storeFor(tabId);
    this.paintDraw(layer, store.forPage(pageNum, 'draw'), projector);
    this.paintHighlights(layer, [
      ...store.forPage(pageNum, 'highlight'),
      ...store.forPage(pageNum, 'textHighlight')
    ], projector);
  }

  paintDraw(layer, items, projector) {
    if (items.length === 0) return PageLayers.clear(layer, 'draw');
    const canvas = PageLayers.canvas(layer, 'draw');
    this.paintPaths(canvas, items.map(i => projector.toScreenPath(i)));
  }

  /** Freehand strokes and text-selection rects share the highlight canvas. */
  paintHighlights(layer, items, projector) {
    if (items.length === 0) return PageLayers.clear(layer, 'highlight');
    const canvas = PageLayers.canvas(layer, 'highlight');

    this.paintPaths(canvas, items
      .filter(i => i.kind === 'highlight')
      .map(i => projector.toScreenPath(i)));

    const ctx = canvas.getContext('2d');
    ctx.globalAlpha = 1.0;
    for (const item of items) {
      if (item.kind !== 'textHighlight') continue;
      ctx.fillStyle = this.fillColorFor(item.color);
      for (const norm of item.rects) {
        const r = projector.toScreenRect(norm);
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }
  }

  paintPaths(canvas, pixelPaths) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this.drawingEngine.initCanvas(canvas);
    for (const pathData of pixelPaths) {
      this.drawingEngine.drawPath(pathData);
    }
  }

  /**
   * Continue erasing (mouse drag)
   */
  continueErasing(x, y) {
    const { tabId, pageNum, layer, rotationDeg = 0 } = this.currentAnnotation || {};
    if (!tabId) return;

    const projector = new PageProjector(layer, rotationDeg);
    if (this.eraseAt(layer, tabId, pageNum, x, y, projector)) {
      this.markTabAsChanged(tabId);
    }
  }

  /**
   * Finish erasing
   */
  finishErasing() {
    // Just clear the current annotation, changes already saved
    this.currentAnnotation = null;
  }

  addText(annotationLayer, x, y, tabId) {
    // Use TextTool to create a text box with formatting toolbar
    this.textTool.createTextBox(annotationLayer, x, y, tabId);
  }

  closeTab(tabId) {
    this.stores.delete(tabId);
  }

  setDrawColor(color) {
    this.drawColor = color;
  }

  setDrawThickness(thickness) {
    this.drawThickness = parseInt(thickness);
  }

  setHighlightColor(color) {
    this.highlightColor = color;
  }

  setHighlightThickness(thickness) {
    this.highlightThickness = parseInt(thickness);
  }

  setHighlightTextOnly(enabled) {
    this.highlightTextOnly = enabled;
    
    // Add/remove body class for CSS styling
    if (enabled) {
      document.body.classList.add('text-only-mode');
    } else {
      document.body.classList.remove('text-only-mode');
    }
  }

  hideAllAnnotations(hide) {
    this.annotationsHidden = hide;
    document.querySelectorAll('.annotation-layer').forEach(layer => PageLayers.hide(layer, hide));
  }

  /**
   * Rebuild one page's stored annotations onto its (re)materialized layer.
   * Idempotent: text wrappers that are already mounted are left alone.
   */
  restorePage(tabId, pageEl) {
    const layer = pageEl?.querySelector('.annotation-layer');
    if (!layer) return;

    const pageNum = parseInt(layer.dataset.page);
    const projector = this.projectorFor(layer, tabId);

    // A display:none layer measures 0, which would size the new canvases wrong.
    PageLayers.hide(layer, false);
    this.paintPage(layer, tabId, pageNum, projector);

    const store = this.storeFor(tabId);
    const mounted = new Set(
      [...layer.querySelectorAll('.text-annotation-wrapper')].map(el => el.dataset.annotationId)
    );
    store.forPage(pageNum, 'text').forEach(item => {
      if (!mounted.has(item.id)) this.textTool.mount(layer, item, projector);
    });

    if (this.annotationsHidden) PageLayers.hide(layer, true);
  }

  /** Drop a page's painted canvases; the store can repaint them any time. */
  unpaintPage(pageEl) {
    const layer = pageEl?.querySelector('.annotation-layer');
    if (!layer) return;
    layer.querySelectorAll('.annotation-canvas').forEach(el => el.remove());
  }

}
