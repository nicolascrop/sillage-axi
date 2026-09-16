// Reader-owned channels. Direct child frames are bound by WindowProxy AND a fresh
// nonce; opaque-origin messages never get to select a revision, diagram or API path.
window.SillageWhiteboards = class {
  constructor({ api, notice, feedback }) {
    Object.assign(this, { api, notice, feedback, entries: new Set(), expanded: null, lifecycle: 0, ending: false, disposed: false });
    window.addEventListener('message', event => this.message(event));
    window.addEventListener('beforeunload', event => {
      if ([...this.entries].some(e => e.editing || e.busy || e.failed || e.feedbackBusy || e.feedbackPending)) { event.preventDefault(); event.returnValue = ''; }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.expanded) { event.preventDefault(); this.collapse(this.expanded); }
      const e = this.expanded;
      if (event.key === 'Tab' && e) {
        if (event.shiftKey && event.target === e.edit) {
          event.preventDefault();
          if (e.editing) this.post(e, 'focusLast'); else e.activate.focus();
        } else if (!event.shiftKey && event.target === e.activate) { event.preventDefault(); e.edit.focus(); }
      }
    });
  }
  beginEnd() {
    if (this.disposed || this.ending) return;
    this.ending = true;
    this.lifecycle++;
  }
  cancelEnd() {
    if (this.disposed || !this.ending) return;
    this.ending = false;
    this.lifecycle++;
  }
  post(e, type, data = {}) { e.frame.contentWindow?.postMessage({ ...data, type: 'sillage-whiteboard:' + type, channelId: e.channel }, '*'); }
  element(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  mount(report) {
    for (const [index, diagram] of (report?.diagrams || []).entries()) {
      let passage = document.getElementById('b-' + diagram.block_id);
      if (!passage) continue;
      // Stored HTML/fingerprints stay compatible with v1 code fences. Only the
      // reader projection changes from <pre> to a semantic whiteboard figure.
      if (passage.tagName !== 'FIGURE') {
        const figure = this.element('figure');
        figure.id = passage.id; figure.dataset.blockId = diagram.block_id; figure.tabIndex = 0;
        passage.replaceWith(figure); passage = figure;
      }
      passage.dataset.diagram = 'mermaid';
      const source = this.element('details', null, 'wb-source');
      source.append(this.element('summary', 'Original Mermaid source · ask about this passage'));
      const pre = this.element('pre'); pre.append(this.element('code', diagram.source)); source.append(pre);
      // Old stored HTML may be a <pre>. Do not change its stored identity or revision.
      const host = this.element('div', null, 'wb-host');
      passage.replaceChildren(host, source);
      passage.classList.add('wb-passage');
      this.embed(host, { ...diagram, revision_id: report.id, index });
    }
  }
  embed(host, diagram, historical = false) {
    const e = { ...diagram, host, historical, channel: crypto.randomUUID(), tail: Promise.resolve(), version: null, busy: 0, editing: false, initialized: false, mounted: false };
    const tools = this.element('div', null, 'wb-tools');
    const label = this.element('span', `Whiteboard · revision ${e.revision_id}`);
    const edit = this.element('button', 'Annotate'); edit.type = 'button'; edit.disabled = true;
    const view = this.element('button', 'View / scroll'); view.type = 'button';
    const expand = this.element('button', 'Enlarge'); expand.type = 'button';
    const close = this.element('button', historical ? 'Close history' : 'Close enlarged view'); close.type = 'button'; close.hidden = true;
    tools.append(label, edit, view, expand, close);
    const status = this.element('p', 'Opening local whiteboard…', 'wb-local-status'); status.setAttribute('role', 'status');
    const retry = this.element('button', 'Retry save / reconnect'); retry.type = 'button'; retry.hidden = true;
    const canvas = this.element('div', null, 'wb-canvas');
    const frame = this.element('iframe');
    frame.title = `Excalidraw diagram ${e.index + 1}, report revision ${e.revision_id}`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = '/whiteboard-frame?diagramIndex=' + e.index;
    const activate = this.element('button', 'Click to annotate', 'wb-cover'); activate.type = 'button'; activate.disabled = true;
    Object.assign(e, { frame, status, retry, activate, edit, close, expand });
    edit.onclick = activate.onclick = () => this.mode(e, true);
    view.onclick = () => this.mode(e, false);
    expand.onclick = () => this.enlarge(e);
    close.onclick = () => this.collapse(e);
    retry.onclick = async () => {
      if (!e.mounted) { e.initialized = false; e.initializing = false; e.channel = crypto.randomUUID(); frame.src = frame.src; return; }
      try { await this.flush(e); } catch (error) { this.error(e, error); }
    };
    canvas.append(frame, activate); host.append(tools, status, retry, canvas);
    this.entries.add(e); this.mode(e, false, false);
    e.bootTimer = setTimeout(() => { if (!e.mounted) this.error(e, new Error('Whiteboard did not open. Original Mermaid source is preserved below.')); }, 15_000);
    if (historical) this.enlarge(e);
    return e;
  }
  mode(e, editing, notify = true) {
    e.editing = editing;
    e.frame.classList.toggle('wb-locked', !editing);
    e.frame.tabIndex = editing ? 0 : -1;
    e.frame.inert = !editing;
    e.activate.hidden = editing;
    e.edit.setAttribute('aria-pressed', String(editing));
    if (notify) this.post(e, 'lock', { locked: !editing });
  }
  error(e, error) {
    e.status.textContent = error.message + ' Keep this tab open to retry; saved history is unchanged.';
    e.retry.hidden = false;
  }
  async message(event) {
    const e = [...this.entries].find(e => e.frame.contentWindow === event.source);
    const msg = event.data;
    if (!e || !msg || typeof msg.type !== 'string') return;
    if (msg.type === 'sillage-whiteboard:ready') {
      if (e.initialized || e.initializing) return;
      e.initializing = true;
      const channel = e.channel;
      try {
        const data = await this.api(`/api/whiteboards/${e.revision_id}/${e.block_id}`);
        if (!this.entries.has(e) || e.channel !== channel) return;
        const inherited = data.saved && data.saved.revision_id !== e.revision_id;
        e.version = inherited ? null : data.saved?.id ?? null;
        e.derivedFrom = inherited ? data.saved.id : data.saved?.derived_from ?? null;
        e.initialized = true;
        this.post(e, 'init', { mode: 'inline', diagramIndex: e.index, diagramId: e.block_id, revisionId: e.revision_id,
          source: data.diagram.source, sourceHash: data.diagram.source_hash, saved: data.saved, theme: 'dark', expanded: this.expanded === e });
        if (e.historical) this.post(e, 'staleRevision', { revisionId: this.currentRevision });
        if (inherited) this.post(e, 'inherited', { revisionId: data.saved.revision_id });
        e.retry.hidden = true;
      } catch (error) { this.error(e, error); }
      finally { e.initializing = false; }
      return;
    }
    if (!e.initialized || msg.channelId !== e.channel) return;
    if (msg.type === 'sillage-whiteboard:conversionError') { clearTimeout(e.bootTimer); this.error(e, new Error(msg.error)); }
    if (msg.type === 'sillage-whiteboard:mounted') { clearTimeout(e.bootTimer); e.mounted = true; e.edit.disabled = false; e.activate.disabled = false; e.status.textContent = 'Local whiteboard · view mode'; }
    if (msg.type === 'sillage-whiteboard:mode') this.mode(e, Boolean(msg.editing), false);
    if (msg.type === 'sillage-whiteboard:tabBoundary' && this.expanded === e) (msg.reverse ? e.close : e.edit).focus({ preventScroll: true });
    if (msg.type === 'sillage-whiteboard:maximize') this.enlarge(e);
    if (msg.type === 'sillage-whiteboard:close' && this.expanded === e) this.collapse(e);
    if (msg.type === 'sillage-whiteboard:save') {
      try {
        await this.save(e, msg);
        this.post(e, 'saveResult', { flushId: msg.flushId, ok: true });
      } catch (error) {
        this.error(e, error);
        this.post(e, 'saveResult', { flushId: msg.flushId, ok: false, error: error.message });
      }
    }
    if (msg.type === 'sillage-whiteboard:flushComplete' && msg.flushId === e.flushId) e.finishFlush?.(msg.ok);
    if (msg.type === 'sillage-whiteboard:queueFeedback') {
      if (e.feedbackBusy) return;
      e.feedbackBusy = true;
      try {
        // Preserve the exact feedback request across uncertain acknowledgements.
        if (!e.feedbackPending) {
          const saved = await this.save(e, msg);
          e.feedbackPending = { snapshot_id: saved.id, note: msg.note, client_key: msg.clientKey };
        }
        const thread = await this.api(`/api/whiteboards/${e.revision_id}/${e.block_id}/feedback`, e.feedbackPending);
        e.feedbackPending = null;
        this.post(e, 'queueResult', { ok: true });
        this.feedback(thread);
      } catch (error) { this.post(e, 'queueResult', { ok: false, error: error.message }); this.error(e, error); }
      finally { e.feedbackBusy = false; }
    }
  }
  save(e, message) {
    e.busy++;
    const operation = e.tail.catch(() => {}).then(async () => {
      if (e.failed) { const recovered = await this.api(`/api/whiteboards/${e.revision_id}/${e.block_id}`, e.failed); e.version = recovered.id; e.failed = null; }
      const input = { operation_key: crypto.randomUUID(), expected_version: e.version,
        source_hash: message.sourceHash, text_metrics_version: message.textMetricsVersion, derived_from: e.derivedFrom,
        scene: message.scene, baseline: message.baseline };
      e.failed = input;
      const saved = await this.api(`/api/whiteboards/${e.revision_id}/${e.block_id}`, input);
      e.version = saved.id; e.failed = null; e.retry.hidden = true;
      e.status.textContent = `Saved locally · revision ${e.revision_id} · snapshot ${saved.id}`;
      return saved;
    }).finally(() => e.busy--);
    e.tail = operation;
    return operation;
  }
  flush(e) {
    if (!e.mounted) return e.tail;
    if (e.flushing) return e.flushing;
    e.flushId = crypto.randomUUID();
    e.flushing = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { e.finishFlush = null; reject(new Error('Whiteboard save timed out')); }, 12_000);
      e.finishFlush = ok => { clearTimeout(timer); e.finishFlush = null; ok ? resolve() : reject(new Error('Whiteboard could not save')); };
      this.post(e, 'flush', { flushId: e.flushId });
    }).finally(() => { e.flushing = null; });
    return e.flushing;
  }
  async beforeRevision(next) {
    this.currentRevision = next?.id;
    const inline = [...this.entries].filter(e => !e.historical);
    if (inline.some(e => e.editing || this.expanded === e || e.feedbackBusy || e.feedbackPending)) {
      for (const e of inline) this.post(e, 'staleRevision', { revisionId: next.id });
      this.notice(`Report revision ${next.id} is ready. Finish the whiteboard (View / scroll), close its enlarged view, or retry pending feedback to display it; edits stay on their original revision.`);
      return false;
    }
    try { await Promise.all(inline.map(e => this.flush(e))); }
    catch (error) { this.notice(error.message + '. Report update paused to preserve whiteboard edits; reconnect and retry.'); return false; }
    // An annotation action may race the awaited flush. Never remove a newly
    // active editor or a pending feedback payload just because it was idle before.
    if (inline.some(e => e.editing || this.expanded === e || e.busy || e.failed || e.feedbackBusy || e.feedbackPending)) return false;
    for (const e of inline) { clearTimeout(e.bootTimer); this.entries.delete(e); }
    return true;
  }
  async beforeEnd() {
    const pending = () => [...this.entries].some(e => e.editing || this.expanded === e || e.busy || e.failed || e.feedbackBusy || e.feedbackPending);
    if (pending()) throw new Error('Finish whiteboard editing and retry pending saves or feedback before ending the session.');
    await Promise.all([...this.entries].map(e => this.flush(e)));
    if (pending()) throw new Error('Whiteboard work is still pending. Finish or retry it before ending the session.');
  }
  dispose() {
    this.lifecycle++;
    this.ending = true;
    this.disposed = true;
    for (const e of this.entries) { clearTimeout(e.bootTimer); e.frame.remove(); }
    this.entries.clear();
    this.expanded = null;
  }
  enlarge(e) {
    if (this.expanded) return;
    this.expanded = e;
    this.post(e, 'expanded', { value: true });
    e.returnFocus = document.activeElement;
    e.host.classList.add('wb-enlarged'); e.host.setAttribute('role', 'dialog'); e.host.setAttribute('aria-modal', 'true');
    e.host.setAttribute('aria-label', `Whiteboard revision ${e.revision_id}`);
    e.close.hidden = false; e.expand.hidden = true;
    // Keep the same iframe alive: moving or cloning it would create a second editor.
    e.inert = [];
    for (let ancestor = e.host; ancestor.parentElement; ancestor = ancestor.parentElement) {
      for (const sibling of ancestor.parentElement.children) if (sibling !== ancestor && !sibling.inert) { sibling.inert = true; e.inert.push(sibling); }
    }
    e.close.focus({ preventScroll: true });
  }
  async collapse(e) {
    if (e.historical && (e.feedbackBusy || e.feedbackPending)) {
      this.error(e, new Error('Retry the pending feedback before closing this historical scene.'));
      return;
    }
    // Lock BEFORE taking the final snapshot, like Lavish's teardown handshake.
    // Otherwise a keystroke during the HTTP write could disappear with the frame.
    this.mode(e, false);
    e.close.focus({ preventScroll: true });
    try { await this.flush(e); } catch (error) { this.error(e, error); return; }
    this.post(e, 'expanded', { value: false });
    e.host.classList.remove('wb-enlarged'); e.host.removeAttribute('role'); e.host.removeAttribute('aria-modal');
    for (const sibling of e.inert || []) sibling.inert = false;
    e.close.hidden = true; e.expand.hidden = false; this.expanded = null;
    e.returnFocus?.focus({ preventScroll: true });
    if (e.historical) { clearTimeout(e.bootTimer); e.host.remove(); this.entries.delete(e); }
  }
  async history(container) {
    if (this.disposed || this.ending) return;
    const lifecycle = this.lifecycle;
    const history = await this.api('/api/whiteboards');
    if (this.disposed || this.ending || lifecycle !== this.lifecycle) return;
    container.replaceChildren();
    if (!history.length) container.append(this.element('p', 'No saved whiteboards yet.'));
    for (const saved of history) {
      const button = this.element('button', `Revision ${saved.revision_id} · diagram ${saved.block_id.slice(0, 8)} · snapshot ${saved.id}`);
      button.type = 'button';
      button.onclick = async () => {
        if (this.disposed || this.ending || this.expanded) return;
        const actionLifecycle = this.lifecycle;
        const existing = [...this.entries].find(e => e.revision_id === saved.revision_id && e.block_id === saved.block_id);
        if (existing) { this.enlarge(existing); return; }
        try {
          const data = await this.api(`/api/whiteboards/${saved.revision_id}/${saved.block_id}`);
          if (this.disposed || this.ending || actionLifecycle !== this.lifecycle) return;
          const host = this.element('div', null, 'wb-host'); document.body.append(host);
          this.embed(host, data.diagram, true);
        } catch (error) { this.notice(error.message); }
      };
      container.append(button);
    }
  }
};
