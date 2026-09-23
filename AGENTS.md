# AGENTS.md

Guidance for AI agents and contributors working on Postcat, a Chrome MV3 DevTools extension that
captures, edits and replays requests. Vanilla JavaScript, ES modules, no build step, no runtime
dependencies. `README.md` describes the behaviour; this file describes the code.

## Layout

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest. Stays in the root so the unpacked extension's id (derived from the path) is stable |
| `src/background.js` | Module service worker: replays requests (`postcat:send` / `postcat:cancel` messages), header rules via declarativeNetRequest |
| `src/devtools.js` | Registers the panel; forwards DevTools' search bar to `window.postcatSearch` |
| `src/panel.html`, `src/panel.css` | Panel markup and styles; colours only via custom properties in `:root` / `:root.dark` |
| `src/panel/main.js` | Entry point: event wiring, shortcuts, boot |
| `src/panel/state.js`, `storage.js` | Single `state` object and selectors; `chrome.storage.local` with validation and debounced writes |
| `src/panel/capture.js`, `sending.js` | HAR entries → items (dedupe by occurrence, import); `send` / `cancelSend` / `abandonSend` |
| `src/panel/list.js`, `editor.js`, `kv-editor.js` | Request list (rAF-batched), editor tabs, key/value table |
| `src/panel/response.js`, `search.js`, `layout.js`, `dom.js` | Response rendering and previews, ⌘F search, resizers, DOM helpers |
| `src/lib/` | Pure helpers (`headers`, `url`, `har`, `curl`, `json`, `body`, `format`; `index.js` re-exports). No DOM, no `chrome`. Shared by panel, worker and tests |
| `test/` | `*.test.js` unit tests (`node:test`); `e2e.js` (Playwright, stubbed `chrome.devtools`); `real-devtools.js` (real Chrome + DevTools over CDP) |
| `scripts/pack.js`, `scripts/screenshot.js` | Zip for distribution; README screenshot |
| `.github/workflows/` | `check.yml` runs `npm run check` on push/PR; `release.yml` attaches the zip to a `v*` tag release |

Module graph (top to bottom, acyclic): `main` → `actions` → `editor` / `sending` / `capture` →
`response` / `list` → `search` / `layout` / `storage` / `kv-editor` → `dom` / `state` / `lib`.
`response.js` requests a re-send through the `postcat:send` DOM event rather than importing `sending.js`.

## Rules

1. Replay runs in the service worker only. Never `fetch` from the panel or the inspected page.
2. Forbidden headers go through a declarativeNetRequest session rule scoped to `tabIds: [-1]`,
   `initiatorDomains: [chrome.runtime.id]` and the exact target origin. Sends are serialized so
   rules never overlap; the rule is removed in `finally`; bodies are read through a 50 MB cap.
3. `credentials: 'omit'`. The browser's cookie jar is never read or written.
4. Recorded response bodies are fetched at capture time (`fetchRecordedBody`), never lazily:
   DevTools drops its request ids on every navigation of the inspected page.
5. Response bodies from both paths go through `describeBody()`; binary crosses the worker→panel
   boundary as base64. Display code never re-serializes data (big integers would change).
6. `src/lib` stays pure. Behaviour of `chrome.devtools.*` is verified in `test/real-devtools.js`
   before the stub in `test/devtools-stub.js` is taught it.
7. The list renders on the next animation frame: read list state from `visibleItems()`, not the
   DOM. E2E tests poll for the expected state instead of sleeping; the real-DevTools suite is
   exempt because it drives Chrome over raw CDP without a DOM handle to poll.
8. Every path that removes an item (delete, reset, clear, cap) ends its in-flight send (`abandonSend`).
9. Everything read from `chrome.storage` is validated; one corrupt record must not break the panel.
10. Tests reach panel internals only through the DOM, and the worker only through `self.postcatSend`.
    Read-only inspection of the worker's DNR rules (`chrome.declarativeNetRequest.getSessionRules`)
    is allowed; tests never add or remove rules themselves.

## Verification

```bash
npm run check   # lint, unit, e2e, real DevTools
```

Set `CHROME=/path/to/chromium` to use a specific browser. Before a release, also load the
unpacked extension in a real browser and replay one GET and one POST on a real site.
