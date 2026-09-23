# AGENTS.md — Postcat

Chrome MV3 DevTools extension: capture requests (DevTools network API), edit, replay.
Vanilla JS, no build step, no runtime dependencies.

## File map

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest (`devtools_page`, module service worker, DNR + storage, `<all_urls>`). Stays in the repo root so the unpacked extension's id (path-based) is stable |
| `src/devtools.html` / `src/devtools.js` | Registers the "Postcat" panel; forwards DevTools' search bar (`panel.onSearch`) to `window.postcatSearch` |
| `src/panel.html` / `src/panel.css` | Panel markup and styles (CSS custom properties in `:root` / `:root.dark`, container queries for narrow panes) |
| `src/panel/main.js` | Entry point: DOM event wiring, keyboard shortcuts, boot |
| `src/panel/state.js` | The single `state` object, id counter, selectors (`current`, `visibleItems`, `isEdited`, …) |
| `src/panel/storage.js` | `chrome.storage.local`: saved collection + settings, validated on load, debounced writes |
| `src/panel/capture.js` | HAR entries → captured items, dedupe by occurrence, "Import log" |
| `src/panel/sending.js` | Replay via the service worker: `send`, `cancelSend`, `abandonSend` |
| `src/panel/list.js` | Request list (rAF-batched rendering) |
| `src/panel/editor.js` | URL bar, params/headers tables, body, status line |
| `src/panel/kv-editor.js` | Generic key/value table |
| `src/panel/response.js` | Status/headers/body rendering, previews (image, video, audio, pdf, font, html), hex, notices, Save |
| `src/panel/search.js` | ⌘F search with the CSS Custom Highlight API |
| `src/panel/layout.js` | Resizable sidebar/split |
| `src/panel/dom.js` | `$`, `el`, toast, clipboard |
| `src/lib/*.js` | Pure helpers, no DOM/chrome: `headers`, `url`, `har`, `curl`, `json`, `body`, `format`; `index.js` re-exports the public API. Used by the panel, the service worker and the Node tests |
| `src/background.js` | Module service worker: performs the replay (`postcat:send` / `postcat:cancel` messages) |
| `icons/` | Extension + panel icons |
| `test/lib.test.js`, `test/bugs.test.js` | `node:test` unit tests for `src/lib` (the latter are regression tests from the bugfix sprints) |
| `test/e2e.js` + `test/devtools-stub.js` | Playwright: loads the unpacked extension, tests the SW send path and the panel via a harness page with a fake `chrome.devtools` |
| `test/real-devtools.js` | Real Chrome + real DevTools over CDP: shows the panel, imports, navigates the inspected page, ⌘F |
| `eslint.config.js` | Flat config; `npm run lint` must be clean |
| `scripts/pack.js` | `npm run pack` → `dist/postcat-<version>.zip` (manifest + src + icons); checks manifest/package versions match |
| `.github/workflows/check.yml` | CI: lint, unit, e2e, real DevTools, pack (artifact) on every push and PR |

## Hard rules

1. Replay happens in the **service worker**, never via `fetch` in the panel or the inspected page.
2. Forbidden fetch headers go through a **DNR session rule** scoped to
   `tabIds: [-1]`, `initiatorDomains: [chrome.runtime.id]` and the exact target origin
   (`regexFilter`), so a redirect to a subdomain or another port doesn't inherit cookies.
   Sends are serialized so rules never overlap (the `postcatSend` test hook goes through the
   same queue); the rule is removed in `finally`. Bodies are read through a 50 MB cap.
3. `credentials: 'omit'` — the replay must never read or write the browser's cookie jar.
4. `src/lib/*` must stay pure (no `window`, `document`, `chrome`).
5. UI must work in DevTools light and dark theme (`chrome.devtools.panels.themeName`).
6. The request list renders on the next animation frame. Code (and tests) must read list
   state from `visibleItems()`, not from the DOM; e2e tests poll instead of sleeping.
7. Colors only via the CSS custom properties in `:root` / `:root.dark`.
8. Recorded response bodies are fetched **at capture/import time** (`fetchRecordedBody`), never
   lazily: DevTools invalidates request ids on every navigation of the inspected page.
9. Behavior of `chrome.devtools.*` is verified with `npm run test:real`; the stub in
   `test/devtools-stub.js` only mirrors what was verified there.
11. The panel module graph is acyclic (check: every `import` resolves to a module that doesn't
    import back). Layers, top to bottom: `main` → `actions` → `editor` / `sending` / `capture` →
    `response` / `list` → `search` / `layout` / `storage` / `kv-editor` → `dom` / `state` / `lib`.
    `response.js` asks for a re-send via the `postcat:send` DOM event instead of importing `sending.js`.
12. Tests reach panel internals only through the DOM (plus `self.postcatSend` in the worker).
10. Response bodies go through `describeBody()` (src/lib/body.js) in both paths (recorded and replay);
    rendering picks the view from its `kind`. Binary crosses the SW→panel boundary as base64.

## Verification routine

```bash
npm run check   # = lint + unit + e2e + real DevTools
```

`CHROME=/path/to/chromium` if Playwright's bundled browser isn't installed.

Then manually: load unpacked, open DevTools on a real site, record, replay one GET and one POST.
