// The response pane: status line, headers, and the body as text, JSON, preview or hex dump.
import { formatBytes, formatTime, captureInfo, describeBody, formatBody, tokenizeJson, hexDump, fileNameFor } from '../lib/index.js';
import { state, current, nextId } from './state.js';
import { $, el, statusClass, toast } from './dom.js';
import { refreshSearch } from './search.js';

const HIGHLIGHT_LIMIT = 300_000; // chars; larger bodies render as plain text
const PRETTY_LIMIT = 2_000_000;  // chars; larger JSON isn't re-indented (parse + reindent would stall the panel)
const HEX_DUMP_BYTES = 4096;     // bytes shown in the hex view of a binary body
const PREVIEWABLE = new Set(['image', 'svg', 'video', 'audio', 'pdf', 'font', 'html']);

// What's on screen, for Copy / Save / the Preview-Raw toggle.
let shown = null;       // { model, url } from describeBody, or null for messages
let shownText = null;   // text that "Copy" copies
let previewUrl = null;  // blob: URL of the current preview
let previewFont = null; // FontFace of the current font preview

export const shownBodyText = () => shownText;

export function renderResponse() {
  const item = current();
  if (!item) return;
  const sent = state.responses.get(item.id);
  const pending = !!sent?.pending;
  $('sendBtn').textContent = pending ? 'Cancel' : 'Send';
  $('sendBtn').classList.toggle('cancel', pending);
  $('sendBtn').title = pending ? 'Cancel this request' : 'Send (Enter in the URL field, or ⌘/Ctrl + Enter)';

  // Recorded / Sent is a choice only when both exist: then it is the select. With one source it is a
  // plain label (never a disabled dropdown); while sending, after a cancel or without any response, nothing.
  const hasSent = !!sent && !pending && !sent.cancelled;
  const canCompare = !!item.recorded && hasSent;
  const view = canCompare ? item.view || 'sent' : null;
  // The capture details (time, type, duration) live in the tooltips of the Recorded label / select.
  const captured = item.recorded ? captureInfo(item) : '';
  const source = $('resSource');
  source.hidden = !canCompare;
  if (canCompare) source.value = view;
  source.title = `Recorded from the page (${captured}), or the response to your last send`;
  const label = $('resSourceLabel');
  const only = hasSent ? 'sent' : item.recorded && !pending && !sent?.cancelled ? 'recorded' : null;
  label.hidden = canCompare || !only;
  label.textContent = only === 'sent' ? 'Sent' : 'Recorded';
  label.title = only === 'sent' ? 'The response to your last send' : captured;

  if (pending) {
    showResponse({ pending: true, placeholder: 'Sending…' });
  } else if (sent?.cancelled) {
    showResponse({ placeholder: 'Request cancelled.' });
  } else if (sent && view !== 'recorded') {
    if (sent.error) showResponse({ status: 0, statusText: 'Failed', error: sent.error });
    else showResponse(sent);
  } else if (item.recorded) {
    showResponse({ ...item.recorded, placeholder: 'Loading…' });
    // Still arriving from DevTools? fetchRecordedBody's callback renders it.
    if (item.recordedBody) showRecordedBody(item);
  } else {
    showResponse({ placeholder: 'No response yet.\nSend this request to see its response.' });
  }
  const badge = $('viewResStatus');
  const shownStatus = pending ? '…' : sent?.cancelled ? '' : sent && view !== 'recorded' ? (sent.error ? 0 : sent.status) : item.recorded?.status;
  badge.textContent = shownStatus == null || shownStatus === '' ? '' : String(shownStatus || 'ERR');
  badge.className = `status ${shownStatus == null || shownStatus === '' || pending ? '' : statusClass(shownStatus)}`;
}

