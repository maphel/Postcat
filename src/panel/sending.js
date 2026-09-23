// Replaying requests through the service worker (see background.js).
import { parseHeaders } from '../lib/index.js';
import { state, current, nextId } from './state.js';
import { $, toast } from './dom.js';
import { renderResponse } from './response.js';
import { renderList } from './list.js';

export function requestOf(item) {
  return { method: item.method, url: item.url.trim(), headers: parseHeaders(item.headersText), body: item.body };
}

export async function send() {
  const item = current();
  if (!item || state.responses.get(item.id)?.pending) return;
  const request = requestOf(item);
  try {
    new URL(request.url);
  } catch {
    toast('That URL doesn’t look valid.');
    $('url').focus();
    return;
  }
  const sendId = `${item.id}:${nextId()}`;
  state.responses.set(item.id, { pending: true, sendId });
  item.view = 'sent';
  renderResponse();

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'postcat:send', sendId, request });
  } catch (err) {
    result = { error: err.message };
  }
  // A newer send for this item replaced this one in the meantime.
  if (state.responses.get(item.id)?.sendId !== sendId) return;
  state.responses.set(item.id, result || { error: 'No response from the background worker.' });
  if (state.selectedId === item.id) renderResponse();
  renderList();
}

export const isSending = () => !!state.responses.get(state.selectedId)?.pending;

export function cancelSend() {
  const sent = state.responses.get(state.selectedId);
  if (sent?.pending) chrome.runtime.sendMessage({ type: 'postcat:cancel', sendId: sent.sendId });
}

// For items that go away (delete, reset, clear, cap): stop their in-flight send so it doesn't
// hold the worker's queue, and return the last *finished* response (never a pending marker).
export function abandonSend(id) {
  const sent = state.responses.get(id);
  if (!sent?.pending) return sent;
  chrome.runtime.sendMessage({ type: 'postcat:cancel', sendId: sent.sendId });
  state.responses.delete(id);
  return undefined;
}
