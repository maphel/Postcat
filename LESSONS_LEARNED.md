# Lessons learned

Append-only incident log. Newest entry on top.

<!-- Format:
## YYYY-MM-DD — <title>
**Symptom:** …
**Root cause:** …
**Fix:** …
**Prevention:** …
-->

## 2026-09-23 — Restructure + security review

**Symptom:** None user-visible; this round restructured the code (root monolith → `src/lib`, `src/panel`
ES modules, module service worker, ESLint) and then had the result reviewed for refactoring slips
and security. Review findings: unbounded response buffering in the worker (a streaming or
multi-hundred-MB reply could hang DevTools), header rule matching subdomains (cookies followed a
redirect to `x.api.example`), "Open in new tab" for SVG opening a document on the extension origin,
the test hook bypassing the send queue, no sender check on `onMessage`.
**Fix:** streamed reads with a 50 MB cap, exact-origin `regexFilter`, no tab link for SVG, hook
through the queue, `sender.id` check; README documents that saved requests store headers in plain text.
**Prevention:** After any structural change, run `npm run check` plus a fresh-eyes review; treat
"reads the whole body" as a bug wherever remote data is involved.

## 2026-09-23 — Bugfix sprint 2: send path, real-world request shapes, parsers

**Symptom:** Two `Cookie` lines sent only the first; `file://`/`data:` URLs were fetched; URLs with
`user:pw@` failed with a raw fetch error. Failed (status 0) and redirect responses showed the
"DevTools kept no copy … Send again" notice instead of the failure reason / redirect target.
Holding Delete removed a run of requests with one Undo; the list jumped to the selection on
every keystroke; one corrupt saved record or a `null` layout value broke the panel. In lib.js:
deep JSON nesting crashed the error locator, UTF-16 sniffed as MP3, `charset` ignored, cURL
import lost the URL to unknown value flags and mangled Windows `cmd` quoting.
**Root cause:** DNR "set" replaces instead of merging; no scheme check; recorded `_error`/
`Location` never read; no `e.repeat` guard; scrollIntoView on every render; unvalidated storage;
recursive scanner; loose MP3 sync check; `cleanMime` dropped the charset; allow-list of curl
flags too short; only POSIX quoting handled.
**Fix:** see `test/bugs.test.js` (sprint 2) and the "sprint 2" blocks in `test/e2e.js`.
**Prevention:** Fuzz the send path and the panel with real-world request shapes (scratch
scripts in this sprint: failed/blocked/redirect/multipart/preflight/websocket) whenever the
capture or send code changes; validate everything read from `chrome.storage`.

## 2026-09-23 — Bugfix sprint: big integers corrupted, params re-encoded, stuck sends

**Symptom:** (1) JSON responses showed `12345678901234567890` as `12345678901234567000`; Beautify
would *send* the corrupted ID. (2) Editing one query param re-encoded all others (`a+b` → `a%2Bb`,
signed URLs broken). (3) Deleting/resetting/clearing a request mid-send left the UI on "Cancel" and
blocked the worker queue for up to 60 s. Plus: identical same-millisecond requests deduped,
`/re/g` filter flickering, Clear+Undo losing replay results and selection, cap dropping the
selected request, late font errors overwriting other previews, SW rule-id race after restart.
**Root cause:** Formatting via `JSON.parse`/`stringify` changes values; params were rebuilt from
decoded values; items could disappear without cancelling their send; a "seen" set treated
equal keys as the same request.
**Fix:** Text-only JSON re-indent; params keep their raw text unless edited; `abandonSend()` on
every removal path; per-key counts for dedupe; see `test/bugs.test.js` and the "bugfix sprint"
block in `test/e2e.js`.
**Prevention:** Display code never re-serializes user data. Every path that removes an item must
also end its async work (sends, previews).

## 2026-09-23 — Binary responses weren't shown; fetch().blob() bodies look "empty"

**Symptom:** Common responses (images, fonts, PDFs …) showed "Binary response — not shown".
While adding previews, a real-Chrome test showed "Empty response body." for an image.
**Root cause:** (1) Only text was ever rendered; the replay path even dropped binary bytes.
(2) Chrome keeps no body copy for responses a page consumes via `fetch().blob()`
(`getContent()` returns `''`, HAR size 0) — the stubbed e2e test assumed every body is available.
**Fix:** Type detection + previews for image/svg/video/audio/pdf/font/html, hex dump for the rest,
base64 transfer from the SW. Empty-but-not-really bodies get a notice with "Send again".
**Prevention:** New stub behaviors are added only after `npm run test:real` confirms them.

## 2026-09-23 — Imported/recorded response bodies vanished after a navigation

**Symptom:** After "Import log", selecting a request showed "No response body recorded."
Live-recorded requests had the same problem once the inspected page navigated.
**Root cause:** Bodies were loaded lazily via `entry.getContent()` on click. DevTools resets
its extension request-id map on every navigation of the inspected page, so later
`getContent()` calls return nothing. The stubbed e2e test couldn't show this, and the
README even documented "no body for imported entries" as a limitation, based on the
never-verified assumption that `getHAR()` entries lack `getContent()`. They have it.
**Fix:** `fetchRecordedBody()` calls `getContent()` immediately on capture/import and keeps
the body on the item (capped at 5M chars).
**Prevention:** Anything that depends on `chrome.devtools.*` behavior gets verified in
real Chrome (`npm run test:real`), not only against the stub. Never document an API
limitation without checking it.
