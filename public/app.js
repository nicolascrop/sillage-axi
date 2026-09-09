const $ = id => document.getElementById(id);
let report = null;
let threads = [];
let bubble = null;
let polling = false;
let importing = false;
let selectionHandled = false;

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
  $('reload').hidden = true;
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
function labels(thread) {
  return [thread.closed ? 'closed' : 'open', thread.unread ? 'unread' : '',
    thread.anchor_status === 'needs_review' ? 'passage to review' : '',
    thread.request_status].filter(Boolean).join(' · ');
}
function renderThreads() {
  const visible = threads.filter(t => $('thread-filter').value === 'all' || !t.closed || t.unread || t.anchor_status === 'needs_review');
  $('thread-count').textContent = `(${visible.length})`;
  $('threads').replaceChildren(...visible.map(thread => {
    const button = node('button', undefined, 'thread-card');
    button.type = 'button';
    button.dataset.threadId = thread.id;
    button.append(node('span', labels(thread), thread.anchor_status === 'needs_review' ? 'review' : 'muted'),
      node('strong', thread.messages[0].body.slice(0, 110)), node('q', thread.quote.slice(0, 100)));
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
  $('bubble-status').textContent = 'Draft — not saved yet';
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
  const signature = JSON.stringify(thread);
  if (bubble?.drawn === signature) return;
  if (bubble) bubble.drawn = signature;
  $('bubble-title').textContent = 'Saved conversation';
  $('bubble-anchor').textContent = thread.anchor_status === 'needs_review'
    ? `Passage to review — no safe match in revision ${thread.current_revision_id}. Original context kept; not reattached.`
    : `Original revision ${thread.revision_id} · passage still matched in revision ${thread.current_revision_id}`;
  $('bubble-anchor').classList.toggle('review', thread.anchor_status === 'needs_review');
  $('bubble-quote').textContent = thread.quote;
  $('bubble-status').textContent = thread.request_status === 'waiting' ? 'Saved locally / waiting for an agent' :
    thread.request_status === 'reserved' ? 'Saved locally / reserved by an agent (lease expires if abandoned)' :
      thread.request_status === 'failed' ? 'Saved locally / agent reported failure' : 'Saved locally / answered';
  $('question-form').hidden = true;
  $('messages').replaceChildren(...thread.messages.map(message => {
    const item = node('section', undefined, 'message');
    // Questions, replies, and citation quotes are always plain text, never HTML.
    item.append(node('strong', message.role === 'user' ? 'You' : 'Local agent'), node('p', message.body));
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
async function refreshThreads() {
  if (polling || importing) return;
  polling = true;
  try {
    threads = await api('/api/threads');
    renderThreads();
    if (bubble?.threadId) {
      const thread = threads.find(t => t.id === bubble.threadId);
      if (thread) drawThread(thread);
    }
    if (report && threads.some(t => t.current_revision_id !== report.id)) {
      notice('A newer revision was imported in another tab. Your reading position is unchanged.');
      $('reload').hidden = false;
    }
  } catch (error) { notice(`Local service unavailable. Saved threads remain on disk. ${error.message}`); }
  finally { polling = false; }
}

$('import-toggle').addEventListener('click', () => { $('import-panel').hidden = !$('import-panel').hidden; });
$('file').addEventListener('change', async () => {
  const file = $('file').files[0];
  if (!file) return;
  if (file.size > 1_000_000) { notice('Choose a Markdown file under 1 MB.'); return; }
  try { $('source').value = await file.text(); $('title').value = file.name.replace(/\.(md|markdown)$/i, ''); }
  catch (error) { notice(error.message); }
});
$('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!closeBubble()) return;
  importing = true;
  $('import-submit').disabled = true;
  try {
    renderDocument(await api('/api/document', { title: $('title').value, source: $('source').value }));
    notice(`Revision ${report.id} saved. Changed or ambiguous passages are marked for review, never moved silently.`);
  } catch (error) { notice(error.message); }
  finally { importing = false; $('import-submit').disabled = false; }
  await refreshThreads();
});
$('reload').addEventListener('click', async () => {
  if (!closeBubble()) return;
  try { renderDocument(await api('/api/document')); await refreshThreads(); }
  catch (error) { notice(error.message); }
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
