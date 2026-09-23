# Lessons learned

Append-only incident log, newest first. Each entry: symptom, root cause, fix, prevention.

## 2026-09-23 — CI ran the browser suites in a browser without extension support

**Symptom:** The e2e suite passed locally but timed out in CI waiting for the service worker.
**Root cause:** Without `CHROME` set, Playwright 1.49+ launches its "headless shell", which
cannot load extensions. Locally the environment variable hid this.
**Fix:** `channel: 'chromium'` / `executablePath('chromium')` in both browser suites; the
real-DevTools suite additionally needs `--no-sandbox --disable-gpu` on Linux runners.
**Prevention:** Run the suites once without `CHROME` before relying on CI; when a browser
target never appears, print Chrome's own output instead of guessing.

## 2026-09-23 — Security review after the restructure

**Symptom:** No user-visible bug. A review of the new module layout found: unbounded response
buffering in the worker, header rules matching subdomains (cookies followed a redirect to
`x.api.example`), "Open in new tab" for SVG opening a document on the extension origin.
**Fix:** Streamed reads with a 50 MB cap, exact-origin `regexFilter`, no tab link for SVG,
sender check on `onMessage`, README note on plain-text storage of saved headers.
**Prevention:** Treat "reads the whole body" as a bug wherever remote data is involved; review
after structural changes.

## 2026-09-23 — Send path and parsers against real-world input

**Symptom:** Two `Cookie` lines sent only the first; `file://` URLs were fetched; failed and
redirected requests showed the wrong notice; holding Delete removed a run of requests; UTF-16
sniffed as MP3; `charset` ignored; cURL import lost the URL to unknown flags and mangled
Windows `cmd` quoting.
**Root cause:** Header rule "set" replaces instead of merging; no scheme check; recorded
`_error` / `Location` never read; no key-repeat guard; loose sniffing; short allow-list of
curl flags; only POSIX quoting handled.
**Fix:** See `test/bugs.test.js` and the "sprint 2" blocks in `test/e2e.js`.
**Prevention:** Fuzz the send path and feed the panel real request shapes (failed, blocked,
redirect, multipart, preflight) whenever capture or send code changes.

## 2026-09-23 — Display code corrupted data

**Symptom:** `12345678901234567890` rendered as `…567000`, and Beautify would have sent it.
Editing one query param re-encoded all others (`a+b` → `a%2Bb`). Deleting a request mid-send
left the UI on "Cancel" and blocked the worker queue.
**Root cause:** Formatting through `JSON.parse` / `stringify`; params rebuilt from decoded
values; items removed without ending their send.
**Fix:** Text-only JSON re-indent; params keep their raw text unless edited; `abandonSend()` on
every removal path.
**Prevention:** Display code never re-serializes user data; removing an item always ends its
async work.

## 2026-09-23 — Response bodies vanished after a navigation

**Symptom:** After "Import log" or a page navigation, responses showed "No response body".
**Root cause:** Bodies were loaded lazily on click, but DevTools resets its request-id map on
every navigation. The stub-based test could not show this, and the README documented a
limitation that had never been verified.
**Fix:** `fetchRecordedBody()` fetches the body immediately at capture time.
**Prevention:** Anything depending on `chrome.devtools.*` is verified in real Chrome
(`npm run test:real`). Never document an API limitation without checking it.

## 2026-09-23 — Binary responses were not shown

**Symptom:** Images, fonts and PDFs showed "Binary response — not shown". Responses a page
read with `fetch().blob()` looked empty.
**Root cause:** Only text was rendered, and the replay path dropped binary bytes. Chrome keeps
no copy of bodies consumed as blobs, which the stubbed test did not model.
**Fix:** Type detection and previews per kind, base64 transfer from the worker, an explicit
notice with "Send again" for missing bodies.
**Prevention:** New stub behaviours are added only after the real-DevTools test confirms them.
