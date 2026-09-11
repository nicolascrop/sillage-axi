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
const questionDrafts = new Map();
let savedNoticeThread = null;

async function api(path, body, method = 'POST') {
  const response = await fetch(path, { ...(body === undefined ? {} : {
    method, headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' },
    body: JSON.stringify(body),
  }), signal: AbortSignal.timeout(10_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Local service returned ${response.status}`);
  return value;
}
function notice(message, conversationId = null, retryKey) {
  const fallbackRetry = [...questionDrafts.entries()]
    .find(([, draft]) => !draft.saving)?.[0] || null;
  const visibleRetry = retryKey === undefined ? fallbackRetry : retryKey;
  if ($('notice').textContent !== message) $('notice').textContent = message;
  savedNoticeThread = conversationId;
  $('notice-chat').hidden = !conversationId;
  $('notice-retry').hidden = !visibleRetry;
  $('notice-retry').disabled = false;
  $('notice-retry').dataset.retryKey = visibleRetry || '';
}
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
function enhanceTables(root, label) {
  for (const table of root.querySelectorAll('table')) {
    if (table.closest('.table-scroll')) continue;
    const region = node('div', undefined, 'table-scroll');
    region.tabIndex = 0;
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', `${label} — scroll horizontally for more columns`);
    const hint = node('p', `${label} · scroll horizontally to compare all columns`, 'table-hint');
    table.before(hint, region);
    region.append(table);
  }
}
function focusDescriptor() {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  if (active === $('thread-select')) return { type: 'thread-select' };
  const choice = active.closest?.('#conversation-choices button');
  if (choice) return { type: 'conversation-choice', threadId: choice.dataset.threadId };
  if (active.matches?.('#report [data-block-id]')) return {
    type: 'passage', blockId: active.dataset.blockId,
  };
  const tableScroll = active.closest?.('.table-scroll');
  const reportTable = tableScroll?.querySelector('table[data-block-id]');
  if (reportTable) return { type: 'table-scroll', blockId: reportTable.dataset.blockId, scrollLeft: tableScroll.scrollLeft };
  const message = tableScroll?.closest('.message');
  if (message) return {
    type: 'response-table', messageId: message.dataset.messageId,
    tableIndex: [...message.querySelectorAll('.table-scroll')].indexOf(tableScroll),
    scrollLeft: tableScroll.scrollLeft,
  };
  return null;
}
function restoreFocus(descriptor) {
  if (!descriptor) return;
  if (descriptor.type === 'thread-select') {
    $('thread-select').focus({ preventScroll: true });
    return;
  }
  if (descriptor.type === 'conversation-choice') {
    [...$('conversation-choices').querySelectorAll('button')]
      .find(button => button.dataset.threadId === descriptor.threadId)?.focus({ preventScroll: true });
    return;
  }
  const passage = passageElement(descriptor.blockId);
  if (descriptor.type === 'table-scroll') {
    const tableScroll = passage?.closest('.table-scroll');
    if (tableScroll) {
      tableScroll.scrollLeft = descriptor.scrollLeft;
      tableScroll.focus({ preventScroll: true });
    }
    return;
  }
  if (descriptor.type === 'response-table') {
    const message = [...$('messages').querySelectorAll('.message')]
      .find(item => item.dataset.messageId === descriptor.messageId);
    const tableScroll = message?.querySelectorAll('.table-scroll')[descriptor.tableIndex];
    if (tableScroll) {
      tableScroll.scrollLeft = descriptor.scrollLeft;
      tableScroll.focus({ preventScroll: true });
    }
    return;
  }
  passage?.focus({ preventScroll: true });
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
  $('revision').textContent = `Revision ${value.id}`;
  // Only the server's Markdown-it + sanitize-html output crosses this boundary.
  $('report').innerHTML = value.html;
  for (const id of ['report', 'report-title', 'toc']) $(id).lang = value.language || '';
  const heading = $('report').querySelector('h1');
  $('report-title').hidden = heading?.textContent.trim() === value.title.trim();
  enhanceTables($('report'), 'Report table');
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
  const focus = focusDescriptor();
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
    const option = node('option', compact(`${thread.messages[0].body}`, 52) + ` · ${thread.id.slice(0, 8)}`);
    option.value = thread.id;
    return option;
  }));
  if (!threads.length) {
    const empty = node('option', 'No conversations yet');
    empty.value = '';
    $('thread-select').append(empty);
  }
  $('conversation-list').hidden = !threads.length;
  $('conversation-choices').replaceChildren(...threads.map(thread => {
    const item = node('li');
    const button = node('button');
    button.type = 'button';
    button.dataset.threadId = thread.id;
    button.setAttribute('aria-current', String(thread.id === activeThread));
    const preview = node('span', compact(readableQuote(thread.quote, thread.context.block), 160), 'muted');
    preview.lang = thread.language || '';
    button.append(node('strong', thread.messages[0].body), preview,
      node('span', `Revision ${thread.revision_id} · ${labels(thread) || 'Saved'}`, 'muted'));
    button.addEventListener('click', () => {
      selectThread(thread.id);
      $('conversation-list').open = false;
      $('thread-select').focus({ preventScroll: true });
    });
    item.append(button);
    return item;
  }));
  $('thread-select').disabled = !threads.length;
  $('thread-select').value = activeThread || '';
  $('chat-empty').hidden = Boolean(activeThread);
  $('chat').hidden = !activeThread;
  if (!activeThread) $('conversation-state').hidden = true;
  highlightPassages();
  drawThread();
  drawAgent(agent);
  restoreFocus(focus);
}
function readableQuote(quote, block) {
  return block && quote === block.source.trim() ? block.text : quote;
}
function placeBubble(target) {
  const rect = target?.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportWidth = Math.min(viewport?.width || innerWidth, document.documentElement.clientWidth || innerWidth);
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const bottom = top + (viewport?.height || innerHeight);
  const header = document.querySelector('.site-header').getBoundingClientRect().bottom || 0;
  const minTop = Math.max(top + 12, Math.min(header + 12, bottom - 12));
  const width = Math.max(0, Math.min(410, viewportWidth - 24));
  const element = $('bubble');
  element.style.width = `${width}px`;
  element.style.left = `${Math.max(left + 12, Math.min((rect?.right ?? left + 24) - width / 2, left + viewportWidth - width - 12))}px`;
  element.style.maxHeight = 'none';
  element.style.height = 'auto';
  const naturalHeight = element.getBoundingClientRect().height;
  const availableHeight = Math.max(0, bottom - minTop - 12);
  element.style.maxHeight = `${availableHeight}px`;
  element.style.height = naturalHeight > availableHeight ? `${availableHeight}px` : '';
  const height = element.getBoundingClientRect().height;
  element.style.top = `${Math.max(minTop, Math.min(rect?.top ?? minTop, bottom - height - 12))}px`;
}
function closeBubble() {
  // A local draft is reversible UI state; closing never prompts, even while a
  // save is in flight. Its captured payload can still finish durably in the chat.
  const target = bubble?.target;
  const retryKey = bubble && questionDrafts.has(bubble.clientKey) ? bubble.clientKey : null;
  bubble = null;
  $('bubble').hidden = true;
  highlightPassages();
  target?.focus({ preventScroll: true });
  if (retryKey) notice('Question could not be saved. The exact question is preserved for retry.', null, retryKey);
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
  $('bubble-quote').textContent = readableQuote(exact, block);
  $('bubble-quote').lang = report.language || '';
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
  const focus = focusDescriptor();
  drawnThread = signature;
  $('conversation-state').textContent = labels(thread);
  $('conversation-state').hidden = !labels(thread);
  $('chat-anchor').textContent = thread.anchor_status === 'needs_review'
    ? `Passage to review — no safe match in revision ${thread.current_revision_id}. Original context kept; not reattached.`
    : `Original revision ${thread.revision_id} · passage matched in revision ${thread.current_revision_id}`;
  $('chat-anchor').classList.toggle('review', thread.anchor_status === 'needs_review');
  $('chat-quote').textContent = readableQuote(thread.quote, thread.context.block);
  $('chat-quote').lang = thread.language || '';
  $('snapshot-text').lang = thread.language || '';
  $('chat-status').textContent = thread.request_status === 'waiting' ? 'Saved · waiting for a reply'
    : thread.request_status === 'reserved' ? 'Saved · preparing a reply'
      : thread.request_status === 'failed' ? 'Reply failed · your question is saved' : 'Saved · answered';
  const log = $('messages');
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const lastMessageId = log.lastElementChild?.dataset.messageId;
  const previousEnd = thread.messages.findIndex(message => message.id === lastMessageId);
  const oldScroll = log.scrollTop;
  log.replaceChildren(...thread.messages.map(message => {
    const item = node('section', undefined, `message ${message.role}`);
    item.dataset.messageId = message.id;
    const demo = message.worker === 'deterministic-fake-v1';
    item.append(node('strong', message.role === 'user' ? 'You' : demo ? 'Demo adapter · not AI'
      : message.status === 'failed' ? 'Reply could not be completed' : 'Agent'));
    if (message.role === 'agent') {
      const body = node('div', undefined, 'markdown');
      // Same server-side safe renderer as the report. Questions/quotes stay literal.
      body.innerHTML = message.html;
      enhanceTables(body, 'Response table');
      item.append(body);
    } else item.append(node('p', message.body));
    for (const citation of message.citations) {
      const block = citation.block_id === thread.block_id ? thread.context.block : null;
      const citationDetails = node('details', undefined, 'citation-details');
      const link = node('button', `Go to cited passage · revision ${citation.revision_id}`, 'citation');
      const quote = node('blockquote', readableQuote(citation.quote, block));
      if (citation.revision_id === thread.revision_id) quote.lang = thread.language || '';
      citationDetails.append(node('summary', 'Citation'), quote);
      link.type = 'button';
      link.addEventListener('click', () => {
        const target = passageElement(citation.block_id);
        if (target) target.scrollIntoView({ block: 'center' });
        else notice(`Historical citation (revision ${citation.revision_id}); no current match. Exact quote is preserved in the conversation.`);
      });
      citationDetails.append(link);
      item.append(citationDetails);
    }
    return item;
  }));
  log.scrollTop = oldScroll;
  // Reveal the start of a new answer, not only its tail; never scroll the report.
  const newAnswer = thread.messages.findIndex((message, index) => index > previousEnd && message.role === 'agent');
  if (atEnd && previousEnd >= 0 && newAnswer >= 0) {
    revealMessage(log.children[newAnswer]);
  }
  $('go-source').hidden = thread.anchor_status !== 'matched' || !passageElement(thread.block_id);
  $('mark-read').hidden = !thread.unread;
  $('close-thread').textContent = thread.closed ? 'Reopen conversation' : 'Close conversation';
  $('snapshot-text').textContent = `Revision ${thread.revision_id}, lines ${thread.context.block.start_line}–${thread.context.block.end_line}\n\n${thread.context.block.source}`;
  drawComposer();
  restoreFocus(focus);
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
function revealMessage(element) {
  const log = $('messages');
  if (!element) return;
  const overflow = getComputedStyle(log).overflowY || getComputedStyle(log).overflow;
  const usesPageScroll = innerWidth <= 700 || innerHeight <= 650 || overflow === 'visible';
  if (usesPageScroll) element.scrollIntoView({ block: 'start' });
  else log.scrollTop = element.offsetTop - log.firstElementChild.offsetTop;
}
async function selectThread(id, markRead = true) {
  if (activeThread !== id) { $('context-details').open = false; $('snapshot').open = false; }
  activeThread = id;
  drawnThread = null;
  renderThreads();
  revealMessage($('messages').querySelector('.message.agent:last-of-type') || $('messages').lastElementChild);
  if (markRead && threads.find(t => t.id === id)?.unread) {
    try { await api(`/api/conversations/${id}`, { unread: false }, 'PATCH'); await refreshThreads(); }
    catch (error) { notice(error.message); }
  }
}
function updateDocument(value) {
  if (report?.id === value?.id) return;
  const y = window.scrollY;
  const focus = focusDescriptor();
  const safeIds = new Set(value?.blocks.map(b => b.id));
  const top = document.querySelector('.site-header').getBoundingClientRect().bottom + 16;
  const candidates = [...$('report').querySelectorAll('[data-block-id]')]
    .map(element => ({ id: element.dataset.blockId, top: element.getBoundingClientRect().top }))
    .filter(item => safeIds.has(item.id));
  candidates.sort((a, b) => Math.abs(a.top - top) - Math.abs(b.top - top));
  const anchor = candidates[0];
  renderDocument(value);
  if (anchor) window.scrollBy(0, passageElement(anchor.id).getBoundingClientRect().top - anchor.top);
  else window.scrollTo(0, y);
  restoreFocus(focus);
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

if (innerWidth <= 700) {
  $('toc-panel').hidden = true;
  $('toc-toggle').setAttribute('aria-expanded', 'false');
  $('layout').classList.add('toc-collapsed');
}
function sizeHeader() {
  const height = document.querySelector('.site-header').getBoundingClientRect().height;
  document.documentElement.style.setProperty('--header-height', `${height}px`);
  if (bubble) placeBubble(bubble.target);
}
if (window.ResizeObserver) new ResizeObserver(sizeHeader).observe(document.querySelector('.site-header'));
$('notice-chat').addEventListener('click', async event => {
  event.preventDefault();
  if (savedNoticeThread && threads.some(t => t.id === savedNoticeThread)) await selectThread(savedNoticeThread);
  $('threads-panel').focus({ preventScroll: true });
  $('threads-panel').scrollIntoView({ block: 'start' });
});
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
async function saveQuestion(current, selectedThread) {
  current.saving = true;
  if (bubble === current) {
    $('question-submit').disabled = true;
    $('question').disabled = true;
    $('bubble-status').textContent = 'Saving locally…';
  }
  try {
    const thread = await api('/api/questions', current.payload);
    questionDrafts.delete(current.clientKey);
    const draftIsCurrent = bubble === current;
    if (draftIsCurrent) closeBubble();
    if (draftIsCurrent && activeThread === selectedThread) activeThread = thread.id;
    await refreshThreads();
    notice('Question saved.', thread.id);
  } catch (error) {
    current.saving = false;
    current.error = error.message;
    questionDrafts.set(current.clientKey, current);
    if (bubble === current) {
      $('bubble-status').textContent = `${error.message}. Retry sends this same question safely; close to start a different draft.`;
      $('question-submit').disabled = false;
    } else {
      notice('Question could not be saved. The exact question is preserved for retry.', null, current.clientKey);
    }
    return;
  }
  current.saving = false;
}
async function retryQuestion(key) {
  const draft = questionDrafts.get(key);
  if (!draft || draft.saving) return;
  notice('Retrying question…');
  $('notice-retry').disabled = true;
  await saveQuestion(draft, activeThread);
}
$('question-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!bubble || bubble.saving) return;
  const current = bubble;
  const selectedThread = activeThread;
  current.payload ||= { revision_id: current.revisionId, block_id: current.blockId,
    quote: current.quote, question: $('question').value, client_key: current.clientKey };
  await saveQuestion(current, selectedThread);
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
$('notice-retry').addEventListener('click', () => {
  const key = $('notice-retry').dataset.retryKey;
  retryQuestion(key);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeBubble(); });
window.addEventListener('resize', sizeHeader);
window.visualViewport?.addEventListener('resize', () => { if (bubble) placeBubble(bubble.target); });
window.visualViewport?.addEventListener('scroll', () => { if (bubble) placeBubble(bubble.target); });
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
