# Changelog

All notable changes to Postcat are listed here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## Unreleased

<!-- Entries go under ### Added / ### Changed / ### Fixed / ### Removed; add only the subsections you need. -->

### Changed
- Compact, docking-aware layout: the panel adapts to its width (list, editor and response side by
  side; list plus a Request / Response switcher; or list and details taking the full width with a
  "Requests" button), the response header has direct Body / Headers tabs, Preview / Raw, Copy and
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