function showResponse({ status, statusText, time, size, headers, body, bodyBase64, tooLarge, mimeType, redirected, url, placeholder, error, pending }) {
  const pill = $('resStatus');
  if (pending) {
    pill.textContent = '…';
    pill.className = 'pill pending';
    pill.title = '';
  } else {
    pill.textContent = status == null ? '' : `${status || 'ERR'} ${statusText || ''}`.trim();
    pill.className = `pill ${status == null ? '' : statusClass(status)}`;
    pill.title = pill.textContent; // the pill ellipsizes in narrow panes
  }
  $('resTime').textContent = formatTime(time);
  $('resSize').textContent = formatBytes(size);

  $('resRedirect').hidden = !redirected;
  $('resRedirect').textContent = redirected ? `Redirected → ${url}` : '';
  $('resRedirect').title = url || '';

  renderResponseHeaders(headers);

  if (error) setBodyMessage(error, 'error');
  else if (placeholder) setBodyMessage(placeholder);
  else if (tooLarge) setBodyMessage(`Response too large to show (${formatBytes(size)}). Save isn’t available either.`);
  else if (body != null) renderContent(describeBody({ text: body, mime: mimeType }), url || current()?.url);
  else renderContent(describeBody({ base64: bodyBase64 || '', mime: mimeType }), url || current()?.url);
}

function renderResponseHeaders(headers) {
  const root = $('resHeaders');
  $('resHeaderCount').textContent = headers?.length || '';
  if (!headers?.length) {
    root.replaceChildren(el('span', 'hval', 'No headers'));
    return;
  }
  root.replaceChildren(...headers.flatMap((h) => [el('span', 'hname', h.name), el('span', 'hval', h.value)]));
}

