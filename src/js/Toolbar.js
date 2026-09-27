let popoverClickHandlerRegistered = false;

export class Toolbar {
  constructor(app) {
    this.app = app;
    this.activePopover = null;
    this.activeTool = null;
    
    this.init();
  }

  init() {
    this.setupToolButtons();
    this.setupZoomButtons();
    this.setupPageNavigation();
    this.setupViewControls();
    this.setupFileButtons();

    // Initialize save button to saved state (no changes initially)
    setTimeout(() => {
      const saveBtn = document.getElementById('btn-save');
      if (saveBtn) {
        saveBtn.classList.add('saved');
      }
    }, 100);
    
    // REMOVE: this.setupPopovers();
    // Popover setup will be called after all managers are initialized
    if (!popoverClickHandlerRegistered) {
      document.addEventListener('click', (e) => {
        if (
          document.querySelector('.popover[style*="block"]') &&
          !e.target.closest('.popover') &&
          !e.target.closest('.toolbar-btn') &&
          !e.target.closest('.open-file-btn') &&
          !e.target.closest('.settings-option') &&
          !(e.target.tagName === 'INPUT' && (e.target.type === 'checkbox' || e.target.type === 'range'))
        ) {
          document.querySelectorAll('.popover').forEach(p => p.style.display = 'none');
        }
      });
      popoverClickHandlerRegistered = true;
    }
  }

  /**
   * Mark save button as having unsaved changes
   */
  markUnsavedChanges() {
    const saveBtn = document.getElementById('btn-save');
    if (saveBtn) {
      saveBtn.classList.remove('saved');
    }
  }

