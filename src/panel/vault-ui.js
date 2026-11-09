// The nonmodal passphrase prompt. Capture and replay remain usable while it is open.
import { $, toast } from './dom.js';
import { state } from './state.js';
import { savedStatus, unlockSaved, SAVED_PASSPHRASE_MIN } from './storage.js';

const VIEWS = {
  loading: { title: 'Loading saved collection…', text: 'Try again in a moment.' },
  unavailable: { title: 'Saved collection unavailable', text: 'Reopen DevTools to retry.' },
  corrupt: { title: 'Saved collection unreadable', text: 'The existing data has been kept.' },
  new: { title: 'Set up your saved collection', text: 'Choose a passphrase to protect saved requests.', button: 'Set up collection' },
  legacy: { title: 'Protect your saved collection', text: 'Choose a passphrase to encrypt existing requests.', button: 'Set up collection' },
  locked: { title: 'Collection locked', text: 'Unlock to see your saved requests.', button: 'Unlock collection' },
  unlocked: { title: 'Nothing saved yet', text: 'Pick a request and hit Save.', button: 'Lock collection' },
};

export const savedCollectionView = () => VIEWS[savedStatus()];

let pending = null;
let busy = false;

export async function ensureUnlocked() {
  if (state.savedLocking) return false;
  const status = savedStatus();
  if (status === 'unlocked') return true;
  const view = savedCollectionView();
  if (!view.button) {
    toast(`${view.title} ${view.text}`);
    return false;
  }
  // Only the action that opened the prompt should resume on success.
  if (pending) return false;
  const setup = status === 'new' || status === 'legacy';
  $('savedTitle').textContent = view.button;
  $('savedSubmit').textContent = view.button;
  $('savedHelp').textContent = setup
    ? `${status === 'legacy' ? 'Encrypt your existing requests with' : 'Choose'} a passphrase of at least ${SAVED_PASSPHRASE_MIN} characters. Keep it somewhere safe. It cannot be recovered.`
    : 'Enter the passphrase for your saved collection.';
  $('savedConfirmLabel').hidden = !setup;
  $('savedConfirm').disabled = !setup;
  return new Promise((resolve) => {
    pending = { resolve, setup, status, focus: document.activeElement };
    $('savedDialog').show();
    $('savedPassphrase').focus();
  });
}

function setBusy(value) {
  busy = value;
  $('savedForm').setAttribute('aria-busy', String(value));
  $('savedPassphrase').readOnly = value;
  $('savedConfirm').readOnly = value;
  $('savedSubmit').disabled = value;
  $('savedCancel').disabled = value;
}

function finish(unlocked) {
  const request = pending;
  pending = null;
  const dialog = $('savedDialog');
  const focus = document.activeElement;
  $('savedForm').reset();
  $('savedError').textContent = '';
  if (dialog.open) dialog.close();
  if (request?.focus?.checkVisibility() && (dialog.contains(focus) || focus === document.body)) request.focus.focus();
  request?.resolve(unlocked);
}

export function initSavedDialog(onUnlock) {
  const dialog = $('savedDialog');
  $('savedCancel').addEventListener('click', () => finish(false));
  dialog.addEventListener('close', () => { if (!dialog.open) finish(false); });
  dialog.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (!busy) finish(false);
  });
  $('savedForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || !pending) return;
    const passphrase = $('savedPassphrase').value;
    const error = $('savedError');
    if (pending.setup && passphrase !== $('savedConfirm').value) {
      error.textContent = 'The passphrases do not match.';
      $('savedConfirm').focus();
      return;
    }
    error.textContent = '';
    $('savedForm').reset();
    setBusy(true);
    try {
      await unlockSaved(passphrase, pending.status);
    } catch (err) {
      error.textContent = err?.message || 'Couldn’t unlock the collection.';
      $('savedPassphrase').focus();
      return;
    } finally {
      setBusy(false);
    }
    finish(true);
    onUnlock();
  });
}
