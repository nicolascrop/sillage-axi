const $ = id => document.getElementById(id);
let report = null;
let threads = [];
let activeThread = null;
let drawnThread = null;
let drawnThreads = null;
let threadSelectionInitialized = false;
let bubble = null;
let polling = false;
let pollDone = Promise.resolve();
let selectionHandled = false;
let agent = { state: 'unavailable' };
const drafts = new Map();
const questionDrafts = new Map();
let savedNoticeThread = null;
let workspaceView = 'report';
let hiddenReportScroll = 0;
let endingReview = false;
let reviewEnded = false;
let pollTimer;
let pendingWrites = 0;
const whiteboards = new window.SillageWhiteboards({ api, notice, feedback: async thread => {
  activeThread = thread.id;
  await refreshThreads();
  notice('Whiteboard feedback saved. The agent receives a bounded text/geometry summary, not drawing pixels.', thread.id);
} });
$('whiteboard-history').addEventListener('toggle', () => {
  if ($('whiteboard-history').open) whiteboards.history($('whiteboard-history-list')).catch(error => notice(error.message));
});

async function api(path, body, method = 'POST') {
  if (reviewEnded) throw new Error('Review ended. Reopen the report to continue.');
  if (body !== undefined) pendingWrites++;
  try {
    const response = await fetch(path, { ...(body === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json', 'X-Sillage-Local': '1' },
      body: JSON.stringify(body),
    }), signal: AbortSignal.timeout(10_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Local service returned ${response.status}`);
    return value;
  } finally { if (body !== undefined) pendingWrites--; }
}
function notice(message, conversationId = null, retryKey) {
  if (reviewEnded) return;
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
function setText(id, text) {
  if ($(id).textContent !== text) $(id).textContent = text;
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
  whiteboards.currentRevision = value.id;
  whiteboards.mount(value);
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
  drawActivity();
}
function drawActivity() {
  const thread = threads.find(t => t.id === activeThread);
  if (!thread) return;
  const paused = agent.state !== 'active';
  const status = thread.request_status;
  const recovery = 'Return to the conversation that presented this report to resume answering.';
  const text = status === 'waiting' ? paused ? 'Question saved · waiting to resume' : 'Question saved · waiting for the agent'
    : status === 'reserved' ? 'Agent is replying'
      : status === 'failed' ? 'Reply failed · question saved' : 'Reply saved';
  const next = status === 'waiting' ? paused ? `${recovery} This question stays queued.` : 'You can draft a follow-up while you wait.'
    : status === 'reserved' ? 'You can draft now; send when the reply finishes.'
      : status === 'failed' ? paused ? `${recovery} Then send a follow-up to try again.` : 'See the explanation above. Send a follow-up to try again.'
        : 'Ask a follow-up, or select another report passage for a new conversation.';
  setText('chat-status', text);
  setText('chat-next', next);
  const tone = status === 'failed' || (status === 'waiting' && paused) ? 'attention' : status;
  if ($('chat-status').dataset.state !== tone) $('chat-status').dataset.state = tone;
}
function labels(thread) {
  return [thread.closed ? 'closed' : '',
    thread.anchor_status === 'needs_review' ? 'passage to review' : '',
    thread.request_status === 'failed' ? 'reply failed' : ''].filter(Boolean).join(' · ');
}
function renderThreads() {
  if (endingReview || reviewEnded) return;
  const focus = focusDescriptor();
  if (!threadSelectionInitialized) {
    if (threads.length) activeThread = threads[0].id;
    threadSelectionInitialized = true;
  } else if (activeThread !== null && !threads.some(t => t.id === activeThread)) {
    activeThread = threads[0]?.id ?? null;
  }
  // Do not replace conversation choices or invalidate focus/accessibility state on idle
  // polls. Presence is independent and must still surface real listening loss.
  const signature = JSON.stringify([threads, activeThread, report?.id]);
  if (signature === drawnThreads) { drawAgent(agent); return; }
  drawnThreads = signature;
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
      node('span', [`Original revision ${thread.revision_id}`, thread.unread ? 'New reply' : '', labels(thread) || 'Saved'].filter(Boolean).join(' · '), 'muted'));
    button.addEventListener('click', () => {
      selectThread(thread.id);
      $('conversation-list').open = false;
      $('conversation-toggle').focus({ preventScroll: true });
    });
    item.append(button);
    return item;
  }));
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
function closeBubble(restore = true) {
  // A local draft is reversible UI state; closing never prompts, even while a
  // save is in flight. Its captured payload can still finish durably in the chat.
  const target = bubble?.target;
  const retryKey = bubble && questionDrafts.has(bubble.clientKey) ? bubble.clientKey : null;
  selectionHandled = false;
  bubble = null;
  $('bubble').hidden = true;
  highlightPassages();
  if (restore) target?.focus({ preventScroll: true });
  if (retryKey) notice('Question could not be saved. The exact question is preserved for retry.', null, retryKey);
}
function openQuestion(element, quote) {
  if (!report || endingReview || reviewEnded) return;
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
  drawSend('question', {});
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
  $('context-label').textContent = 'Quoted passage';
  $('context-preview').textContent = compact(readableQuote(thread.quote, thread.context.block), 100);
  $('context-preview').lang = thread.language || '';
  $('snapshot-text').lang = thread.language || '';
  const log = $('messages');
  const sameConversation = log.dataset.conversationId === thread.id;
  const scroll = chatScroller();
  const atEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40;
  const lastMessage = sameConversation ? log.lastElementChild : null;
  const previousEnd = thread.messages.findIndex(message => message.id === lastMessage?.dataset.messageId);
  if (!sameConversation) {
    log.replaceChildren();
    log.dataset.conversationId = thread.id;
    scroll.scrollTop = 0;
    $('latest-reply').hidden = true;
  }
  // Saved turns are immutable. Append only new messages so expanded citations,
  // table positions, focus and assistive-technology history survive polling.
  for (const message of thread.messages.slice(previousEnd + 1)) {
    const item = node('section', undefined, `message ${message.role}`);
    item.dataset.messageId = message.id;
    item.tabIndex = -1;
    item.classList.toggle('failed', message.status === 'failed');
    const demo = message.worker === 'deterministic-fake-v1';
    const heading = node('header', undefined, 'message-heading');
    heading.append(node('strong', message.role === 'user' ? 'You' : demo ? 'Demo adapter · not AI' : 'Agent'));
    heading.append(node('span', message.role === 'user' ? 'Question' : message.status === 'failed' ? 'Reply failed' : 'Reply', 'muted'));
    item.append(heading);
    if (message.role === 'agent') {
      const body = node('div', undefined, 'markdown');
      // Same server-side safe renderer as the report. Questions/quotes stay literal.
      body.innerHTML = message.html;
      enhanceTables(body, 'Response table');
      item.append(body);
    } else {
      item.append(node('p', message.body));
      if (thread.context.whiteboard && message === thread.messages[0]) {
        const wb = thread.context.whiteboard;
        const details = node('details', undefined, 'whiteboard-feedback');
        details.append(node('summary', `Whiteboard edits · revision ${wb.revision_id} · snapshot ${wb.snapshot_id}`),
          node('p', wb.delivery), node('pre', wb.summary_lines.join('\n')));
        item.append(details);
      }
    }
    for (const citation of message.citations) {
      const block = citation.block_id === thread.block_id ? thread.context.block : null;
      const citationDetails = node('details', undefined, 'citation-details');
      const link = $('go-source').cloneNode(true);
      link.removeAttribute('id');
      link.hidden = false;
      link.classList.add('citation');
      link.setAttribute('aria-label', 'Go to cited passage');
      link.title = 'Go to cited passage';
      const quote = node('blockquote', readableQuote(citation.quote, block));
      if (citation.revision_id === thread.revision_id) quote.lang = thread.language || '';
      citationDetails.append(node('summary', 'Citation'),
        node('p', `Original revision ${citation.revision_id}`, 'muted'), quote);
      link.type = 'button';
      link.addEventListener('click', () => {
        const target = passageElement(citation.block_id);
        if (target) navigatePassage(target);
        else notice(`Historical citation (revision ${citation.revision_id}); no current match. Exact quote is preserved in the conversation.`);
      });
      citationDetails.append(link);
      item.append(citationDetails);
    }
    log.append(item);
  }
  // Follow only within a visible chat at its end. Report position and keyboard
  // inspection of earlier history/context never move when a reply arrives.
  const newAnswer = thread.messages.findIndex((message, index) => index > previousEnd && message.role === 'agent');
  if (sameConversation && previousEnd >= 0 && newAnswer >= 0) {
    const inspectingHistory = $('chat-scroll').contains(document.activeElement) && document.activeElement !== $('chat-scroll')
      && !lastMessage?.contains(document.activeElement);
    const reveal = !$('threads-panel').hidden && !inspectingHistory && atEnd && !bubble;
    if (reveal) revealMessage(log.children[newAnswer]);
    $('latest-reply').hidden = Boolean(reveal);
  }
  $('go-source').hidden = thread.anchor_status !== 'matched' || !passageElement(thread.block_id);
  $('snapshot-text').textContent = `Revision ${thread.revision_id}, lines ${thread.context.block.start_line}–${thread.context.block.end_line}\n\n${thread.context.block.source}`;
  drawComposer();
  restoreFocus(focus);
}
function drawComposer() {
  const draft = drafts.get(activeThread);
  const thread = threads.find(t => t.id === activeThread);
  const busy = ['waiting', 'reserved'].includes(thread?.request_status);
  $('followup').value = draft?.text || '';
  $('followup').disabled = Boolean(draft?.payload);
  drawSend('followup', { saving: draft?.saving, retry: draft?.payload, waiting: busy && !draft?.payload });
  setText('followup-status', draft?.error || (draft?.saving ? 'Saving…' : ''));
}
// Both composers expose the same send, saving and retry affordance. Their
// captured payloads and durable endpoints remain independent.
function drawSend(id, { saving = false, retry = false, waiting = false }) {
  const button = $(`${id}-submit`);
  button.disabled = Boolean(saving || waiting);
  const label = saving ? 'Saving message' : retry ? 'Retry message' : 'Send message';
  button.setAttribute('aria-label', label);
  button.title = label;
  $(`${id}-form`).setAttribute('aria-busy', String(Boolean(saving)));
}
// Short viewports scroll the whole chat instead of trapping its composer. There
// is still exactly one vertical scroller per workspace pane (no page scrolling).
function chatScroller() {
  return innerHeight <= 600 ? $('threads-panel') : $('chat-scroll');
}
function revealMessage(element) {
  if (!element) return;
  const scroll = chatScroller();
  scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
}
function showWorkspace(view, focus = true) {
  workspaceView = view;
  syncWorkspace();
  if (focus) $(view === 'chat' ? 'threads-panel' : 'reader').focus({ preventScroll: true });
}
function syncWorkspace() {
  if (reviewEnded) return;
  const narrow = innerWidth <= 700;
  $('workspace-switcher').hidden = !narrow;
  const hideReport = narrow && workspaceView !== 'report';
  if (hideReport && !$('reader').hidden) hiddenReportScroll = $('reader').scrollTop;
  const wasHidden = $('reader').hidden;
  $('reader').hidden = hideReport;
  if (wasHidden && !hideReport) $('reader').scrollTop = hiddenReportScroll;
  $('threads-panel').hidden = narrow && workspaceView !== 'chat';
  for (const view of ['report', 'chat']) {
    const link = $(`show-${view}`);
    if (narrow && workspaceView === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}
function closeContents() {
  $('toc-panel').hidden = true;
  $('toc-toggle').setAttribute('aria-expanded', 'false');
  $('toc-toggle').title = 'Show table of contents';
  $('layout').classList.add('toc-collapsed');
}
function navigatePassage(target) {
  if (innerWidth <= 900) closeContents();
  showWorkspace('report', false);
  target.scrollIntoView({ block: 'center' });
  target.focus({ preventScroll: true });
}
async function acknowledgeReplies(thread) {
  if (!thread?.unread) return;
  // Acknowledge only immutable answered turns actually displayed, not an entire
  // conversation: a late reply racing this action must keep its new-reply flag.
  const turns = new Set(thread.messages.filter(m => m.role === 'agent').map(m => m.thread_id));
  try {
    for (const id of turns) await api(`/api/threads/${id}`, { unread: false }, 'PATCH');
    await refreshThreads();
  } catch (error) { notice(error.message); }
}
async function selectThread(id, markRead = true) {
  if (activeThread !== id) { $('context-details').open = false; $('snapshot').open = false; }
  showWorkspace('chat', false);
  activeThread = id;
  drawnThread = null;
  renderThreads();
  revealMessage($('messages').querySelector('.message.agent:last-of-type') || $('messages').lastElementChild);
  $('latest-reply').hidden = true;
  if (markRead) await acknowledgeReplies(threads.find(t => t.id === id));
}
async function updateDocument(value) {
  if (report?.id === value?.id) return;
  if (!await whiteboards.beforeRevision(value) || reviewEnded) return;
  const reader = $('reader');
  const y = reader.hidden ? hiddenReportScroll : reader.scrollTop;
  const focus = focusDescriptor();
  const safeIds = new Set(value?.blocks.map(b => b.id));
  const top = reader.getBoundingClientRect().top + 16;
  const candidates = [...$('report').querySelectorAll('[data-block-id]')]
    .map(element => ({ id: element.dataset.blockId, top: element.getBoundingClientRect().top }))
    .filter(item => safeIds.has(item.id));
  candidates.sort((a, b) => Math.abs(a.top - top) - Math.abs(b.top - top));
  const anchor = !reader.hidden && candidates[0];
  renderDocument(value);
  if (reader.hidden) hiddenReportScroll = y;
  else reader.scrollTop = y + (anchor ? passageElement(anchor.id).getBoundingClientRect().top - anchor.top : 0);
  restoreFocus(focus);
  if (bubble) {
    bubble.target = passageElement(bubble.blockId);
    $('bubble-anchor').textContent = bubble.target
      ? `Draft kept against original revision ${bubble.revisionId} · passage safely matched in revision ${report.id}`
      : `Passage to review — draft kept against original revision ${bubble.revisionId}. No safe current match; asking will preserve the original context.`;
    $('bubble-anchor').classList.toggle('review', !bubble.target);
    placeBubble(bubble.target);
  }
  notice(`Report updated. ${anchor ? 'Reading position kept at a matched passage.' : 'Approximate reading position kept; no safe visible anchor.'}`);
}
async function refreshThreads() {
  if (polling || endingReview || reviewEnded) return;
  polling = true;
  let finishPoll;
  pollDone = new Promise(resolve => { finishPoll = resolve; });
  try {
    const state = await api('/api/state');
    if (endingReview || reviewEnded) return;
    if (state.revision_id !== (report?.id ?? null)) await updateDocument(await api('/api/document'));
    if (endingReview || reviewEnded) return;
    agent = state.agent;
    threads = await api('/api/conversations');
    renderThreads();
  } catch (error) {
    if (endingReview || reviewEnded) return;
    drawAgent({ state: 'unavailable' });
    notice(`Local service cannot be reached. Return to the presenting conversation to resume it, then reload. Saved threads remain on disk. ${error.message}`);
  } finally { polling = false; finishPoll(); }
}

closeContents();
syncWorkspace();
function positionOpenBubble() {
  if (bubble) placeBubble(bubble.target);
}
if (window.ResizeObserver) new ResizeObserver(positionOpenBubble).observe(document.querySelector('.site-header'));
$('notice-chat').addEventListener('click', async event => {
  event.preventDefault();
  if (savedNoticeThread && threads.some(t => t.id === savedNoticeThread)) await selectThread(savedNoticeThread);
  showWorkspace('chat');
});
$('toc-toggle').addEventListener('click', () => {
  if (innerWidth <= 700) showWorkspace('report', false);
  $('toc-panel').hidden = !$('toc-panel').hidden;
  $('toc-toggle').setAttribute('aria-expanded', String(!$('toc-panel').hidden));
  $('toc-toggle').title = $('toc-panel').hidden ? 'Show table of contents' : 'Hide table of contents';
  $('layout').classList.toggle('toc-collapsed', $('toc-panel').hidden);
});
$('report').addEventListener('click', event => {
  if (selectionHandled) { selectionHandled = false; return; }
  if (event.target.closest('a,button,input,textarea,summary,.wb-host') || window.getSelection()?.toString().trim()) return;
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
  selectionHandled = false;
  if (selection?.anchorNode?.parentElement?.closest('.wb-host')) return;
  if (!quote) return;
  if (quote.length > 2000) { notice('Select at most 2,000 characters for a short quote.'); return; }
  const first = nearestPassage(selection.anchorNode);
  const last = nearestPassage(selection.focusNode);
  if (!first || first !== last || !$('report').contains(first)) { notice('Select text within a single semantic passage.'); return; }
  openQuestion(first, quote);
  selectionHandled = true;
}
$('report').addEventListener('mouseup', quoteSelection);
$('report').addEventListener('keyup', event => { if (event.key === 'Shift') quoteSelection(); });
async function saveQuestion(current, selectedThread) {
  current.saving = true;
  if (bubble === current) {
    drawSend('question', { saving: true });
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
      drawSend('question', { retry: true });
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
$('latest-reply').addEventListener('click', () => {
  showWorkspace('chat', false);
  const reply = $('messages').querySelector('.message.agent:last-of-type');
  revealMessage(reply);
  reply?.focus({ preventScroll: true });
  $('latest-reply').hidden = true;
  acknowledgeReplies(threads.find(t => t.id === activeThread));
});
for (const id of ['question', 'followup']) $(`${id}-form`).addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
    event.preventDefault();
    if (!$(`${id}-submit`).disabled) $(`${id}-form`).requestSubmit();
  }
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
function closeReviewMenu(restore = false) {
  $('review-menu').hidden = true;
  $('review-menu-toggle').setAttribute('aria-expanded', 'false');
  if (restore) $('review-menu-toggle').focus({ preventScroll: true });
}
function openReviewMenu() {
  if ($('review-menu-toggle').disabled || endingReview || reviewEnded) return;
  $('review-menu').hidden = false;
  $('review-menu-toggle').setAttribute('aria-expanded', 'true');
  $('end-session').focus({ preventScroll: true });
}
$('review-menu-toggle').addEventListener('click', () => {
  if ($('review-menu').hidden) openReviewMenu(); else closeReviewMenu(true);
});
$('review-menu-toggle').addEventListener('keydown', event => {
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openReviewMenu(); }
});
$('review-menu').addEventListener('keydown', event => {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault(); $('end-session').focus();
  }
  // Restore the trigger before native Tab moves on; no focus trap for one item.
  if (event.key === 'Tab') closeReviewMenu(true);
});
$('review-actions').addEventListener('focusout', event => {
  if (event.relatedTarget && !$('review-actions').contains(event.relatedTarget)) closeReviewMenu();
});
function activeWhiteboardFrame(target) {
  const frame = target?.closest?.('#report .wb-host iframe');
  return frame && !frame.inert && !frame.classList.contains('wb-locked') ? frame : null;
}
function dismissBubbleAtWhiteboardBoundary(event) {
  if (bubble && activeWhiteboardFrame(event.target)) closeBubble(false);
}
document.addEventListener('focusin', dismissBubbleAtWhiteboardBoundary, true);
document.addEventListener('pointerover', dismissBubbleAtWhiteboardBoundary, true);
document.addEventListener('pointerdown', dismissBubbleAtWhiteboardBoundary, true);
// Capture before a passage's click opens a replacement. A mouseup text selection
// already opened its bubble, so the completing click must not dismiss that draft.
document.addEventListener('click', event => {
  const selectionCompletes = selectionHandled && bubble?.target && nearestPassage(event.target) === bubble.target
    && !event.target.closest?.('a,button,input,textarea,summary,.wb-host');
  if (bubble && !$('bubble').contains(event.target) &&
    !selectionCompletes) {
    closeBubble($('bubble').contains(document.activeElement));
  }
  if (!$('review-menu').hidden && !$('review-actions').contains(event.target)) {
    closeReviewMenu($('review-menu').contains(document.activeElement));
  }
}, true);
$('end-session').addEventListener('click', async () => {
  if (endingReview || reviewEnded) return;
  closeReviewMenu(true);
  // Do not hide uncertain payloads or detach a frame with unsaved annotations.
  if (pendingWrites || bubble?.saving || questionDrafts.size || [...drafts.values()].some(draft => draft.payload)) {
    notice('Finish saving or retry pending messages before ending the session.');
    return;
  }
  const endingRevision = report?.id ?? null;
  endingReview = true;
  $('layout').inert = true;
  $('workspace-switcher').inert = true;
  $('bubble').inert = true;
  $('toc-toggle').disabled = true;
  $('review-menu-toggle').disabled = true;
  notice('Ending review…');
  try {
    // Let an already-started revision/whiteboard replacement finish coherently.
    // The captured revision still guards against ending a newly published report.
    await pollDone;
    await whiteboards.beforeEnd();
    await api('/review/end', { review_key: document.querySelector('meta[name="sillage-review"]').content, revision_id: endingRevision });
    reviewEnded = true;
    clearInterval(pollTimer);
    closeBubble(false);
    closeContents();
    whiteboards.dispose();
    $('layout').hidden = true;
    $('workspace-switcher').hidden = true;
    $('review-actions').hidden = true;
    $('toc-toggle').hidden = true;
    document.querySelector('.skip-link').hidden = true;
    document.querySelector('.header-feedback').hidden = true;
    $('review-ended').hidden = false;
    $('review-ended-title').focus({ preventScroll: true });
  } catch (error) {
    notice(`Review could not end. ${error.message} Your review remains open; retry End session when ready.`);
  } finally {
    endingReview = false;
    if (!reviewEnded) {
      for (const id of ['layout', 'workspace-switcher', 'bubble']) $(id).inert = false;
      $('toc-toggle').disabled = false;
      $('review-menu-toggle').disabled = false;
      $('review-menu-toggle').focus({ preventScroll: true });
    }
  }
});
$('notice-retry').addEventListener('click', () => {
  const key = $('notice-retry').dataset.retryKey;
  retryQuestion(key);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!$('review-menu').hidden) { event.preventDefault(); closeReviewMenu(true); }
  else if (bubble) { event.preventDefault(); closeBubble(); }
  else if ($('conversation-list').open) {
    event.preventDefault();
    $('conversation-list').open = false;
    $('conversation-toggle').focus({ preventScroll: true });
  }
  else if (!$('toc-panel').hidden) { closeContents(); $('toc-toggle').focus({ preventScroll: true }); }
});
window.addEventListener('resize', () => {
  if ($('threads-panel').contains(document.activeElement)) workspaceView = 'chat';
  else if ($('reader').contains(document.activeElement)) workspaceView = 'report';
  syncWorkspace();
  positionOpenBubble();
});
window.visualViewport?.addEventListener('resize', () => { if (bubble) placeBubble(bubble.target); });
window.visualViewport?.addEventListener('scroll', () => { if (bubble) placeBubble(bubble.target); });
$('go-source').addEventListener('click', () => {
  const thread = threads.find(t => t.id === activeThread);
  if (thread?.anchor_status === 'matched') {
    const target = passageElement(thread.block_id);
    if (target) navigatePassage(target);
  }
});
for (const view of ['report', 'chat']) $('show-' + view).addEventListener('click', event => {
  event.preventDefault();
  if (innerWidth <= 900) closeContents();
  showWorkspace(view);
});
function navigateHash(hash) {
  if (endingReview || reviewEnded) return false;
  if (hash === '#reader' || hash === '#threads-panel') {
    if (innerWidth <= 900) closeContents();
    showWorkspace(hash === '#reader' ? 'report' : 'chat');
    return true;
  }
  const target = hash.startsWith('#b-') && document.getElementById(hash.slice(1));
  if (target && $('report').contains(target)) { navigatePassage(target); return true; }
  return false;
}
document.addEventListener('click', event => {
  const link = event.target.closest('a[href^="#"]');
  if (!event.defaultPrevented && link && navigateHash(link.getAttribute('href'))) event.preventDefault();
});
window.addEventListener('hashchange', () => navigateHash(location.hash));
try { renderDocument(await api('/api/document')); await refreshThreads(); navigateHash(location.hash); }
catch (error) { notice(`Return to the presenting conversation to resume the local service, then reload. ${error.message}`); }
pollTimer = setInterval(refreshThreads, 2000);
$('review-menu-toggle').disabled = false;
