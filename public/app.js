const $ = id => document.getElementById(id);
let report = null;
let threads = [];
let bubble = null;
let polling = false;
let importing = false;
let selectionHandled = false;
let agent = { state: 'unavailable' };
let watchedFile = null;
let watchGeneration = 0;

async function api(path, body, method = 'POST') {
  const response = await fetch(path, body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Local service returned ${response.status}`);
  return value;
}
function notice(message) { $('notice').textContent = message; }
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function passageElement(id) { return document.getElementById(`b-${id}`); }
function nearestPassage(element) {
  return (element.nodeType === 1 ? element : element.parentElement)?.closest('[data-block-id]');
}
function renderDocument(value) {
  report = value;
  $('import-panel').hidden = Boolean(value);
  $('import-toggle').setAttribute('aria-expanded', String(!value));
  if (!value) return;
  $('report-title').textContent = value.title;
  $('revision').textContent = `Revision ${value.id} · ${value.blocks.length} addressable passages · saved on this PC`;
  // Only the server's Markdown-it + sanitize-html output crosses this boundary.
  $('report').innerHTML = value.html;
  $('toc').replaceChildren(...value.toc.map(heading => {
    const item = node('li');
    item.className = `depth-${heading.level}`;
    const link = node('a', heading.text);
    link.href = `#b-${heading.id}`;
    item.append(link);
    return item;
  }));
}
function compact(value, max) {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function drawAgent(value) {
  agent = value;
  $('agent-state').textContent = value.state === 'active' ? 'Local agent · active' : 'Local agent · unavailable';
  $('agent-toggle').dataset.state = value.state;
  $('agent-detail').textContent = value.state === 'active'
    ? `${value.worker} is connected locally${value.busy ? ' and answering a question' : ' and ready for queued questions'}.`
    : 'No local agent is connected. Questions stay saved in the queue, but will not answer themselves. Follow the start path below.';
  if (bubble && !bubble.threadId) {
    $('bubble-agent').hidden = value.state === 'active';
    if (!bubble.saving && !bubble.payload) $('bubble-status').textContent = value.state === 'active'
      ? 'Draft — local agent active' : 'Draft — local agent unavailable; you can still queue your question';
  }
}
function labels(thread) {
  return [thread.closed ? 'closed' : 'open', thread.unread ? 'unread' : '',
    thread.anchor_status === 'needs_review' ? 'passage to review' : '',
    thread.request_status].filter(Boolean).join(' · ');
}
function renderThreads() {
  const visible = threads.filter(t => $('thread-filter').value === 'all' || !t.closed || t.unread || t.anchor_status === 'needs_review');
  $('thread-count').textContent = `(${threads.length})`;
  const unread = threads.filter(t => t.unread).length;
  const review = threads.filter(t => t.anchor_status === 'needs_review').length;
  $('thread-alert').textContent = [unread ? `${unread} unread` : '', review ? `${review} to review` : ''].filter(Boolean).map(s => ` · ${s}`).join('');
  $('threads').replaceChildren(...visible.map(thread => {
    const button = node('button', undefined, 'thread-entry');
    button.type = 'button';
    button.dataset.threadId = thread.id;
    button.append(node('strong', compact(thread.messages[0].body, 72)),
      node('span', `About: ${compact(thread.context.block.text || thread.quote, 100)}`, 'thread-summary'),
      node('span', labels(thread), `thread-labels ${thread.anchor_status === 'needs_review' ? 'review' : 'muted'}`));
    button.addEventListener('click', () => openThread(thread));
    return button;
  }));
  if (!visible.length) $('threads').append(node('p', 'No threads yet in this view.', 'muted'));
}
function placeBubble(target) {
  const rect = target?.getBoundingClientRect();
  const width = Math.min(410, window.innerWidth - 24);
  $('bubble').style.width = `${width}px`;
  $('bubble').style.left = `${Math.max(12, Math.min((rect?.right ?? 24) - width / 2, window.innerWidth - width - 12))}px`;
  const top = Math.min(Math.max(rect?.top ?? 80, 65), Math.max(65, window.innerHeight - 240));
  $('bubble').style.top = `${window.scrollY + top + 12}px`;
}
function closeBubble(force = false) {
  if (bubble?.saving) { notice('Saving locally; please wait before closing.'); return false; }
  if (!force && bubble && !bubble.threadId && $('question').value.trim() &&
      !window.confirm('Discard this unsent draft? Saved threads are never deleted.')) return false;
  if (bubble?.blockId) passageElement(bubble.blockId)?.classList.remove('selected-passage');
  const target = bubble?.target;
  bubble = null;
  $('bubble').hidden = true;
  target?.focus({ preventScroll: true });
  return true;
}
function openQuestion(element, quote) {
  if (!report || !closeBubble()) return;
  const block = report.blocks.find(b => b.id === element.dataset.blockId);
  if (!block) return;
  const exact = quote || block.source.trim();
  if (exact.length > 20_000) { notice('This passage is large. Select a short quote to ask about it.'); return; }
  bubble = { blockId: block.id, revisionId: report.id, quote: exact, target: element, clientKey: crypto.randomUUID() };
  element.classList.add('selected-passage');
  $('bubble').hidden = false;
  $('bubble-title').textContent = 'Ask about this passage';
  $('bubble-anchor').classList.remove('review');
  $('bubble-anchor').textContent = `Revision ${report.id} · ${block.kind} · lines ${block.start_line}–${block.end_line}`;
  $('bubble-quote').textContent = exact;
  $('bubble-status').textContent = agent.state === 'active' ? 'Draft — local agent active' : 'Draft — local agent unavailable; you can still queue your question';
  $('bubble-agent').hidden = agent.state === 'active';
  $('messages').replaceChildren();
  $('question-form').hidden = false;
  $('question').value = '';
  $('question').disabled = false;
  $('question-submit').disabled = false;
  for (const id of ['go-source', 'mark-read', 'close-thread', 'snapshot']) $(id).hidden = true;
  placeBubble(element);
  $('question').focus({ preventScroll: true });
}
function drawThread(thread) {
  const signature = JSON.stringify([thread, agent.state]);
  if (bubble?.drawn === signature) return;
  if (bubble) bubble.drawn = signature;
  $('bubble-title').textContent = 'Saved conversation';
  $('bubble-anchor').textContent = thread.anchor_status === 'needs_review'
    ? `Passage to review — no safe match in revision ${thread.current_revision_id}. Original context kept; not reattached.`
    : `Original revision ${thread.revision_id} · passage still matched in revision ${thread.current_revision_id}`;
  $('bubble-anchor').classList.toggle('review', thread.anchor_status === 'needs_review');
  $('bubble-quote').textContent = thread.quote;
  const demo = thread.worker === 'deterministic-fake-v1';
  $('bubble-status').textContent = thread.request_status === 'waiting'
    ? (agent.state === 'active' ? 'Saved locally / waiting in the active local agent’s queue' : 'Saved locally / waiting — local agent unavailable. Connect a local agent to receive an answer.')
    : thread.request_status === 'reserved' ? (demo ? 'Demo adapter processing — not AI' : 'Saved locally / agent working (time-limited reservation)')
      : thread.request_status === 'failed' ? 'Saved locally / answering failed — see explanation below'
        : demo ? 'Saved locally / demo result — not an AI answer' : 'Saved locally / answered';
  $('bubble-agent').hidden = agent.state === 'active' || !['waiting', 'reserved'].includes(thread.request_status);
  $('question-form').hidden = true;
  $('messages').replaceChildren(...thread.messages.map(message => {
    const item = node('section', undefined, 'message');
    // Questions, replies, and citation quotes are always plain text, never HTML.
    item.append(node('strong', message.role === 'user' ? 'You' : demo ? 'Demo adapter · not AI' : message.status === 'failed' ? 'Local answering failure' : 'Local agent'), node('p', message.body));
    for (const citation of message.citations) {
      const link = node('button', `Citation · revision ${citation.revision_id}: “${citation.quote}”`, 'citation');
      link.type = 'button';
      link.addEventListener('click', () => {
        const target = passageElement(citation.block_id);
        if (target) { target.scrollIntoView({ block: 'center' }); placeBubble(target); }
        else notice(`Historical citation (revision ${citation.revision_id}); no current match. Exact quote is preserved in the conversation.`);
      });
      item.append(link);
    }
    return item;
  }));
  $('go-source').hidden = thread.anchor_status !== 'matched' || !passageElement(thread.block_id);
  $('mark-read').hidden = !thread.unread;
  $('close-thread').hidden = false;
  $('close-thread').textContent = thread.closed ? 'Reopen thread' : 'Close thread';
  $('snapshot').hidden = false;
  $('snapshot-text').textContent = `Revision ${thread.revision_id}, lines ${thread.context.block.start_line}–${thread.context.block.end_line}\n\n${thread.context.block.source}`;
}
async function openThread(thread) {
  if (!closeBubble()) return;
  const target = thread.anchor_status === 'matched' ? passageElement(thread.block_id) : null;
  if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('selected-passage'); }
  bubble = { threadId: thread.id, blockId: thread.block_id, target };
  $('bubble').hidden = false;
  drawThread(thread);
  placeBubble(target);
  $('bubble-close').focus({ preventScroll: true });
  if (thread.unread) {
    try { await api(`/api/threads/${thread.id}`, { unread: false }, 'PATCH'); await refreshThreads(); }
    catch (error) { notice(error.message); }
  }
}
function updateDocument(value) {
  if (report?.id === value?.id) return;
  const y = window.scrollY;
  const focusId = document.activeElement?.dataset.blockId;
  const safeIds = new Set(value?.blocks.map(b => b.id));
  const top = document.querySelector('.topbar').getBoundingClientRect().bottom + 16;
  const candidates = [...$('report').querySelectorAll('[data-block-id]')]
    .map(element => ({ id: element.dataset.blockId, top: element.getBoundingClientRect().top }))
    .filter(item => safeIds.has(item.id));
  candidates.sort((a, b) => Math.abs(a.top - top) - Math.abs(b.top - top));
  const anchor = candidates[0];
  const wasImporting = !$('import-panel').hidden;
  renderDocument(value);
  // Keep an explicitly opened setup panel open during background updates.
  if (wasImporting && !importing) {
    $('import-panel').hidden = false;
    $('import-toggle').setAttribute('aria-expanded', 'true');
  }
  if (anchor) window.scrollBy(0, passageElement(anchor.id).getBoundingClientRect().top - anchor.top);
  else window.scrollTo(0, y);
  if (focusId) passageElement(focusId)?.focus({ preventScroll: true });
  if (bubble) {
    bubble.target = passageElement(bubble.blockId);
    bubble.target?.classList.add('selected-passage');
    bubble.drawn = null;
    if (!bubble.threadId) {
      $('bubble-anchor').textContent = bubble.target
        ? `Draft kept against original revision ${bubble.revisionId} · passage safely matched in revision ${report.id}`
        : `Passage to review — draft kept against original revision ${bubble.revisionId}. No safe current match; asking will preserve the original context.`;
      $('bubble-anchor').classList.toggle('review', !bubble.target);
    }
    placeBubble(bubble.target);
  }
  notice(`Revision ${value.id} loaded automatically. ${anchor ? 'Reading position kept at a safely matched passage.' : 'No safe reading anchor; approximate scroll position kept.'} Changed or ambiguous conversations and drafts require review; original context is preserved.`);
}
function watchStatus(message) {
  $('watch-status').textContent = message;
  $('file-state').textContent = message;
}
function stopWatching(message = 'File updates stopped. Imported revisions still appear automatically.') {
  watchedFile = null;
  watchGeneration++;
  $('stop-watch').hidden = true;
  watchStatus(message);
}
async function refreshThreads() {
  if (polling || importing) return;
  polling = true;
  try {
    const state = await api('/api/state');
    if (importing) return;
    drawAgent(state.agent);
    if (state.revision_id !== (report?.id ?? null)) {
      if (watchedFile) stopWatching('File updates paused: another import changed the report. Review it, then reconnect the same file explicitly.');
      const latest = await api('/api/document');
      if (importing) return;
      updateDocument(latest);
    }
    if (watchedFile) {
      const watcher = watchedFile;
      const generation = watchGeneration;
      try {
        const file = await watcher.handle.getFile();
        if (file.size > 1_000_000) throw new Error('Markdown file exceeds 1 MB');
        const source = await file.text();
        if (importing || generation !== watchGeneration) return;
        if (source !== watcher.source) {
          const value = await api('/api/document', { title: report.title, source, expected_revision_id: report.id });
          // Once authorized and committed, an update is durable even if Stop was
          // clicked in flight; a later poll will display it, never re-import it.
          if (importing || generation !== watchGeneration) return;
          watcher.source = source;
          updateDocument(value);
          watchStatus(`Watching ${file.name} · revision ${value.id} saved locally. Stop any time.`);
        }
      } catch (error) { stopWatching(`File updates paused: ${error.message} Reconnect explicitly after reviewing.`); }
    }
    const latestThreads = await api('/api/threads');
    if (importing) return;
    threads = latestThreads;
    renderThreads();
    if (bubble?.threadId) {
      const thread = threads.find(t => t.id === bubble.threadId);
      if (thread) drawThread(thread);
    }
  } catch (error) {
    drawAgent({ state: 'unavailable' });
    if (bubble?.threadId) {
      const thread = threads.find(t => t.id === bubble.threadId);
      if (thread) drawThread(thread);
    }
    notice(`Local service unavailable. Saved threads remain on disk. ${error.message}`);
  } finally { polling = false; }
}

