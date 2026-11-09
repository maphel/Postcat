// Both live capture and import require the same explicit, in-panel permission.
import { $ } from './dom.js';
import { state } from './state.js';
import { persistSettings } from './storage.js';

export function withCaptureConsent(run) {
  if (state.captureConsent) {
    run();
    return;
  }
  const dialog = $('captureConsentDialog');
  if (dialog.open) return;
  dialog.returnValue = '';
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'allow') return;
    state.captureConsent = true;
    persistSettings();
    run();
  }, { once: true });
  dialog.showModal();
}
