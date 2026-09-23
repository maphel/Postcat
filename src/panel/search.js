// Search inside the response, driven by DevTools' own ⌘F bar (forwarded by devtools.js).
import { state } from './state.js';
import { $ } from './dom.js';

const search = { query: '', ranges: [], index: -1 };
const MAX_MATCHES = 5000;

// Entry point for devtools.js: action is performSearch | nextSearchResult | previousSearchResult | cancelSearch.
export function onSearch(action, query) {
  if (action === 'performSearch') {
    search.query = query || '';
    refreshSearch();
  } else if (action === 'nextSearchResult') {
    stepSearch(1);
  } else if (action === 'previousSearchResult') {
    stepSearch(-1);
  } else if (action === 'cancelSearch') {
    search.query = '';
    refreshSearch();
  }
}

// The visible, searchable response text: body (text/JSON/hex) or headers.
function searchRoot() {
  if (state.resTab === 'resHeaders') return $('resHeaders');
  const body = $('resBody');
  // Status messages ("Sending…", errors) aren't response content.
  const isMessage = body.classList.contains('muted') || body.classList.contains('error');
  return body.hidden || $('resBodyWrap').hidden || isMessage ? null : body;
}

// Re-run after every change of the visible response.
export function refreshSearch() {
  if (!window.CSS?.highlights) return;
  CSS.highlights.delete('postcat-match');
  CSS.highlights.delete('postcat-current');
  search.ranges = [];
  search.index = -1;
  const root = searchRoot();
  const query = search.query.toLowerCase();
  if (root && query) {
    // Concatenate text nodes so matches may span JSON-highlighting spans.
    const nodes = [];
    let text = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    const lower = text.toLowerCase();
    const locate = (pos) => {
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (nodes[mid].start <= pos) lo = mid;
        else hi = mid - 1;
      }
      return { node: nodes[lo].node, offset: pos - nodes[lo].start };
    };
    for (let at = lower.indexOf(query); at !== -1 && search.ranges.length < MAX_MATCHES; at = lower.indexOf(query, at + query.length)) {
      const start = locate(at);
      const end = locate(at + query.length - 1);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      search.ranges.push(range);
    }
    if (search.ranges.length) {
      CSS.highlights.set('postcat-match', new Highlight(...search.ranges));
      search.index = 0;
    }
  }
  showCurrentMatch();
}

function stepSearch(delta) {
  if (!search.ranges.length) return;
  search.index = (search.index + delta + search.ranges.length) % search.ranges.length;
  showCurrentMatch();
}

function showCurrentMatch() {
  const count = $('searchCount');
  count.hidden = !search.query || !searchRoot();
  if (count.hidden) return;
  const total = search.ranges.length;
  count.textContent = total ? `${search.index + 1} / ${total}${total >= MAX_MATCHES ? '+' : ''}` : 'No matches';
  if (!total) return;
  const range = search.ranges[search.index];
  CSS.highlights.set('postcat-current', new Highlight(range));
  const root = searchRoot();
  const r = range.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  if (r.top < box.top || r.bottom > box.bottom) root.scrollTop += r.top - box.top - box.height / 3;
  if (r.left < box.left || r.right > box.right) root.scrollLeft += r.left - box.left - 24;
}
