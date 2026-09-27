import { TabManager } from './js/TabManager.js';
import { Toolbar } from './js/Toolbar.js';
import { Sidebar } from './js/Sidebar.js';
import { PDFRenderer } from './js/PDFRenderer.js';
import { AnnotationManager } from './js/AnnotationManager.js';
import { SearchManager } from './js/SearchManager.js';
import { SettingsManager } from './js/SettingsManager.js';
import { AIChatPanel } from './js/AIChatPanel.js';
import { RagManager } from '../eigen-rag/client/RagManager.js';

class PDFEditor {
  constructor() {
    this.tabManager = new TabManager();
    this.toolbar = new Toolbar(this);
    this.sidebar = new Sidebar(this);
    this.pdfRenderer = new PDFRenderer(this);
    this.annotationManager = new AnnotationManager(this);
    this.searchManager = new SearchManager(this);
    this.settingsManager = new SettingsManager(this);

    // RAG client (web + electron renderer)
    this.ragManager = new RagManager(this);

    this.aiChatPanel = new AIChatPanel(this);

    this.init();
    this.toolbar.setupPopovers(); // <-- Call popover setup after all managers are initialized
  }

  init() {
    this.setupEventListeners();
    this.setupKeyboardShortcuts();
    this.createNewTab();
  }

  createNewTab() {
    // Create an initial "new tab" like browsers do
    const tabId = this.tabManager.createTab('New Tab', '');
    this.tabManager.setActiveTab(tabId);
    this.showEmptyState();
  }

