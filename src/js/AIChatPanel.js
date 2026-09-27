const UNGROUNDED = 'Not found in document.';

/**
 * One chat session per tab. Session:
 *   { tabId, state: 'idle'|'ingesting'|'querying', msgs: [], seq, ctrl }
 * Message roles: 'user' | 'assistant' | 'status' (transient, cancellable) |
 * 'system' (indexing result). `seq` orphans deliveries from cancelled or
 * superseded requests.
 */
export class AIChatPanel {
  constructor(app) {
    this.app = app;

    this.panel = document.getElementById('ai-chat-panel');
    this.overlay = document.getElementById('ai-chat-overlay');
    this.closeBtn = document.getElementById('btn-ai-chat-close');
    this.form = document.getElementById('ai-chat-form');
    this.input = document.getElementById('ai-chat-text');
    this.sendBtn = document.getElementById('ai-chat-send');
    this.messages = document.getElementById('ai-chat-messages');

    this._chats = new Map();

    this.app?.tabManager?.on?.('tabChanged', () => this._render());
    this.app?.tabManager?.on?.('tabClosed', (tabId) => this._dropTab(tabId));

    this._bind();
    this._render();
  }

  // ── session state ─────────────────────────────────────────────────────────
  _activeTab() {
    return this.app?.tabManager?.getActiveTab?.() || null;
  }

  _session(tabId) {
    let s = this._chats.get(tabId);
    if (!s) {
      s = { tabId, state: 'idle', msgs: [], seq: 0, ctrl: null };
      this._chats.set(tabId, s);
    }
    return s;
  }

  _dropTab(tabId) {
    const s = this._chats.get(tabId);
    if (!s) return;
    s.seq++;                      // any in-flight delivery is now orphaned
    try { s.ctrl?.abort(); } catch { /* already gone */ }
    this._chats.delete(tabId);
    this._render();
  }

  _cancel(s) {
    s.seq++;                      // orphan the in-flight delivery
    s.state = 'idle';
    try { s.ctrl?.abort(); } catch { /* already gone */ }
    s.ctrl = null;
    const pending = [...s.msgs].reverse().find((m) => m.role === 'status' && !m.cancelled);
    if (pending) {
      pending.cancelled = true;
      pending.text = pending.streaming ? `${pending.text} (cancelled)` : '(cancelled)';
    }
    this._render();
  }