  setupToolButtons() {
    // Table of Contents
    document.getElementById('btn-toc').addEventListener('click', () => {
      this.app.sidebar.toggle();
    });

    // Highlight button - activates tool
    document.getElementById('btn-highlight').addEventListener('click', () => {
      this.activateTool('highlight');
    });

    // Highlight arrow - opens popover
    document.getElementById('btn-highlight-arrow').addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePopover('highlight', e.target);
    });

    // Draw button - activates tool
    document.getElementById('btn-draw').addEventListener('click', () => {
      this.activateTool('draw');
    });

    // Draw arrow - opens new dropdown
    document.getElementById('btn-draw-arrow').addEventListener('click', (e) => {
      e.stopPropagation();
      const button = e.target.closest('.toolbar-btn-arrow') || e.target;
      this.app.annotationManager.toggleDrawToolDropdown(button);
    });

    // Erase button (no dropdown)
    document.getElementById('btn-erase').addEventListener('click', () => {
      this.activateTool('erase');
    });

    // Text button (no dropdown)
    document.getElementById('btn-text').addEventListener('click', () => {
      this.activateTool('text');
    });
  }

  activateTool(toolName) {
    // Deactivate current tool
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.remove('active');
    });

    // Activate new tool
    if (this.activeTool === toolName) {
      // Toggle off
      this.activeTool = null;
      this.app.annotationManager.setActiveTool(null);
    } else {
      this.activeTool = toolName;
      const toolBtn = document.querySelector(`[data-tool="${toolName}"]`);
      if (toolBtn) {
        toolBtn.classList.add('active');
      }
      this.app.annotationManager.setActiveTool(toolName);
    }

    // Update tab state
    const activeTab = this.app.tabManager.getActiveTab();
    if (activeTab) {
      this.app.tabManager.updateTab(activeTab.id, { activeTool: this.activeTool });
    }
  }

  setupZoomButtons() {
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      this.zoomIn();
    });

    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      this.zoomOut();
    });

    document.getElementById('btn-fit-width').addEventListener('click', () => {
      this.fitToWidth();
    });
  }

  zoomIn() {
    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab) return;

    const newZoom = Math.min(activeTab.zoom + 0.25, 3.0);
    this.app.tabManager.updateTab(activeTab.id, { zoom: newZoom });
    this.app.pdfRenderer.setZoom(activeTab.id, newZoom);
  }

  zoomOut() {
    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab) return;

    const newZoom = Math.max(activeTab.zoom - 0.25, 0.5);
    this.app.tabManager.updateTab(activeTab.id, { zoom: newZoom });
    this.app.pdfRenderer.setZoom(activeTab.id, newZoom);
  }

  fitToWidth() {
    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab) return;

    const container = document.getElementById('pdf-container');
    const containerWidth = container.clientWidth - 40; // padding
    
    this.app.pdfRenderer.fitToWidth(activeTab.id, containerWidth);
  }

  setupPageNavigation() {
    const pageInput = document.getElementById('page-number');
    
    pageInput.addEventListener('change', () => {
      const pageNum = parseInt(pageInput.value);
      const activeTab = this.app.tabManager.getActiveTab();
      
      if (activeTab) {
        const doc = this.app.pdfRenderer.getDocument(activeTab.id);
        if (doc && pageNum >= 1 && pageNum <= doc.numPages) {
          this.app.pdfRenderer.goToPage(activeTab.id, pageNum);
          this.app.tabManager.updateTab(activeTab.id, { currentPage: pageNum });
        } else {
          pageInput.value = activeTab.currentPage;
        }
      }
    });

    // Rotate button
    document.getElementById('btn-rotate').addEventListener('click', () => {
      this.rotatePage();
    });
  }

  rotatePage() {
    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab) return;

    const newRotation = (activeTab.rotation + 90) % 360;
    this.app.tabManager.updateTab(activeTab.id, { rotation: newRotation });
    this.app.pdfRenderer.setRotation(activeTab.id, newRotation);
  }

  setupViewControls() {
    document.getElementById('btn-page-layout').addEventListener('click', (e) => {
      console.log('Page layout button clicked');
      this.togglePopover('page-layout', e.target);
    });
  }

  setupFileButtons() {
    // AI chat
    const aiChatBtn = document.getElementById('btn-ai-chat');
    if (aiChatBtn) {
      aiChatBtn.addEventListener('click', () => {
        this.app.aiChatPanel?.toggle();
      });
    }

    document.getElementById('btn-search').addEventListener('click', () => {
      this.app.searchManager.toggleSearch();
    });

    document.getElementById('btn-print').addEventListener('click', () => {
      this.print();
    });

    document.getElementById('btn-save').addEventListener('click', () => {
      this.save();
    });

    document.getElementById('btn-fullscreen').addEventListener('click', () => {
      this.toggleFullscreen();
    });

    document.getElementById('btn-settings').addEventListener('click', (e) => {
      this.togglePopover('settings', e.target);
    });
  }

  async print() {
    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab) return;

    // Virtualized pages must all be rendered for print.
    // ponytail: materialize-all for print; chunked print canvas if a 500-page print ever OOMs
    await this.app.pdfRenderer.materializeAll(activeTab.id);
    const sweep = () => {
      window.removeEventListener('afterprint', sweep);
      this.app.pdfRenderer.dematerializeOffscreen(activeTab.id);
    };
    window.addEventListener('afterprint', sweep);

    window.print();
  }

  async save() {
    const activeTab = this.app.tabManager.getActiveTab();
    if (!activeTab || !activeTab.hasChanges) return;

    const saveBtn = document.getElementById('btn-save');

    try {
      // Always export a real PDF with embedded annotations using the shared export engine.
      const pdfData = await this.app.pdfRenderer.exportPDF(activeTab.id);

      if (window.electronAPI) {
        // Electron: Save to existing path, otherwise prompt Save As.
        if (activeTab.path) {
          const result = await this.app.pdfRenderer.saveExportedPdf(pdfData, {
            platform: 'electron',
            filePath: activeTab.path
          });

          if (!result?.success) throw new Error(result?.error || 'Failed to save PDF');
        } else {
          const defaultName = (activeTab.name || 'document').replace(/\.pdf$/i, '') + '-edited.pdf';
          const saveAs = await window.electronAPI.savePdfDialog({
            defaultPath: defaultName
          });
          if (!saveAs?.success) return; // user canceled

          const result = await this.app.pdfRenderer.saveExportedPdf(pdfData, {
            platform: 'electron',
            filePath: saveAs.filePath
          });
          if (!result?.success) throw new Error(result?.error || 'Failed to save PDF');

          // Update tab path so future saves overwrite.
          this.app.tabManager.updateTab(activeTab.id, { path: saveAs.filePath, name: saveAs.fileName || activeTab.name });
        }
      } else {
        // Web
        await this.app.pdfRenderer.saveExportedPdf(pdfData, {
          platform: 'web',
          filename: (activeTab.name || 'document').replace(/\.pdf$/i, '') + '-edited.pdf'
        });
      }

      this.app.tabManager.updateTab(activeTab.id, { hasChanges: false });
      saveBtn?.classList.add('saved');
      alert('File saved successfully');
    } catch (e) {
      console.error('Save failed:', e);
      alert('Error saving file: ' + (e?.message || String(e)));
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

  setupPopovers() {
    // Draw popover
    this.setupDrawPopover();
    
    // Highlight popover
    this.setupHighlightPopover();
    
    // Page layout popover
    this.setupPageLayoutPopover();
    
    // Settings popover
    this.setupSettingsPopover();
  }

  setupDrawPopover() {
    const popover = document.getElementById('popover-draw');
    const colorGrid = document.getElementById('draw-color-grid');
    const thicknessSlider = document.getElementById('draw-thickness');
    const thicknessPreview = document.getElementById('draw-thickness-preview');

    // Create color grid
    const colors = [
      '#000000', '#333333', '#666666', '#999999', '#CCCCCC', '#FFFFFF',
      '#FF0000', '#FF6600', '#FFCC00', '#FFFF00', '#99FF00', '#00FF00',
      '#00FF99', '#00FFFF', '#0099FF', '#0000FF', '#9900FF', '#FF00FF',
      '#FF0066', '#FF9999', '#FFCC99', '#FFFF99', '#CCFF99', '#99FF99',
      '#99FFCC', '#99FFFF', '#99CCFF', '#9999FF', '#CC99FF', '#FF99FF'
    ];

    colors.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.style.background = color;
      swatch.addEventListener('click', () => {
        colorGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        this.app.annotationManager.setDrawColor(color);
      });
      colorGrid.appendChild(swatch);
    });

    // Set default
    colorGrid.firstChild.classList.add('active');

    // Thickness slider
    thicknessSlider.addEventListener('input', () => {
      const thickness = thicknessSlider.value;
      thicknessPreview.style.height = `${thickness}px`;
      this.app.annotationManager.setDrawThickness(thickness);
    });
  }

  setupHighlightPopover() {
    const popover = document.getElementById('popover-highlight');
    const colorRow = document.getElementById('highlight-color-row');
    const strokeCanvas = document.getElementById('highlight-stroke-canvas');
    const thicknessSlider = document.getElementById('highlight-thickness-slider');
    const textToggle = document.getElementById('highlight-text-toggle');

    // Fixed highlight palette
    const colors = [
      { name: 'Highlight Yellow', value: '#FFF176' },
      { name: 'Highlight Green', value: '#7CFF6B' },
      { name: 'Highlight Blue', value: '#9EE7FF' },
      { name: 'Highlight Pink', value: '#FF9EDB' },
      { name: 'Highlight Red', value: '#FF5A5A' }
    ];

    // Remove any existing swatches
    colorRow.innerHTML = '';
    colors.forEach((color, idx) => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.style.background = color.value;
      swatch.title = color.name;
      if (this.app.annotationManager.highlightColor === color.value || (idx === 0 && !this.app.annotationManager.highlightColor)) {
        swatch.classList.add('selected');
      }
      swatch.addEventListener('click', (event) => {
        colorRow.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
        this.app.annotationManager.setHighlightColor(color.value);
        renderStrokePreview();
        setTimeout(() => this.closeAllPopovers(), 0); // allow other click events to fire
        event.stopPropagation();
      });
      colorRow.appendChild(swatch);
    });

    // Stroke preview rendering
    function renderStrokePreview() {
      const ctx = strokeCanvas.getContext('2d');
      ctx.clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
      // Find selected color
      const selected = colorRow.querySelector('.color-swatch.selected');
      const color = selected ? selected.style.background : colors[0].value;
      const thickness = parseInt(thicknessSlider.value, 10);
      // Draw organic stroke
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = thickness;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(10, 12 + Math.sin(0) * 2);
      for (let x = 10; x <= 80; x += 7) {
        ctx.lineTo(x, 12 + Math.sin(x / 10) * 4);
      }
      ctx.stroke();
      ctx.restore();
    }
    thicknessSlider.addEventListener('input', () => {
      this.app.annotationManager.setHighlightThickness(parseInt(thicknessSlider.value, 10));
      renderStrokePreview();
    });

    // Initial render
    renderStrokePreview();

    // Toggle switch logic
    function setToggle(on) {
      if (on) {
        textToggle.classList.add('on');
      } else {
        textToggle.classList.remove('on');
      }
    }
    setToggle(this.app.annotationManager.highlightTextOnly);
    textToggle.onclick = () => {
      const isOn = !textToggle.classList.contains('on');
      setToggle(isOn);
      this.app.annotationManager.setHighlightTextOnly(isOn);
    };
  }

  setupPageLayoutPopover() {
    const popover = document.getElementById('popover-page-layout');
    const options = popover.querySelectorAll('.layout-option');

    console.log('Setting up page layout popover', { popover, options: options.length });

    options.forEach(option => {
      option.addEventListener('click', () => {
        const layout = option.dataset.layout;
        console.log('Layout option clicked:', layout);
        
        options.forEach(o => o.classList.remove('active'));
        option.classList.add('active');
        
        const activeTab = this.app.tabManager.getActiveTab();
        if (activeTab) {
          console.log('Setting layout for tab:', activeTab.id, layout);
          this.app.tabManager.updateTab(activeTab.id, { pageLayout: layout });
          this.app.pdfRenderer.setPageLayout(activeTab.id, layout);
        }
        
        this.closeAllPopovers();
      });
    });

    // Set default
    options[0].classList.add('active');
  }

  setupSettingsPopover() {
    const darkModeCheckbox = document.getElementById('setting-dark-mode');
    const hideAnnotationsCheckbox = document.getElementById('setting-hide-annotations');
    const docPropertiesBtn = document.getElementById('btn-doc-properties');

    darkModeCheckbox.addEventListener('change', () => {
      const theme = darkModeCheckbox.checked ? 'dark' : 'light';
      this.app.settingsManager.setTheme(theme);
    });

    hideAnnotationsCheckbox.addEventListener('change', () => {
      this.app.settingsManager.setHideAnnotations(hideAnnotationsCheckbox.checked);
    });

    docPropertiesBtn.addEventListener('click', () => {
      this.app.settingsManager.showDocumentProperties();
      this.closeAllPopovers();
    });

    // Setup modal controls
    this.setupDocumentPropertiesModal();
  }

  setupDocumentPropertiesModal() {
    const modal = document.getElementById('doc-properties-modal');
    const closeBtn = document.getElementById('doc-properties-close');
    const okBtn = document.getElementById('doc-properties-ok');
    const tabs = document.querySelectorAll('.prop-tab');
    const panels = document.querySelectorAll('.prop-panel');

    // Close modal handlers
    const closeModal = () => {
      modal.style.display = 'none';
    };

    closeBtn.addEventListener('click', closeModal);
    okBtn.addEventListener('click', closeModal);

    // Click outside to close
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });

    // Tab switching
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.dataset.tab;
        
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        panels.forEach(panel => {
          panel.classList.remove('active');
          if (panel.id === `prop-${targetTab}`) {
            panel.classList.add('active');
          }
        });
      });
    });
  }

  togglePopover(type, anchorElement) {
    const popoverId = `popover-${type}`;
    const popover = document.getElementById(popoverId);

    if (this.activePopover === popoverId && popover.style.display === 'block') {
      this.closeAllPopovers();
      return;
    }

    this.closeAllPopovers();

    const rect = anchorElement.getBoundingClientRect();
    popover.style.display = 'block';
    
    // Check if this is a right-aligned button (settings, etc.)
    const isRightAligned = anchorElement.closest('.toolbar-right');
    
    if (isRightAligned) {
      // Position from the right edge to prevent going off-screen
      popover.style.left = 'auto';
      popover.style.right = `${window.innerWidth - rect.right}px`;
    } else {
      // Normal left positioning
      popover.style.left = `${rect.left}px`;
      popover.style.right = 'auto';
    }
    
    popover.style.top = `${rect.bottom + 4}px`;

    this.activePopover = popoverId;
  }

  closeAllPopovers() {
    document.querySelectorAll('.popover').forEach(p => {
      p.style.display = 'none';
    });
    
    // Also close draw and highlight dropdowns
    document.querySelectorAll('.draw-tool-dropdown, .highlight-popover').forEach(d => {
      d.classList.remove('open');
    });
    
    this.activePopover = null;
  }

  restoreTabState(tab) {
    // Restore tool
    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.classList.remove('active');
    });

    if (tab.activeTool) {
      const toolBtn = document.querySelector(`[data-tool="${tab.activeTool}"]`);
      if (toolBtn) {
        toolBtn.classList.add('active');
      }
      this.activeTool = tab.activeTool;
    } else {
      this.activeTool = null;
    }

    // Restore TOC button state
    const tocBtn = document.getElementById('btn-toc');
    if (tab.sidebarOpen) {
      tocBtn.classList.add('active');
    } else {
      tocBtn.classList.remove('active');
    }
  }
}