function togglePanel(panel, button) {
  $(panel).hidden = !$(panel).hidden;
  $(button).setAttribute('aria-expanded', String(!$(panel).hidden));
}
$('import-toggle').addEventListener('click', () => togglePanel('import-panel', 'import-toggle'));
$('agent-toggle').addEventListener('click', () => togglePanel('agent-panel', 'agent-toggle'));
$('bubble-agent').addEventListener('click', () => {
  $('agent-panel').hidden = false;
  $('agent-toggle').setAttribute('aria-expanded', 'true');
  $('agent-toggle').focus({ preventScroll: true });
  $('agent-panel').scrollIntoView({ block: 'start' });
});
$('threads-toggle').addEventListener('click', () => {
  togglePanel('threads-panel', 'threads-toggle');
  $('layout').classList.toggle('threads-open', !$('threads-panel').hidden);
});
if (typeof window.showOpenFilePicker !== 'function') {
  $('watch-file').disabled = true;
  watchStatus('Live imported revisions · on. Disk watching unavailable in this browser: reselect the file and Import revision after edits, or use the local relay. File selection alone is only a snapshot.');
} else {
  watchStatus('Live imported revisions · on. No file connected for disk updates; use Import / new revision to connect one explicitly.');
}
$('watch-file').addEventListener('click', async () => {
  if (!report) { notice('Import the report first, then connect that same file.'); return; }
  stopWatching();
  const generation = watchGeneration;
  const revision = report.id;
  try {
    const [handle] = await window.showOpenFilePicker({ multiple: false, types: [
      { description: 'Markdown report', accept: { 'text/markdown': ['.md', '.markdown'] } },
    ] });
    const file = await handle.getFile();
    if (file.size > 1_000_000) throw new Error('Choose a Markdown file under 1 MB');
    const source = await file.text();
    if (generation !== watchGeneration) return;
    if (revision !== report.id || source !== report.source) throw new Error('File does not exactly match the current report. Import it explicitly as a new revision first');
    watchedFile = { handle, source };
    $('stop-watch').hidden = false;
    watchStatus(`Watching ${file.name} · read-only, in this tab only. Stop any time.`);
  } catch (error) {
    if (generation === watchGeneration && error.name !== 'AbortError') stopWatching(error.message);
  }
});
$('stop-watch').addEventListener('click', () => stopWatching());
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file) return;
  if (file.size > 1_000_000) { notice('Choose a Markdown file under 1 MB.'); return; }
  try { $('source').value = await file.text(); $('title').value = file.name.replace(/\.(md|markdown)$/i, ''); }
  catch (error) { notice(error.message); }
});
$('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (importing) return;
  importing = true;
  stopWatching();
  $('import-submit').disabled = true;
  try {
    updateDocument(await api('/api/document', { title: $('title').value, source: $('source').value,
      expected_revision_id: report?.id ?? null }));
  } catch (error) { notice(error.message); }
  finally { importing = false; $('import-submit').disabled = false; }
  await refreshThreads();
});
$('report').addEventListener('click', event => {
  if (selectionHandled) { selectionHandled = false; return; }
  if (event.target.closest('a') || window.getSelection()?.toString().trim()) return;
  const element = nearestPassage(event.target);
  if (element) openQuestion(element);
});
$('report').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('[data-block-id]')) {
    event.preventDefault(); openQuestion(event.target);
  }
});
$('report').addEventListener('mouseup', () => {
  const selection = window.getSelection();
  const quote = selection?.toString().trim();
  selectionHandled = Boolean(quote);
  if (!quote) return;
  if (quote.length > 2000) { notice('Select at most 2,000 characters for a short quote.'); return; }
  const first = nearestPassage(selection.anchorNode);
  const last = nearestPassage(selection.focusNode);
  if (!first || first !== last) { notice('Select text within a single semantic passage.'); return; }
  openQuestion(first, quote);
});
$('question-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!bubble || bubble.threadId || bubble.saving) return;
  const current = bubble;
  // Keep the exact same payload/key on retry, even after an uncertain connection loss.
  current.payload ||= { revision_id: current.revisionId, block_id: current.blockId,
    quote: current.quote, question: $('question').value, client_key: current.clientKey };
  current.saving = true;
  $('question-submit').disabled = true;
  $('question').disabled = true;
  $('bubble-status').textContent = 'Saving locally…';
  try {
    const thread = await api('/api/questions', current.payload);
    current.threadId = thread.id;
    drawThread(thread);
    await refreshThreads();
  } catch (error) {
    $('bubble-status').textContent = `${error.message}. Retry sends this same question safely; close to start a different draft.`;
    $('question-submit').disabled = false;
  } finally { current.saving = false; }
});
$('bubble-close').addEventListener('click', () => closeBubble());
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeBubble(); });
window.addEventListener('resize', () => { if (bubble) placeBubble(bubble.target); });
$('thread-filter').addEventListener('change', renderThreads);
$('go-source').addEventListener('click', () => {
  const target = passageElement(bubble?.blockId);
  if (target) { target.scrollIntoView({ block: 'center' }); placeBubble(target); }
});
for (const [button, field] of [['mark-read', 'unread'], ['close-thread', 'closed']]) {
  $(button).addEventListener('click', async () => {
    const thread = threads.find(t => t.id === bubble?.threadId);
    if (!thread) return;
    try {
      await api(`/api/threads/${thread.id}`, { [field]: field === 'unread' ? false : !thread.closed }, 'PATCH');
      await refreshThreads();
    } catch (error) { notice(error.message); }
  });
}
window.addEventListener('beforeunload', event => {
  if (bubble && !bubble.threadId && $('question').value.trim()) { event.preventDefault(); event.returnValue = ''; }
});
try { renderDocument(await api('/api/document')); await refreshThreads(); }
catch (error) { notice(`Start the local service and reload. ${error.message}`); }
setInterval(refreshThreads, 2000);
