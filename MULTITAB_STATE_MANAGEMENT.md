# Multi-Tab State Management

## Overview
Each tab owns its document, its annotation store, and its own viewer container. Nothing is shared or re-appended on tab switch; hidden tabs keep their DOM but free their rendered page pixels.

## How It Works

### Tab State Storage
Each tab stores its own state in the `TabManager`:

```javascript
{
  id: 'tab-1',
  name: 'document.pdf',
  path: '/path/to/document.pdf',
  currentPage: 5,           // Current page number
  zoom: 1.5,                // Zoom level
  rotation: 0,              // Page rotation
  pageLayout: 'two-page',   // Layout mode
  activeTool: 'highlight',  // Active annotation tool
  sidebarOpen: true,        // Sidebar visibility
  sidebarMode: 'outline',   // Sidebar mode
  hasChanges: false,        // Unsaved changes flag
  scrollPosition: 2500,     // Scroll position in pixels
  fileData: Uint8Array      // PDF file data
}
```

### Renderer State (all keyed by tabId)

**`documents`** — the loaded PDF.js document.

**`pageSizes`** — one `{w, h}` per page, captured at load from `getViewport({scale: 1})`. Every zoom/rotation/layout resize is arithmetic on this cache; pdf.js is not called per pass.

**`pageElements`** — the tab's `.page-container` elements. These are **placeholders**: always present (so scroll height, `goToPage`, `detectCurrentPage` and saved scroll positions stay exact), but a page only carries a rendered canvas and text spans while it is near the viewport. Pages are materialized/dematerialized by an `IntersectionObserver` (`rootMargin: 800px`); `pageEl.dataset.materialized` tracks the state.

**`tabViewers`** — one `<div class="tab-viewer" data-tab>` per tab inside `#pdf-viewer`. Switching tabs toggles `display`; it never wipes or re-appends.

### Annotations
`AnnotationManager` holds one `AnnotationStore` per tab (flat `Map<id, item>`, normalized layer-relative unrotated coordinates — see `src/core/projection.js`). The store is authoritative: a dematerialized page drops its annotation canvases and text-box wrappers are re-mounted from the store on the next materialize (`AnnotationManager.restorePage`), so nothing depends on DOM lifetime.

## Tab Switching Behavior

### Switching TO a tab:
1. Show its `.tab-viewer`, hide the others (and the empty state)
2. Re-apply the page layout, restore `scrollTop` synchronously from `tab.scrollPosition`
3. The observer materializes the visible pages

### Switching FROM a tab:
1. Scroll listener saves `tab.scrollPosition`
2. Pages of the hidden tab report `isIntersecting: false` and free their pixels; document, placeholders and store stay in memory

## What Is Preserved

✅ **Scroll Position** — exact pixel position (the container keeps its own DOM)
✅ **Current Page / Zoom / Rotation / Layout** — per-tab settings
✅ **Annotations** — every kind, re-projected from the store at any zoom/rotation
✅ **Active Tool**, **Sidebar State** — via `restoreTabState`

## Performance Model

A render pass (load, zoom, rotate, layout) rebuilds placeholders from the size cache — a synchronous no-op for pdf.js — and then materializes only the pages intersecting the viewport plus a margin. Wheel-zoom therefore costs a few page renders, not `numPages` renders. Rendered pixels outside the margin are cancelled (`renderTask.cancel()`) and their canvases freed immediately. Export reads the original bytes and the annotation store, never the DOM.

Print needs every page: `Toolbar.print()` materializes all pages first and sweeps the offscreen ones back after `afterprint`.

## Current Limitations

1. **No Persistence** — tab state and annotations are in memory only; lost on reload.
2. **Text export is approximate** — text boxes are flattened as Helvetica with greedy word wrap; letter-spacing, box background and padding are not reproduced, and characters outside Latin-1 become `?`.
3. **Print relies on full materialization** — a very large document at high zoom spikes memory during print.
4. **Thumbnails are independent** — the sidebar renders its own canvases per page and is not cancelled on tab switch.

## Code References

- `/src/js/TabManager.js` — tab creation and management
- `/src/js/PDFRenderer.js` — `renderDocument()`, `materializePage()`, `dematerializePage()`, `ensurePageRendered()`, `switchToTab()`
- `/src/js/AnnotationStore.js` — per-tab annotation model
- `/src/js/AnnotationManager.js` — `restorePage()` / `unpaintPage()`, erase, hide
- `/src/core/projection.js` — the single rotation/projection boundary
- `/src/main.js:onTabChanged()` — orchestrates state restoration