  // ── submit flow ───────────────────────────────────────────────────────────
  async _submit() {
    const tab = this._activeTab();
    if (!tab) return;

    const s = this._session(tab.id);
    if (s.state !== 'idle') return;           // busy: ignore duplicate submits

    const text = (this.input?.value || '').trim();
    if (!text) return;
    this.input.value = '';

    // last 3 exchanges of this tab's own transcript (failures aren't real turns)
    const history = s.msgs
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.error)
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.text }));

    s.msgs.push({ role: 'user', text });
    const seq = ++s.seq;
    const ctrl = new AbortController();
    s.ctrl = ctrl;
    this._render();

    try {
      await this._ensureIndexed(tab, s, seq, ctrl.signal);
      if (seq !== s.seq) return;

      const pending = { role: 'status', text: 'Searching…' };
      s.state = 'querying';
      s.msgs.push(pending);
      this._render();

      let sources = [];
      let warnings = [];
      let mock = false;

      for await (const { event, data } of this.app.ragManager.queryStream(text, 5, tab.id, ctrl.signal, history)) {
        if (seq !== s.seq) return;
        if (event === 'sources') {
          sources = Array.isArray(data.sources) ? data.sources : [];
          mock = !!data.mock;
        } else if (event === 'delta') {
          if (!pending.streaming) {
            pending.streaming = true;
            pending.text = '';
          }
          pending.text += String(data.text || '');
          this._paint(pending, tab.id);
        } else if (event === 'done') {
          warnings = Array.isArray(data.warnings) ? data.warnings : [];
        } else if (event === 'error') {
          throw new Error(String(data.message || 'The AI provider failed.'));
        }
      }
      if (seq !== s.seq) return;

      s.msgs.splice(s.msgs.indexOf(pending), 1);
      const answer = pending.text || '(no answer)';
      s.msgs.push({
        role: 'assistant',
        text: answer,
        sources,
        warnings,
        mock,
        ungrounded: answer.trimStart().startsWith(UNGROUNDED),
      });
    } catch (err) {
      if (seq !== s.seq) return;
      s.msgs = s.msgs.filter((m) => m.role !== 'status' || m.cancelled);
      s.msgs.push({ role: 'assistant', text: err?.message || String(err), error: true });
    } finally {
      if (seq === s.seq) {
        s.state = 'idle';
        s.ctrl = null;
        this._render();
      }
    }
  }

  async _ensureIndexed(tab, s, seq, signal) {
    if (this.app.ragManager.getDocIdForTab(tab.id)) return;

    const pdfDoc = this.app?.pdfRenderer?.getDocument?.(tab.id);
    if (!pdfDoc) throw new Error('This tab has no PDF loaded.');

    const pages = pdfDoc.numPages === 1 ? '1 page' : `${pdfDoc.numPages} pages`;
    const pending = { role: 'status', text: `Indexing ${pages}… (first ask only)` };
    s.state = 'ingesting';
    s.msgs.push(pending);
    this._render();

    const data = await pdfDoc.getData();
    if (seq !== s.seq) return;
    if (!(data instanceof Uint8Array) || data.length === 0) {
      throw new Error('Could not read the PDF bytes for indexing.');
    }

    const res = await this.app.ragManager.ingest(data, tab.name || 'document.pdf', tab.id, signal);
    if (seq !== s.seq) return;

    pending.role = 'system';
    pending.text = res?.message || 'Document indexed.';
    this._render();
  }

  // ── rendering (from the session model — never from the DOM) ───────────────
  _render() {
    if (!this.messages) return;

    const tab = this._activeTab();
    const s = tab ? this._chats.get(tab.id) : null;
    this._renderedTabId = tab?.id ?? null;

    this.messages.textContent = '';
    if (!s || s.msgs.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'ai-chat-hint';
      hint.textContent = tab
        ? 'Ask a question about this document — the first ask indexes it.'
        : 'Open a document to ask questions.';
      this.messages.appendChild(hint);
    } else {
      for (const m of s.msgs) this.messages.appendChild(this._bubble(m, s));
    }

    const busy = !!s && s.state !== 'idle';
    if (this.input) this.input.disabled = busy || !tab;
    if (this.sendBtn) this.sendBtn.disabled = busy || !tab;
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  // Streamed deltas repaint the bubble in place — no full re-render per token.
  // A tab switch re-renders from `m.text`, so the model stays the source of truth.
  _paint(m, tabId) {
    if (this._renderedTabId === tabId && m._textEl) m._textEl.textContent = m.text;
  }

  _bubble(m, s) {
    const el = document.createElement('div');
    el.className = `ai-chat-bubble ${m.role}`
      + (m.error ? ' error' : '')
      + (m.cancelled ? ' cancelled' : '');

    if (m.role === 'status') {
      // a child element so streaming deltas can repaint the text without
      // wiping the Cancel button (setting textContent would clear children)
      const body = document.createElement('span');
      body.className = 'ai-chat-status';
      body.textContent = m.text;
      m._textEl = body;
      el.appendChild(body);
      if (!m.cancelled && s.state !== 'idle') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-chat-cancel';
        btn.textContent = 'Cancel';
        btn.addEventListener('click', () => this._cancel(s));
        el.appendChild(btn);
      }
      return el;
    }

    const text = document.createElement('div');
    text.className = 'ai-chat-text';
    text.textContent = m.text;
    el.appendChild(text);

    const badges = [];
    if (m.ungrounded) badges.push('not in document');
    if (m.mock) badges.push('mock');
    if (badges.length) {
      const row = document.createElement('div');
      row.className = 'ai-chat-badges';
      for (const label of badges) {
        const badge = document.createElement('span');
        badge.className = `ai-chat-badge${label === 'mock' ? ' mock' : ''}`;
        badge.textContent = label;
        row.appendChild(badge);
      }
      el.appendChild(row);
    }

    const pages = [...new Set((m.sources || []).map((c) => c?.page).filter(Number.isInteger))];
    if (pages.length) {
      const row = document.createElement('div');
      row.className = 'ai-chat-sources';
      const label = document.createElement('span');
      label.className = 'ai-chat-sources-label';
      label.textContent = 'Sources:';
      row.appendChild(label);
      for (const p of pages) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ai-chat-source-chip';
        chip.textContent = `p.${p}`;
        chip.title = `Jump to page ${p}`;
        chip.addEventListener('click', () => {
          try { this.app?.pdfRenderer?.goToPage?.(s.tabId, p); } catch { /* tab closed */ }
        });
        row.appendChild(chip);
      }
      el.appendChild(row);
    }

    if (m.warnings?.length) {
      const warn = document.createElement('div');
      warn.className = 'ai-chat-warning';
      warn.textContent = m.warnings.join(' ');
      el.appendChild(warn);
    }

    return el;
  }

  _bind() {
    this.overlay?.addEventListener('click', () => this.close());
    this.closeBtn?.addEventListener('click', () => this.close());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen()) this.close();
    });

    this.form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._submit();
    });
  }

  isOpen() {
    return this.panel?.classList.contains('open');
  }

  open() {
    if (!this.panel || !this.overlay) return;
    this.overlay.style.display = 'block';
    this.panel.classList.add('open');
    this.panel.setAttribute('aria-hidden', 'false');

    setTimeout(() => this.input?.focus(), 50);
  }

  close() {
    if (!this.panel || !this.overlay) return;
    this.panel.classList.remove('open');
    this.panel.setAttribute('aria-hidden', 'true');

    setTimeout(() => {
      if (!this.isOpen()) this.overlay.style.display = 'none';
    }, 230);
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }
}