  setupEventListeners() {
    // Open file button
    document.getElementById('btn-open-file').addEventListener('click', () => {
      this.openFile();
    });

    // New tab button
    document.getElementById('btn-new-tab').addEventListener('click', () => {
      this.createNewTab();
    });

    // Tab events
    this.tabManager.on('tabChanged', (tabId) => {
      this.onTabChanged(tabId);
    });

    this.tabManager.on('tabClosed', (tabId) => {
      this.onTabClosed(tabId);
    });

    // Drag and drop support
    const dropZone = document.getElementById('pdf-container');
    
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.opacity = '0.5';
    });

    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.opacity = '1';
    });

    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.style.opacity = '1';

      const files = Array.from(e.dataTransfer.files).filter(
        file => file.type === 'application/pdf'
      );

      for (const file of files) {
        const arrayBuffer = await file.arrayBuffer();
        await this.loadPDF({
          name: file.name,
          path: file.name,
          data: Array.from(new Uint8Array(arrayBuffer))
        });
      }
    });
  }

  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+F - Search
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        this.searchManager.toggleSearch();
      }

      // Ctrl+W - Close tab
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        const activeTab = this.tabManager.getActiveTab();
        if (activeTab) {
          this.tabManager.closeTab(activeTab.id);
        }
      }

      // Ctrl+Tab - Next tab
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          this.tabManager.previousTab();
        } else {
          this.tabManager.nextTab();
        }
      }

      // Escape - Close popovers/search/fullscreen
      if (e.key === 'Escape') {
        this.toolbar.closeAllPopovers();
        
        if (document.fullscreenElement) {
          document.exitFullscreen();
        }
      }

      // + - Zoom in
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        this.toolbar.zoomIn();
      }

      // - - Zoom out
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        this.toolbar.zoomOut();
      }
    });

    // Ctrl+Scroll - Zoom in/out with throttling
    const pdfContainer = document.getElementById('pdf-container');
    let zoomTimeout = null;
    let isZooming = false;
    
    pdfContainer.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        
        // Throttle zoom events to prevent rapid firing
        if (isZooming) {
          return;
        }
        
        isZooming = true;
        
        // Negative deltaY means scroll up (zoom in)
        // Positive deltaY means scroll down (zoom out)
        if (e.deltaY < 0) {
          this.toolbar.zoomIn();
        } else {
          this.toolbar.zoomOut();
        }
        
        // Reset the throttle after a short delay
        setTimeout(() => {
          isZooming = false;
        }, 100);
      }
    }, { passive: false });
  }

  async openFile() {
    if (!window.electronAPI) {
      // Browser fallback - use file input
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf';
      input.multiple = true;
      
      input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
          const arrayBuffer = await file.arrayBuffer();
          await this.loadPDF({
            name: file.name,
            path: file.name,
            data: Array.from(new Uint8Array(arrayBuffer))
          });
        }
      };
      
      input.click();
      return;
    }

    const files = await window.electronAPI.openPdfDialog();
    if (files && files.length > 0) {
      for (const file of files) {
        await this.loadPDF(file);
      }
    }
  }

  async loadPDF(file) {
    const activeTab = this.tabManager.getActiveTab();
    let tabId;
    
    // If the current tab is an empty "New Tab", reuse it
    if (activeTab && activeTab.name === 'New Tab' && !activeTab.path && !activeTab.fileData) {
      tabId = activeTab.id;
      // Update the tab with the new file info
      this.tabManager.updateTab(tabId, { 
        name: file.name, 
        path: file.path 
      });
      // Update the tab element text
      const tabElement = document.querySelector(`[data-tab-id="${tabId}"] .tab-name`);
      if (tabElement) {
        tabElement.textContent = file.name;
        tabElement.title = file.name;
      }
    } else {
      // Create a new tab
      tabId = this.tabManager.createTab(file.name, file.path);
      this.tabManager.setActiveTab(tabId);
    }

    const tab = this.tabManager.getTab(tabId);

    // Normalize incoming file bytes.
    // - Electron dialog provides `data: number[]`
    // - Some flows may provide `data: Uint8Array` (or ArrayBuffer)
    let bytes;
    if (file?.data instanceof Uint8Array) {
      // Make a defensive copy in case this is a detached/zero-length view.
      bytes = new Uint8Array(file.data);
    } else if (file?.data instanceof ArrayBuffer) {
      bytes = new Uint8Array(file.data);
    } else if (Array.isArray(file?.data)) {
      bytes = new Uint8Array(file.data);
    } else {
      throw new Error('Unsupported PDF data type');
    }

    // Force a standalone copy (guards against odd TypedArray views)
    if (bytes && bytes.byteLength > 0) {
      bytes = new Uint8Array(bytes);
    }

    tab.fileData = bytes;

    console.log('Loaded PDF bytes', { name: file?.name, len: tab.fileData?.length });

    await this.pdfRenderer.loadDocument(tab.fileData, tabId);

    // NOTE: RAG ingestion is intentionally NOT triggered here.
    // Chat will ingest on-demand using PDF.js `pdfDoc.getData()`.

    // updateUI() is now called from loadDocument() right after the document is loaded
  }

  onTabChanged(tabId) {
    const tab = this.tabManager.getTab(tabId);
    if (!tab) return;

    // Restore tab state
    this.pdfRenderer.switchToTab(tabId);
    this.toolbar.restoreTabState(tab);
    this.sidebar.restoreTabState(tab);

    this.updateUI();
  }

  onTabClosed(tabId) {
    this.pdfRenderer.closeDocument(tabId);
    this.annotationManager.closeTab(tabId);
    
    const remainingTabs = this.tabManager.getTabs();
    if (remainingTabs.length === 0) {
      // Browser-like behavior: closing the last tab closes the app
      if (window.electronAPI) {
        // In Electron, close the window
        window.close();
      } else {
        // In browser, just show empty state
        this.showEmptyState();
      }
    }

    // If a tab is closed, also clear any cached RAG doc id for it.
    try {
      this.ragManager.clearTab(tabId);
    } catch (e) {
      console.warn('Failed to clear RAG state for closed tab', tabId, e);
    }
  }

  updateUI() {
    const activeTab = this.tabManager.getActiveTab();
    
    if (!activeTab) {
      this.showEmptyState();
      return;
    }

    const doc = this.pdfRenderer.getDocument(activeTab.id);
    if (doc) {
      document.getElementById('page-total').textContent = `of ${doc.numPages}`;
      document.getElementById('page-number').max = doc.numPages;
      document.getElementById('page-number').value = activeTab.currentPage || 1;
    }
  }

  showEmptyState() {
    // The empty state is a single static node; tab viewers are hidden, not removed.
    this.pdfRenderer.hideAllTabViewers();
    const emptyState = document.querySelector('#pdf-viewer .empty-state');
    if (emptyState) emptyState.style.display = 'flex';

    document.getElementById('page-total').textContent = 'of 0';
    document.getElementById('page-number').value = 1;
  }

  getActiveTabData() {
    const activeTab = this.tabManager.getActiveTab();
    if (!activeTab) return null;

    return {
      tab: activeTab,
      document: this.pdfRenderer.getDocument(activeTab.id)
    };
  }
}

// Initialize the app
const app = new PDFEditor();
window.pdfEditor = app;

async function initApp() {
  // ...existing code...

  // If a tab is closed, also clear any cached RAG doc id for it.
  if (app?.tabManager?.on) {
    app.tabManager.on('tabClosed', (tabId) => {
      try {
        app?.ragManager?.clearTab?.(tabId);
      } catch (e) {
        console.warn('Failed to clear RAG state for closed tab', tabId, e);
      }
    });
  }

  // ...existing code...
}

initApp();
