# Changelog

All notable changes to Postcat are listed here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## Unreleased

<!-- Entries go under ### Added / ### Changed / ### Fixed / ### Removed; add only the subsections you need. -->

### Changed
- Ask for consent before recording or importing network traffic from DevTools.
- Encrypt saved requests with a passphrase and migrate existing collections during setup.
- Limit host access to HTTP and HTTPS and keep filter text in the current panel only.
- Rewrite the Chrome Web Store description around the request debugging workflow.

## 0.2.1 — 2026-11-04

### Changed
- Describe Postcat as an API client in DevTools and document its privacy practices for the Chrome Web Store.

### Fixed
- Keep cancellation isolated between DevTools windows, cancel queued requests immediately, and
  replay Unicode URL credentials correctly.
- Preserve cURL quoting, custom methods, empty headers and query parameters before fragments;
  accept cURL executable paths in the panel and reject unfinished quoted commands.
- Decode UTF-16 big-endian responses correctly, keep binary previews from copying stale text,
  search Unicode responses safely and round media durations across minute boundaries.
- Report already formatted JSON correctly when Beautify has nothing to change.
- Recover capture after storage read failures without overwriting unread collections, retain
  write-error notices and validate stored layout dimensions.
- Apply the captured-request cap consistently to duplication and undo.
- Require the exact release commit title before tagging, allowing GitHub's squash PR suffix.

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
