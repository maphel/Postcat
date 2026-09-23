# Changelog

All notable changes to Postcat are listed here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## Unreleased

<!-- Entries go under ### Added / ### Changed / ### Fixed / ### Removed; add only the subsections you need. -->

## 0.2.0 — 2026-09-23

### Added
- The options menu ends with the installed version (`Postcat 0.1.0`). On a checkout stamped with
  `npm run stamp` it also names the commit, branch and stamp time, so a reloaded unpacked
  extension shows which code is running.

### Changed
- Compact, docking-aware layout: the panel adapts to its width (list, editor and response side by
  side; list plus a Request / Response switcher; or list and details taking the full width with a
  "Requests" button), Captured / Saved are direct tabs with counts above the list, there is no
  context row above the URL bar (capture time, type and duration sit in the tooltips of the list
  row and the Recorded label; saved requests are renamed inline in their list row), the response
  header has direct Body / Headers tabs, Preview / Raw, Copy and
  Save inline (a ⋯ menu takes over only what a narrow pane cannot fit), Recorded / Sent is a
  control only when both exist, the request tabs carry their own action (Bulk edit, Beautify),
  the request-level ⋯ holds Reset, Duplicate, cURL and Delete, and the appearance can be set to
  Light, Dark or System.
- Replace the app icon with a cat and arrow-shaped smile, and add it to the README.

## 0.1.0 — 2026-09-23

First public release.

### Added
- Capture requests of the inspected tab, including response bodies; import DevTools' existing log.
- Edit method, URL, params, headers and body; cURL import and export.
- Replay from the extension: no CORS, forbidden headers via declarativeNetRequest, cancel,
  readable errors, recorded-vs-sent comparison.
- Previews for JSON, images, SVG, video, audio, PDF, fonts and HTML; hex dump for the rest;
  ⌘F search; save body as file.
- Saved collection with autosave and undo; keyboard shortcuts; light and dark theme.
