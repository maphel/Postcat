# Changelog

## 0.2.0 — 2026-09-23

First public release.

- Capture requests from the DevTools network log (live + "Import log"), including response bodies,
  which are fetched immediately so they survive navigations.
- Edit method, URL, query params (table), headers (table with on/off, or bulk text), body
  (with live JSON validation) and send again from the extension: no CORS, forbidden headers
  (`Cookie`, `Origin`, `Referer`, `User-Agent`, …) via declarativeNetRequest, exact-origin scoping,
  cancel, readable error messages, 50 MB body cap.
- Response views: JSON highlighting, images, SVG, video, audio, PDF, fonts, sandboxed HTML preview,
  hex dump for everything else; Recorded/Sent comparison; Save as file; ⌘F search through
  DevTools' own search bar.
- Saved collection with autosave, undo for delete/clear, cURL import (bash and Windows cmd
  flavours) and export, keyboard shortcuts, resizable layout, light/dark theme.
- Three bugfix sprints (45 fixes, see `LESSONS_LEARNED.md`) and a restructure into ES modules
  with lint, unit, e2e and real-DevTools test suites.
