export class TabManager {
  constructor() {
    this.tabs = new Map();
    this.activeTabId = null;
    this.tabCounter = 0;
    this.listeners = new Map();
    
    this.container = document.getElementById('tabs-container');
  }

  createTab(name, path) {
    const tabId = `tab-${++this.tabCounter}`;
    
    const tab = {
      id: tabId,
      name: name,
      path: path,
      currentPage: 1,
      zoom: 1.0,
      rotation: 0,
      pageLayout: 'single',
      activeTool: null,
      sidebarOpen: false,
      sidebarMode: 'outline',
      hasChanges: false,
      scrollPosition: 0
    };

    this.tabs.set(tabId, tab);
    this.renderTab(tab);
    
    return tabId;
  }

  renderTab(tab) {
    const tabElement = document.createElement('div');
    tabElement.className = 'tab';
    tabElement.dataset.tabId = tab.id;
    
    const tabName = document.createElement('span');
    tabName.className = 'tab-name';
    tabName.textContent = tab.name;
    tabName.title = tab.name;
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTab(tab.id);
    });

    tabElement.appendChild(tabName);
    tabElement.appendChild(closeBtn);
    
    tabElement.addEventListener('click', () => {
      this.setActiveTab(tab.id);
    });

    // Middle click to close
    tabElement.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(tab.id);
      }
    });

    this.container.appendChild(tabElement);
  }

  setActiveTab(tabId) {
    if (this.activeTabId === tabId) return;
    
    // Deactivate current tab
    if (this.activeTabId) {
      const currentElement = this.container.querySelector(`[data-tab-id="${this.activeTabId}"]`);
      if (currentElement) {
        currentElement.classList.remove('active');
      }
    }

    this.activeTabId = tabId;
    
    // Activate new tab
    const newElement = this.container.querySelector(`[data-tab-id="${tabId}"]`);
    if (newElement) {
      newElement.classList.add('active');
      newElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }

    this.emit('tabChanged', tabId);
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // Check for unsaved changes
    if (tab.hasChanges) {
      const confirm = window.confirm(`"${tab.name}" has unsaved changes. Close anyway?`);
      if (!confirm) return;
    }

    // Remove tab element
    const tabElement = this.container.querySelector(`[data-tab-id="${tabId}"]`);
    if (tabElement) {
      tabElement.remove();
    }

    this.tabs.delete(tabId);
    this.emit('tabClosed', tabId);

    // Switch to another tab if this was active
    if (this.activeTabId === tabId) {
      const remainingTabs = Array.from(this.tabs.keys());
      if (remainingTabs.length > 0) {
        this.setActiveTab(remainingTabs[remainingTabs.length - 1]);
      } else {
        this.activeTabId = null;
      }
    }
  }

  getTab(tabId) {
    return this.tabs.get(tabId);
  }

  getActiveTab() {
    return this.tabs.get(this.activeTabId);
  }

  getTabs() {
    return Array.from(this.tabs.values());
  }

  updateTab(tabId, updates) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    Object.assign(tab, updates);
  }

  nextTab() {
    const tabIds = Array.from(this.tabs.keys());
    const currentIndex = tabIds.indexOf(this.activeTabId);
    const nextIndex = (currentIndex + 1) % tabIds.length;
    this.setActiveTab(tabIds[nextIndex]);
  }

  previousTab() {
    const tabIds = Array.from(this.tabs.keys());
    const currentIndex = tabIds.indexOf(this.activeTabId);
    const prevIndex = (currentIndex - 1 + tabIds.length) % tabIds.length;
    this.setActiveTab(tabIds[prevIndex]);
  }

  // Event system
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(callback => callback(data));
    }
  }
}