export function renderResTab() {
  for (const b of $('resTabs').querySelectorAll('button[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === state.resTab));
  $('resBodyWrap').hidden = state.resTab !== 'resBody';
  $('resHeaders').hidden = state.resTab !== 'resHeaders';
  updateBodyActions();
  refreshSearch();
}

// Preview ↔ Raw for the body kind currently shown.
export function setBodyMode(mode) {
  if (!shown) return;
  state.resModes[shown.model.kind] = mode;
  renderContent(shown.model, shown.url);
}

// ---------- recorded bodies ----------

const MAX_KEPT_BODY = 20_000_000; // chars of a recorded response body kept in memory (base64 for binary)

// Fetch the body right away: DevTools forgets its request ids on every navigation of the
// inspected page, after which getContent() returns nothing.
export function fetchRecordedBody(item) {
  const { entry } = item;
  delete item.entry;
  if (typeof entry?.getContent !== 'function') {
    item.recordedBody = { unavailable: true };
    return;
  }
  entry.getContent((content, encoding) => {
    item.recordedBody = content != null && content.length > MAX_KEPT_BODY
      ? { tooLarge: content.length }
      : { content, encoding };
    const showingRecorded = item.view === 'recorded' || !state.responses.has(item.id);
    if (state.selectedId === item.id && showingRecorded) showRecordedBody(item);
  });
}

// Notices offer to send the request from Postcat; main.js turns the event into a send().
const sendAgain = () => document.dispatchEvent(new CustomEvent('postcat:send'));

function showRecordedBody(item) {
  const { unavailable, tooLarge, content, encoding } = item.recordedBody;
  const mime = item.recorded.mimeType;
  if (unavailable) return setBodyMessage('DevTools didn’t provide a response body for this request.');
  if (tooLarge) return setBodyMessage(`Response body too large to keep (${formatBytes(item.recorded.size)}).`);
  const { status, error, location } = item.recorded;
  if (!content && !status) {
    return setBodyNotice(
      `The page's request failed${error ? ` (${error})` : ''} — blocked by CORS, a network error, or cancelled. `
        + 'Postcat sends from the extension, which CORS doesn’t apply to.',
      { label: 'Send from Postcat', run: sendAgain },
    );
  }
  if (!content && status >= 300 && status < 400 && location) {
    return setBodyMessage(`Redirect → ${location}`);
  }
  if (!content && !isKnownEmpty(item)) {
    return setBodyNotice(
      'No response body recorded. Either the response was empty, or DevTools kept no copy — '
        + 'e.g. because the page read it with fetch().blob() or streamed it.',
      { label: 'Send again to check', run: sendAgain },
    );
  }
  if (content == null) return setBodyMessage('Empty response body.');
  const input = encoding === 'base64' ? { base64: content, mime } : { text: content, mime };
  return renderContent(describeBody(input), item.url);
}

// True when the recorded response is legitimately bodiless.
function isKnownEmpty(item) {
  const { status, headers = [] } = item.recorded;
  if ([101, 204, 205, 304].includes(status) || (status >= 300 && status < 400) || item.method === 'HEAD') return true;
  const length = headers.find((h) => h.name.toLowerCase() === 'content-length')?.value;
  return length === '0';
}

// ---------- body rendering ----------

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  if (previewFont) document.fonts.delete(previewFont);
  previewUrl = null;
  previewFont = null;
  $('resPreview').replaceChildren();
}

function setBodyMessage(text, className = 'muted') {
  shown = null;
  setBodyText(text, className);
}

// A message with an action button, shown in the preview area.
function setBodyNotice(text, action) {
  shown = null;
  shownText = null;
  clearPreview();
  $('resBody').hidden = true;
  const root = $('resPreview');
  root.hidden = false;
  root.className = 'preview';
  const btn = el('button', 'primary', action.label);
  btn.addEventListener('click', action.run);
  root.append(el('div', 'caption notice', text), btn);
  updateBodyActions();
  refreshSearch();
}

function setBodyText(text, className) {
  clearPreview();
  $('resPreview').hidden = true;
  const out = $('resBody');
  out.hidden = false;
  out.className = `output scroll ${className || ''}`;
  out.textContent = text;
  shownText = className ? null : text;
  updateBodyActions();
  refreshSearch();
}

function renderContent(model, url) {
  shown = { model, url };
  if (!model.size && !model.text) {
    setBodyMessage('Empty response body.');
    return;
  }
  const mode = PREVIEWABLE.has(model.kind) ? state.resModes[model.kind] || 'preview' : 'raw';
  for (const b of $('resMode').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  }
  $('resModeItem').textContent = mode === 'raw' ? 'Show preview' : 'Show raw';
  $('resModeItem').dataset.mode = mode === 'raw' ? 'preview' : 'raw';
  if (mode === 'preview') renderPreview(model, url);
  else renderRaw(model);
}

function renderRaw(model) {
  if (model.text != null) {
    renderBody(model.text);
  } else {
    const label = `${model.mime || 'binary data'} · ${formatBytes(model.size)}\n\n`;
    setBodyText(label + hexDump(model.bytes, HEX_DUMP_BYTES), 'hex');
    shownText = null;
    updateBodyActions();
  }
}

function renderBody(raw) {
  const { text, json } = raw.length > PRETTY_LIMIT ? { text: raw, json: false } : formatBody(raw);
  if (!json || text.length > HIGHLIGHT_LIMIT) {
    setBodyText(text);
    return;
  }
  setBodyText('');
  const frag = document.createDocumentFragment();
  for (const [cls, part] of tokenizeJson(text)) {
    frag.append(cls ? el('span', cls, part) : part);
  }
  $('resBody').replaceChildren(frag);
  shownText = text;
  refreshSearch();
}

function renderPreview(model, url) {
  clearPreview();
  $('resBody').hidden = true;
  const root = $('resPreview');
  root.hidden = false;
  root.className = 'preview';
  updateBodyActions();
  refreshSearch(); // previews aren't searchable; clears stale matches

  const blob = new Blob([model.bytes ?? model.text], { type: model.mime || 'application/octet-stream' });
  previewUrl = URL.createObjectURL(blob);
  const caption = el('div', 'caption');
  const meta = (...parts) => parts.filter(Boolean).join(' · ');
  const openLink = () => {
    const a = el('a', '', 'Open in new tab');
    a.href = previewUrl;
    a.target = '_blank';
    return a;
  };

  switch (model.kind) {
    case 'image':
    case 'svg': {
      const img = el('img', 'media checker');
      img.alt = '';
      // No "open in new tab" for SVG: it would run as a document on the extension's origin.
      const extras = model.kind === 'image' ? [' · ', openLink()] : [];
      img.onload = () => caption.replaceChildren(meta(`${img.naturalWidth} × ${img.naturalHeight}`, model.mime, formatBytes(model.size)), ...extras);
      img.onerror = () => caption.replaceChildren(`Couldn’t decode this image (${model.mime}). Switch to Raw to inspect it.`);
      img.src = previewUrl;
      root.append(img, caption);
      break;
    }
    case 'video': {
      const video = el('video', 'media');
      video.controls = true;
      video.preload = 'metadata';
      video.onloadedmetadata = () => caption.replaceChildren(meta(`${video.videoWidth} × ${video.videoHeight}`, formatDuration(video.duration), model.mime, formatBytes(model.size)));
      video.onerror = () => caption.replaceChildren(`Chrome can’t play this video (${model.mime}).`);
      video.src = previewUrl;
      root.append(video, caption);
      break;
    }
    case 'audio': {
      const audio = el('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => caption.replaceChildren(meta(formatDuration(audio.duration), model.mime, formatBytes(model.size)));
      audio.onerror = () => caption.replaceChildren(`Chrome can’t play this audio (${model.mime}).`);
      audio.src = previewUrl;
      root.append(audio, caption);
      break;
    }
    case 'pdf': {
      root.classList.add('fill');
      const frame = el('iframe');
      frame.src = previewUrl;
      frame.title = 'PDF preview';
      root.append(frame);
      break;
    }
    case 'html': {
      root.classList.add('fill');
      // No scripts, no same-origin access; <base> lets relative images and styles resolve.
      const frame = el('iframe', 'page');
      frame.sandbox = '';
      frame.title = 'HTML preview';
      const doctype = /^\s*<!doctype[^>]*>/i.exec(model.text)?.[0] || '';
      frame.srcdoc = `${doctype}<base href="${escapeAttr(url || '')}">${model.text.slice(doctype.length)}`;
      root.append(frame);
      break;
    }
    case 'font': {
      const family = `postcat-preview-${nextId()}`;
      const face = new FontFace(family, model.bytes);
      previewFont = face;
      face.load().then(() => {
        if (previewFont !== face) return;
        document.fonts.add(face);
        const sample = el('div', 'font-preview', '', [
          el('div', 'xl', 'The quick brown fox jumps over the lazy dog'),
          el('div', 'lg', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz'),
          el('div', 'md', '0123456789 !?&@#%*()[]{} äöüß éèê'),
        ]);
        sample.style.fontFamily = `"${family}"`;
        caption.replaceChildren(meta(model.mime, formatBytes(model.size)));
        root.replaceChildren(sample, caption);
      }, () => {
        if (previewFont === face) root.replaceChildren(el('div', 'caption', `Couldn’t load this font (${model.mime}).`));
      });
      root.append(el('div', 'caption', 'Loading font…'));
      break;
    }
    default:
      renderRaw(model);
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// The body actions of the response header: Preview/Raw, Copy and Save are inline controls. When the
// header overflows, its controls collapse lowest priority first (COLLAPSE, below), and the ⋯ menu
// offers exactly the collapsed actions, so nothing is ever offered twice; it disappears when
// everything fits. Measured rather than keyed to fixed widths, because the room needed depends on
// the content (Recorded/Sent as label or select, Preview/Raw or not, header counts). Runs on every
// render and, through the ResizeObserver below, on every pane resize.
const ACTIONS = [
  // [inline control, menu item, applies?]
  ['resMode', 'resModeItem', () => !!shown && PREVIEWABLE.has(shown.model.kind)],
  ['resCopy', 'copyResBtn', () => shownText != null],
  ['resSave', 'saveResBtn', () => !!shown],
];
const COLLAPSE = [['resCopy', 'resSave'], ['resMode'], ['resSize'], ['resTime']]; // first to go first
function updateBodyActions() {
  const onBody = state.resTab === 'resBody';
  for (const [inlineId, , applies] of ACTIONS) $(inlineId).hidden = !onBody || !applies();
  // The menu mirrors the collapsed actions; the ⋯ button takes room itself, so it is synced before
  // each measurement.
  const syncMenu = () => {
    let collapsed = 0;
    for (const [inlineId, itemId] of ACTIONS) {
      const inline = $(inlineId);
      const inMenu = !inline.hidden && inline.classList.contains('collapsed');
      $(itemId).hidden = !inMenu;
      if (inMenu) collapsed++;
    }
    $('resMenuBtn').hidden = !collapsed;
  };
  // Fit: the pill shrinks to its minimum, then the header overflows and the next group collapses.
  const head = $('resTabs');
  const overflows = () => head.scrollWidth > head.clientWidth;
  for (const group of COLLAPSE) for (const id of group) $(id).classList.remove('collapsed');
  syncMenu();
  for (const group of COLLAPSE) {
    if (!overflows()) break;
    for (const id of group) $(id).classList.add('collapsed');
    syncMenu();
  }
}

export function initResponse() {
  new ResizeObserver(updateBodyActions).observe($('resPane'));
}

export function saveResponseBody() {
  if (!shown) return;
  const { model, url } = shown;
  const blob = new Blob([model.bytes ?? model.text ?? ''], { type: model.mime || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileNameFor(url || '', model.mime);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  toast(`Saved ${a.download}`);
}
