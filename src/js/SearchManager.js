export class SearchManager {
  constructor(app) {
    this.app = app;
    this.isOpen = false;
    this.searchResults = [];
    this.currentResultIndex = -1;
    
    this.searchBar = document.getElementById('search-bar');
    this.searchInput = document.getElementById('search-input');
    this.searchResultsLabel = document.getElementById('search-results');
    
    this.init();
  }

  init() {
    document.getElementById('search-close').addEventListener('click', () => {
      this.close();
    });

    document.getElementById('search-prev').addEventListener('click', () => {
      this.previousResult();
    });

    document.getElementById('search-next').addEventListener('click', () => {
      this.nextResult();
    });

    this.searchInput.addEventListener('input', () => {
      this.search();
    });

    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          this.previousResult();
        } else {
          this.nextResult();
        }
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
  }

  toggleSearch() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    this.isOpen = true;
    this.searchBar.style.display = 'flex';
    this.searchInput.focus();
    this.searchInput.select();
  }

  close() {
    this.isOpen = false;
    this.searchBar.style.display = 'none';
    this.clearHighlights();
    this.searchResults = [];
    this.currentResultIndex = -1;
  }

  async search() {
    const query = this.searchInput.value.trim().toLowerCase();
    
    if (!query) {
      this.clearHighlights();
      this.searchResultsLabel.textContent = '0 of 0';
      return;
    }

    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab) return;

    const doc = this.app.pdfRenderer.getDocument(activeTab.id);
    if (!doc) return;

    this.clearHighlights();
    this.searchResults = [];

    // Search through all pages
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      const pageText = textContent.items
        .map(item => item.str)
        .join(' ')
        .toLowerCase();

      if (pageText.includes(query)) {
        this.searchResults.push({
          page: pageNum,
          text: pageText
        });
      }
    }

    if (this.searchResults.length > 0) {
      this.currentResultIndex = 0;
      this.highlightCurrentResult();
    }

    this.updateResultsLabel();
  }

  async highlightCurrentResult() {
    if (this.currentResultIndex < 0 || this.currentResultIndex >= this.searchResults.length) {
      return;
    }

    const result = this.searchResults[this.currentResultIndex];
    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab) return;

    // Navigate to page; goToPage materializes it, so the spans below exist.
    await this.app.pdfRenderer.goToPage(activeTab.id, result.page);

    // Clear previous selection highlighting
    this.clearSelectionHighlight();
    
    // Highlight all occurrences on this page
    this.highlightTextInPage(result.page);
    
    // Add selection highlight to current result
    this.addSelectionHighlight(result.page);
  }

  /** Active tab's viewer — hidden tabs' page containers must never match. */
  activeViewer() {
    const tab = this.app.tabManager.getActiveTab();
    return (tab && this.app.pdfRenderer.getTabViewer(tab.id)) || null;
  }

  textLayerFor(pageNum) {
    const viewer = this.activeViewer();
    const pageContainer = viewer?.querySelector(`.page-container[data-page="${pageNum}"]`);
    return pageContainer?.querySelector('.text-layer') || null;
  }

  highlightTextInPage(pageNum) {
    const query = this.searchInput.value.trim().toLowerCase();
    if (!query) return;

    const textLayer = this.textLayerFor(pageNum);
    if (!textLayer) return;

    const textSpans = textLayer.querySelectorAll('span');
    textSpans.forEach(span => {
      if (span.textContent.toLowerCase().includes(query)) {
        span.style.backgroundColor = 'rgba(255, 255, 0, 0.4)';
        span.classList.add('search-highlight');
      }
    });
  }

  addSelectionHighlight(pageNum) {
    const query = this.searchInput.value.trim().toLowerCase();
    if (!query) return;

    const textLayer = this.textLayerFor(pageNum);
    if (!textLayer) return;

    const textSpans = textLayer.querySelectorAll('span.search-highlight');
    
    // Find the first matching span and add selection highlight
    for (const span of textSpans) {
      if (span.textContent.toLowerCase().includes(query)) {
        span.style.backgroundColor = 'rgba(255, 165, 0, 0.6)';
        span.classList.add('search-selected');
        
        // Scroll to the selected result
        span.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
    }
  }

  clearSelectionHighlight() {
    const selectedSpans = this.activeViewer()?.querySelectorAll('.text-layer span.search-selected') || [];
    selectedSpans.forEach(span => {
      span.style.backgroundColor = 'rgba(255, 255, 0, 0.4)';
      span.classList.remove('search-selected');
    });
  }

  clearHighlights() {
    const textSpans = this.activeViewer()?.querySelectorAll('.text-layer span') || [];
    textSpans.forEach(span => {
      span.style.backgroundColor = '';
      span.classList.remove('search-highlight', 'search-selected');
    });
  }

  nextResult() {
    if (this.searchResults.length === 0) return;

    this.currentResultIndex = (this.currentResultIndex + 1) % this.searchResults.length;
    this.highlightCurrentResult();
    this.updateResultsLabel();
  }

  previousResult() {
    if (this.searchResults.length === 0) return;

    this.currentResultIndex = (this.currentResultIndex - 1 + this.searchResults.length) % this.searchResults.length;
    this.highlightCurrentResult();
    this.updateResultsLabel();
  }

  updateResultsLabel() {
    if (this.searchResults.length === 0) {
      this.searchResultsLabel.textContent = '0 of 0';
    } else {
      this.searchResultsLabel.textContent = `${this.currentResultIndex + 1} of ${this.searchResults.length}`;
    }
  }
}
