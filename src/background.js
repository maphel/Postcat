// Sends requests on behalf of the DevTools panel.
// Runs in the service worker: host_permissions let us bypass CORS, and
// declarativeNetRequest lets us set headers fetch() refuses to set.

import { bytesToBase64, describeBody, fetchErrorMessage } from './lib/index.js';

// Managed by the network stack — never forwarded.
const SKIP_HEADERS = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'expect',
]);

// Forbidden for fetch(), but settable via declarativeNetRequest.
const DNR_HEADERS = new Set([
  'cookie', 'origin', 'referer', 'user-agent', 'dnt', 'date', 'via', 'accept-charset', 'accept-encoding',
]);

const TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 50 * 1024 * 1024;   // stop reading (and abort) beyond this — DevTools must not hang
const MAX_BINARY_BYTES = 25 * 1024 * 1024; // larger binary responses aren't transferred to the panel

let nextRuleId = 1;
const controllers = new Map(); // sendId -> AbortController (queued or in flight)

// Session rules outlive a service worker restart; drop leftovers from an interrupted send.
// This is the queue's first link, so no send can add a rule before the cleanup is done.
let queue = chrome.declarativeNetRequest.getSessionRules().then(async (rules) => {
  if (!rules.length) return;
  nextRuleId = Math.max(...rules.map((r) => r.id)) + 1;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
}).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false; // only our own pages (the panel)
  if (msg?.type === 'postcat:cancel') {
    controllers.get(msg.sendId)?.abort('cancel');
    return false;
  }
  if (msg?.type !== 'postcat:send') return false;
  const controller = new AbortController();
  const { sendId, request } = msg;
  controllers.set(sendId, controller);
  // Serialize sends so one request's header rule can never leak onto another.
  queue = queue
    .then(() => send(request, controller))
    .then(sendResponse, (err) => sendResponse(errorResult(err, request.url, controller)))
    .finally(() => controllers.delete(sendId));
  return true;
});

function errorResult(err, url, controller) {
  const cancelled = controller.signal.reason === 'cancel';
  const timedOut = controller.signal.reason === 'timeout';
  return {
    error: fetchErrorMessage(err, url, { cancelled, timedOut, timeoutMs: TIMEOUT_MS, online: navigator.onLine }),
    cancelled,
  };
}

async function send({ method, url, headers, body }, controller = new AbortController()) {
  // Cancelled while waiting in the queue.
  if (controller.signal.aborted) throw new Error('cancelled');
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs can be sent, not ${target.protocol.replace(':', '')}.`);
  }
  const fetchHeaders = new Headers();
  const ruleValues = new Map(); // lower-case header -> values (duplicates merged below)

  // fetch() refuses URLs with credentials; curl and Postman turn them into Basic auth.
  if (target.username || target.password) {
    if (!headers.some((h) => h.name.toLowerCase() === 'authorization')) {
      fetchHeaders.set('Authorization', `Basic ${btoa(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`)}`);
    }
    target.username = '';
    target.password = '';
  }

  for (const { name, value } of headers) {
    const lower = name.toLowerCase();
    if (lower.startsWith(':') || lower.startsWith('sec-') || lower.startsWith('proxy-') || SKIP_HEADERS.has(lower)) continue;
    if (DNR_HEADERS.has(lower)) {
      if (!ruleValues.has(lower)) ruleValues.set(lower, []);
      ruleValues.get(lower).push(value);
    } else {
      try {
        fetchHeaders.append(name, value);
      } catch {
        throw new Error(`Invalid header "${name}": names can only use letters, digits and -_.!#$%&'*+^\`|~, values only Latin-1 characters.`);
      }
    }
  }
  // A DNR "set" replaces, so repeated headers are merged the way HTTP does ("; " for cookies).
  const ruleHeaders = [...ruleValues].map(([header, values]) => ({
    header, operation: 'set', value: values.join(header === 'cookie' ? '; ' : ', '),
  }));
  // Without this the server sees "Origin: chrome-extension://…", which CSRF checks often reject.
  if (!ruleValues.has('origin')) {
    ruleHeaders.push({ header: 'origin', operation: 'remove' });
  }

  const ruleId = nextRuleId++;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: ruleHeaders },
      condition: {
        tabIds: [chrome.tabs.TAB_ID_NONE],
        initiatorDomains: [chrome.runtime.id],
        // Exact origin: a redirect to a subdomain or another port must not inherit the editor's cookies.
        regexFilter: `^${escapeRegex(target.origin)}/`,
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  });

  const timer = setTimeout(() => controller.abort('timeout'), TIMEOUT_MS);
  const started = performance.now();
  try {
    const init = {
      method,
      headers: fetchHeaders,
      // Cookies come only from the Cookie header in the editor; responses don't touch the browser's jar.
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    };
    if (body && method !== 'GET' && method !== 'HEAD') init.body = body;

    const res = await fetch(target.href, init);
    const { bytes, truncated, total } = await readBody(res, MAX_BODY_BYTES);
    const contentType = res.headers.get('content-type') || '';
    // Text goes over as a string; everything else (images, video, …) as base64.
    const info = truncated ? { text: null } : describeBody({ bytes, mime: contentType });
    const isText = info.text != null;
    const tooLarge = truncated || (!isText && bytes.length > MAX_BINARY_BYTES);

    return {
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      redirected: res.redirected,
      headers: [...res.headers].map(([name, value]) => ({ name, value })),
      body: isText ? info.text : null,
      bodyBase64: isText || tooLarge ? null : bytesToBase64(bytes),
      tooLarge,
      mimeType: contentType,
      // Truncated: Content-Length if the server sent one, else at least what was read before the cap.
      size: truncated ? Number(res.headers.get('content-length')) || total : bytes.length,
      time: performance.now() - started,
    };
  } finally {
    clearTimeout(timer);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  }
}

// Reads at most `limit` bytes; anything beyond is dropped and the connection cancelled.
// On truncation `total` is the byte count read before the cap tripped.
async function readBody(res, limit) {
  const chunks = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      return { bytes: new Uint8Array(0), truncated: true, total };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated: false };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Test hook: the e2e suite drives sends from inside the worker, through the same queue as the panel.
self.postcatSend = (request, controller) => {
  const result = queue.then(() => send(request, controller));
  queue = result.catch(() => {});
  return result;
};
