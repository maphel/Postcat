// Fake chrome.devtools for the harness page (test/harness.js) used by test/e2e.js and scripts/screenshot.js.
// Entries are pushed via window.__emit(harEntry).
window.__listeners = [];
chrome.devtools = {
  panels: { themeName: 'dark' },
  network: {
    onRequestFinished: { addListener: (fn) => window.__listeners.push(fn) },
    getHAR: (cb) => cb({ entries: window.__har || [] }),
  },
};
window.__emit = (entry) => window.__listeners.forEach((fn) => fn(entry));
