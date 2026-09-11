const $ = id => document.getElementById(id);
let report = null;
let threads = [];
let activeThread = null;
let drawnThread = null;
let drawnThreads = null;
let threadSelectionInitialized = false;
let bubble = null;
let polling = false;
let selectionHandled = false;
let agent = { state: 'unavailable' };
const drafts = new Map();

async function api(path, body, method = 'POST') {
  const response = await fetch(path, { ...(body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' },
    body: JSON.stringify(body),
  }), signal: AbortSignal.timeout(10_000) });
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
  return (element?.nodeType === 1 ? element : element?.parentElement)?.closest('[data-block-id]');
}
function highlightPassages() {
  $('report').querySelectorAll('.selected-passage').forEach(element => element.classList.remove('selected-passage'));
  const thread = threads.find(t => t.id === activeThread);
  if (thread?.anchor_status === 'matched') passageElement(thread.block_id)?.classList.add('selected-passage');
  if (bubble) passageElement(bubble.blockId)?.classList.add('selected-passage');
}
function renderDocument(value) {
  report = value;
  if (!value) return;
  $('report-title').textContent = value.title;
  $('revision').textContent = `Revision ${value.id} · saved on this PC`;
  // Only the server's Markdown-it + sanitize-html output crosses this boundary.
  $('report').innerHTML = value.html;
  $('toc').replaceChildren(...value.toc.map(heading => {
    const item = node('li', undefined, `depth-${heading.level}`);
    const link = node('a', heading.text);
    link.href = `#b-${heading.id}`;
    item.append(link);
    return item;
  }));
}
function compact(value, max = 80) {
  const text = value.replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function drawAgent(value) {
  agent = value;
  const failed = threads.some(t => t.request_status === 'failed');
  const unavailable = report && value.state !== 'active';
  const hidden = !unavailable && !failed;
  const message = unavailable
    ? 'Replies are paused. Return to the conversation that presented this report and ask it to resume answering in Sillage. Your questions and previous replies are saved.'
    : failed ? 'A reply could not be completed. Select the affected thread for the explanation, then send a follow-up to try again.' : '';
  if ($('answer-alert').hidden !== hidden) $('answer-alert').hidden = hidden;
  if ($('answer-alert').textContent !== message) $('answer-alert').textContent = message;
}
function labels(thread) {
  return [thread.closed ? 'closed' : '', thread.unread ? 'unread' : '',
    thread.anchor_status === 'needs_review' ? 'passage to review' : '',
    thread.request_status === 'failed' ? 'reply failed' : ''].filter(Boolean).join(' · ');
}
function renderThreads() {
  if (!threadSelectionInitialized) {
    if (threads.length) activeThread = threads[0].id;
    threadSelectionInitialized = true;
  } else if (activeThread !== null && !threads.some(t => t.id === activeThread)) {
    activeThread = threads[0]?.id ?? null;
  }
  // Do not replace native options or invalidate focus/accessibility state on idle
  // polls. Presence is independent and must still surface real listening loss.
  const signature = JSON.stringify([threads, activeThread, report?.id]);
  if (signature === drawnThreads) { drawAgent(agent); return; }
  drawnThreads = signature;
  $('thread-count').textContent = `(${threads.length})`;
  const unread = threads.filter(t => t.unread).length;
  const review = threads.filter(t => t.anchor_status === 'needs_review').length;
  $('thread-alert').textContent = [unread ? `${unread} unread` : '', review ? `${review} to review` : ''].filter(Boolean).join(' · ');
  $('thread-select').replaceChildren(...threads.map(thread => {
    const option = node('option', compact(`${labels(thread) ? `${labels(thread)} · ` : ''}${thread.messages[0].body}`));
    option.value = thread.id;
    return option;
  }));
  if (!threads.length) $('thread-select').append(node('option', 'No conversations yet'));
  $('thread-select').disabled = !threads.length;
  $('thread-select').value = activeThread || '';
  $('chat-empty').hidden = Boolean(activeThread);
  $('chat').hidden = !activeThread;
  highlightPassages();
  drawThread();
  drawAgent(agent);
}
function placeBubble(target) {
  const rect = target?.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const width = Math.min(410, viewportWidth - 24);
  $('bubble').style.width = `${width}px`;
  $('bubble').style.left = `${Math.max(12, Math.min((rect?.right ?? 24) - width / 2, viewportWidth - width - 12))}px`;
  const top = Math.min(Math.max(rect?.top ?? 80, 65), Math.max(65, window.innerHeight - 240));
  $('bubble').style.top = `${window.scrollY + top + 12}px`;
}
function closeBubble() {
  // A local draft is reversible UI state; closing never prompts, even while a
  // save is in flight. Its captured payload can still finish durably in the chat.
  const target = bubble?.target;
  bubble = null;
  $('bubble').hidden = true;
  highlightPassages();
  target?.focus({ preventScroll: true });
}
function openQuestion(element, quote) {
  if (!report) return;
  const block = report.blocks.find(b => b.id === element.dataset.blockId);
  if (!block) return;
  const exact = quote || block.source.trim();
  if (exact.length > 20_000) { notice('This passage is large. Select a short quote to ask about it.'); return; }
  closeBubble();
  bubble = { blockId: block.id, revisionId: report.id, quote: exact, target: element, clientKey: crypto.randomUUID() };
  highlightPassages();
  $('bubble').hidden = false;
  $('bubble-anchor').classList.remove('review');
  $('bubble-anchor').textContent = `Revision ${report.id} · ${block.kind} · lines ${block.start_line}–${block.end_line}`;
  $('bubble-quote').textContent = exact;
  $('bubble-status').textContent = 'Draft · not sent';
  $('question').value = '';
  $('question').disabled = false;
  $('question-submit').disabled = false;
  placeBubble(element);
  $('question').focus({ preventScroll: true });
}
function drawThread() {
  const thread = threads.find(t => t.id === activeThread);
  if (!thread) return;
  const signature = JSON.stringify(thread);
  if (drawnThread === signature) return;
  drawnThread = signature;
  $('chat-anchor').textContent = thread.anchor_status === 'needs_review'
    ? `Passage to review — no safe match in revision ${thread.current_revision_id}. Original context kept; not reattached.`
    : `Original revision ${thread.revision_id} · passage matched in revision ${thread.current_revision_id}`;
  $('chat-anchor').classList.toggle('review', thread.anchor_status === 'needs_review');
  $('chat-quote').textContent = thread.quote;
  $('chat-status').textContent = thread.request_status === 'waiting' ? 'Saved · waiting for a reply'
    : thread.request_status === 'reserved' ? 'Saved · preparing a reply'
      : thread.request_status === 'failed' ? 'Reply failed · your question is saved' : 'Saved · answered';
  const log = $('messages');
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.replaceChildren(...thread.messages.map(message => {
    const item = node('section', undefined, `message ${message.role}`);
    const demo = message.worker === 'deterministic-fake-v1';
    item.append(node('strong', message.role === 'user' ? 'You' : demo ? 'Demo adapter · not AI'
      : message.status === 'failed' ? 'Reply could not be completed' : 'Agent'));
    if (message.role === 'agent') {
      const body = node('div', undefined, 'markdown');
      // Same server-side safe renderer as the report. Questions/quotes stay literal.
      body.innerHTML = message.html;
      item.append(body);
    } else item.append(node('p', message.body));
    for (const citation of message.citations) {
      const link = node('button', `Citation · revision ${citation.revision_id}: “${citation.quote}”`, 'citation');
      link.type = 'button';
      link.addEventListener('click', () => {
        const target = passageElement(citation.block_id);
        if (target) target.scrollIntoView({ block: 'center' });
        else notice(`Historical citation (revision ${citation.revision_id}); no current match. Exact quote is preserved in the conversation.`);
      });
      item.append(link);
    }
    return item;
  }));
  if (atEnd) log.scrollTop = log.scrollHeight;
  $('go-source').hidden = thread.anchor_status !== 'matched' || !passageElement(thread.block_id);
  $('mark-read').hidden = !thread.unread;
  $('close-thread').textContent = thread.closed ? 'Reopen thread' : 'Close thread';
  $('snapshot-text').textContent = `Revision ${thread.revision_id}, lines ${thread.context.block.start_line}–${thread.context.block.end_line}\n\n${thread.context.block.source}`;
  drawComposer();
}
function drawComposer() {
  const draft = drafts.get(activeThread);
  const thread = threads.find(t => t.id === activeThread);
  const busy = ['waiting', 'reserved'].includes(thread?.request_status);
  $('followup').value = draft?.text || '';
  $('followup').disabled = Boolean(draft?.payload) || busy;
  $('followup-submit').disabled = Boolean(draft?.saving) || (busy && !draft?.payload);
  $('followup-submit').textContent = draft?.payload && !draft.saving ? 'Retry message' : 'Send message';
  $('followup-status').textContent = draft?.error || (draft?.saving ? 'Saving…' : busy ? 'You can continue when this reply finishes.' : '');
}
async function selectThread(id, markRead = true) {
  activeThread = id;
  drawnThread = null;
  renderThreads();
  $('messages').scrollTop = $('messages').scrollHeight;
  if (markRead && threads.find(t => t.id === id)?.unread) {
    try { await api(`/api/conversations/${id}`, { unread: false }, 'PATCH'); await refreshThreads(); }
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
  renderDocument(value);
  if (anchor) window.scrollBy(0, passageElement(anchor.id).getBoundingClientRect().top - anchor.top);
  else window.scrollTo(0, y);
  if (focusId) passageElement(focusId)?.focus({ preventScroll: true });
  if (bubble) {
    bubble.target = passageElement(bubble.blockId);
    $('bubble-anchor').textContent = bubble.target
      ? `Draft kept against original revision ${bubble.revisionId} · passage safely matched in revision ${report.id}`
      : `Passage to review — draft kept against original revision ${bubble.revisionId}. No safe current match; asking will preserve the original context.`;
    $('bubble-anchor').classList.toggle('review', !bubble.target);
    placeBubble(bubble.target);
  }
  notice(`Revision ${value.id} loaded automatically. ${anchor ? 'Reading position kept at a safely matched passage.' : 'No safe reading anchor; approximate scroll position kept.'} Original conversation context is preserved.`);
}
async function refreshThreads() {
  if (polling) return;
  polling = true;
  try {
    const state = await api('/api/state');
    if (state.revision_id !== (report?.id ?? null)) updateDocument(await api('/api/document'));
    agent = state.agent;
    threads = await api('/api/conversations');
    renderThreads();
  } catch (error) {
    drawAgent({ state: 'unavailable' });
    notice(`Local service cannot be reached. Return to the presenting conversation to resume it, then reload. Saved threads remain on disk. ${error.message}`);
  } finally { polling = false; }
}

$('toc-toggle').addEventListener('click', () => {
  $('toc-panel').hidden = !$('toc-panel').hidden;
  $('toc-toggle').setAttribute('aria-expanded', String(!$('toc-panel').hidden));
  $('layout').classList.toggle('toc-collapsed', $('toc-panel').hidden);
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
function quoteSelection() {
  const selection = window.getSelection();
  const quote = selection?.toString().trim();
  selectionHandled = Boolean(quote);
  if (!quote) return;
  if (quote.length > 2000) { notice('Select at most 2,000 characters for a short quote.'); return; }
  const first = nearestPassage(selection.anchorNode);
  const last = nearestPassage(selection.focusNode);
  if (!first || first !== last || !$('report').contains(first)) { notice('Select text within a single semantic passage.'); return; }
  openQuestion(first, quote);
}
$('report').addEventListener('mouseup', quoteSelection);
$('report').addEventListener('keyup', event => { if (event.key === 'Shift') quoteSelection(); });
$('question-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!bubble || bubble.saving) return;
  const current = bubble;
  const selectedThread = activeThread;
  current.payload ||= { revision_id: current.revisionId, block_id: current.blockId,
    quote: current.quote, question: $('question').value, client_key: current.clientKey };
  current.saving = true;
  $('question-submit').disabled = true;
  $('question').disabled = true;
  $('bubble-status').textContent = 'Saving locally…';
  try {
    const thread = await api('/api/questions', current.payload);
    const draftIsCurrent = bubble === current;
    if (draftIsCurrent) closeBubble();
    if (draftIsCurrent && activeThread === selectedThread) activeThread = thread.id;
    await refreshThreads();
    notice('Question saved. Continue in the chat.');
  } catch (error) {
    if (bubble === current) {
      $('bubble-status').textContent = `${error.message}. Retry sends this same question safely; close to start a different draft.`;
      $('question-submit').disabled = false;
    } else notice(`Question save was not acknowledged. Check the chat before asking again. ${error.message}`);
  } finally { current.saving = false; }
});
$('followup').addEventListener('input', () => {
  const draft = drafts.get(activeThread) || { clientKey: crypto.randomUUID() };
  if (!draft.payload) { draft.text = $('followup').value; drafts.set(activeThread, draft); }
});
$('followup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const id = activeThread;
  if (!id || (!drafts.get(id)?.payload && ['waiting', 'reserved'].includes(threads.find(t => t.id === id)?.request_status))) return;
  const draft = drafts.get(id) || { text: $('followup').value, clientKey: crypto.randomUUID() };
  if (draft.saving) return;
  draft.payload ||= { question: draft.text, client_key: draft.clientKey };
  draft.saving = true;
  draft.error = '';
  drafts.set(id, draft);
  drawComposer();
  try {
    await api(`/api/conversations/${id}/questions`, draft.payload);
    drafts.delete(id);
    await refreshThreads();
  } catch (error) { draft.error = `${error.message}. Retry sends the same message safely.`; }
  finally { draft.saving = false; if (activeThread === id) drawComposer(); }
});
$('bubble-close').addEventListener('click', closeBubble);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeBubble(); });
window.addEventListener('resize', () => { if (bubble) placeBubble(bubble.target); });
$('thread-select').addEventListener('change', () => selectThread($('thread-select').value));
$('go-source').addEventListener('click', () => {
  const thread = threads.find(t => t.id === activeThread);
  if (thread?.anchor_status === 'matched') passageElement(thread.block_id)?.scrollIntoView({ block: 'center' });
});
for (const [button, field] of [['mark-read', 'unread'], ['close-thread', 'closed']]) {
  $(button).addEventListener('click', async () => {
    const thread = threads.find(t => t.id === activeThread);
    if (!thread) return;
    try {
      await api(`/api/conversations/${thread.id}`, { [field]: field === 'unread' ? false : !thread.closed }, 'PATCH');
      await refreshThreads();
    } catch (error) { notice(error.message); }
  });
}
try { renderDocument(await api('/api/document')); await refreshThreads(); }
catch (error) { notice(`Return to the presenting conversation to resume the local service, then reload. ${error.message}`); }
setInterval(refreshThreads, 2000);
