# AGENTS.md

Guidance for AI agents and contributors working on Postcat, a Chrome MV3 DevTools extension that
captures, edits and replays requests. Vanilla JavaScript, ES modules, no build step, no runtime
dependencies. `README.md` describes the behaviour; this file describes the code.

## Layout

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest. Stays in the root so the unpacked extension's id (derived from the path) is stable |
| `icons/` | Extension icons (16/32/48/128 px) referenced by the manifest |
| `src/background.js` | Module service worker: replays requests (`postcat:send` / `postcat:cancel` messages), header rules via declarativeNetRequest |
| `src/devtools.html`, `src/devtools.js` | DevTools page (only loads the script); registers the panel and forwards DevTools' search bar to `window.postcatSearch` |
| `src/panel.html`, `src/panel.css` | Panel markup and styles; colours only via custom properties in `:root` / `:root.dark`. Three layouts (wide / medium / narrow) keyed off `data-layout`, `data-screen` and `data-view` on `.app`; menus are `[popover]` elements |
| `src/panel/main.js`, `actions.js` | Entry point: event wiring, shortcuts, boot; user actions that change the selection or which items exist |
| `src/panel/state.js`, `storage.js` | Single `state` object and selectors; `chrome.storage.local` with validation and debounced writes |
| `src/panel/capture.js`, `sending.js` | HAR entries → items (dedupe by occurrence, import); `send` / `cancelSend` / `abandonSend` |
| `src/panel/list.js`, `editor.js`, `kv-editor.js` | Request list (rAF-batched), editor tabs, key/value table |
| `src/panel/response.js`, `search.js`, `layout.js`, `dom.js` | Response rendering and previews, ⌘F search, layout modes from the panel width (ResizeObserver), narrow list/detail screens, Request/Response switcher, appearance, resizers; DOM helpers, toast, popover menus |
| `src/lib/` | Pure helpers (`headers`, `url`, `har`, `curl`, `json`, `body`, `format`; `index.js` re-exports). No DOM, no `chrome`. Shared by panel, worker and tests |
| `test/*.test.js` | Unit tests (`node:test`): `lib.test.js` covers `src/lib`, `regressions.test.js` pins fixed bugs |
| `test/e2e.js`, `test/real-devtools.js` | Playwright e2e against the stubbed `chrome.devtools`; real Chrome + DevTools over CDP |
| `test/harness.js`, `test/devtools-stub.js` | Builds and launches the extension for e2e and the screenshot script, with shared waits (`waitForRows`, `waitForSendDone`); the fake `chrome.devtools` the harness page loads before the panel |
| `scripts/pack.js`, `scripts/screenshot.js` | Zip for distribution; renders `docs/screenshot.png` (the README image) through the harness |
| `scripts/release.js`, `scripts/changelog-section.js` | `npm run release <version>` prepares the release branch (version bump, changelog), `npm run release tag` tags the merged `main`; prints one `CHANGELOG.md` section (release notes) |
| `.github/workflows/` | `check.yml` runs lint, unit, e2e and real-DevTools tests, then pack (the zip is uploaded as a workflow artifact) on push/PR; `release.yml` checks the `v*` tag against the version, runs lint/unit/e2e, packs and publishes the release with the changelog section as notes |
| `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `.github/dependabot.yml` | Bug report template and contact link for security reports; PR template with the definition-of-done checklist; monthly grouped dependency updates (npm, actions) |
| `package.json`, `eslint.config.js`, `.editorconfig`, `.gitignore` | Scripts and dev dependencies (`package-lock.json` pinned); lint rules; editor and ignore settings |
| `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` | User docs, release notes, contributor guide, security policy, MIT licence |
| `AGENTS.md`, `CLAUDE.md`, `LESSONS_LEARNED.md` | This file (`CLAUDE.md` is a symlink to it); append-only incident log |

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

## Workflow

`CONTRIBUTING.md` is the source of truth for branching, commits, the definition of done and
releases. For agents, in addition:

- Issue first: any behaviour change needs an issue, bug fixes included (open one if none
  exists, then branch as `<type>/<topic>` from `main`); typos and docs-only fixes need none.
  This is stricter than `CONTRIBUTING.md` on purpose: agents work unattended, and the issue is
  the human-readable trail of what was changed and why.
- Follow the definition of done, open a PR and request an independent review (a second agent
  or a human) before merge. Never merge your own PR unreviewed.
- Ask a human before: adding manifest `permissions` or `host_permissions`; changing the
  saved-collection storage format (`src/panel/storage.js`); cutting a release; force-pushes or
  history rewrites; dependency upgrades other than merging Dependabot PRs; changing CI
  `permissions` in `.github/workflows/`.

## Verification

```bash
npm run check   # lint, unit, e2e, real DevTools
```

Set `CHROME=/path/to/chromium` to use a specific browser. Before a release, also load the
unpacked extension in a real browser and replay one GET and one POST on a real site.
