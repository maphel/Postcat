# Postcat

[![check](https://github.com/maphel/Postcat/actions/workflows/check.yml/badge.svg)](https://github.com/maphel/Postcat/actions/workflows/check.yml)

A tiny Postman inside Chrome DevTools. Capture the network requests of the current tab,
edit them, send them again, and keep the ones you like in a collection.

## Install

Either download `postcat-<version>.zip` from the latest
[GitHub Actions run](https://github.com/maphel/Postcat/actions) (artifact) or a
[release](https://github.com/maphel/Postcat/releases) and unzip it, or clone this repo. Then:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick the folder (the one containing `manifest.json`)
3. Open DevTools on any page → **Postcat** tab

After changing code: hit the reload icon on the extension card, then close and reopen DevTools.

## Use

- **Recording** is on by default. Requests appear on the left once they finish, with
  status and duration. **XHR/Fetch** (on by default) skips images, scripts and CSS.
- **Filter** matches `METHOD url`, as plain text or `/regex/flags`.
- **Import log** pulls in everything DevTools logged before the Postcat tab was opened,
  including response bodies. What DevTools has depends on its own Network log: after a
  navigation, earlier requests are only there if "Preserve log" is on in the Network tab.
- Select a request and edit it:
  - **Params** — query parameters as a table, kept in sync with the URL.
  - **Headers** — table with on/off checkboxes, or **Bulk edit** as plain text
    (`Name: value` per line, `#` disables a line).
  - **Body** — raw text, **{ } Beautify** formats JSON. JSON bodies (by Content-Type or shape)
    are checked live; errors show line, column and reason.
- **Send** (or Enter in the URL field) and look at the response; while it's running the button
  turns into **Cancel**. Failures say why (unreachable host, timeout, invalid header, offline).
  The response: JSON is syntax-highlighted; for captured requests,
  **Recorded / Sent** switches between the original and your replay.
- Responses are shown by type, with **Preview / Raw** where both make sense:
  images (with dimensions, checkerboard for transparency), SVG, video and audio (with player),
  PDF (Chrome's viewer), fonts (sample text), HTML (sandboxed, no scripts; Raw by default).
  Other binary data shows as a hex dump. A missing or `application/octet-stream`
  Content-Type is detected from the first bytes. **Save** writes the body to a file.
- Images, fonts, documents etc. are only recorded with **XHR/Fetch** unchecked.
- Edited captured requests get a ● in the list; **↺ Reset** restores the recorded version.
- **☆ Save** copies a request into your collection (tab "Saved", stored in
  `chrome.storage.local`). Saved requests autosave while you edit.
- **Paste a cURL command** into the URL field (replaces the request) or anywhere else
  (creates a new saved request). Chrome's "Copy as cURL" works in both the bash and the
  Windows cmd flavour; `-F` becomes a multipart body (file parts as placeholders), `-u`,
  `--oauth2-bearer`, `-r`, `-I`, `-T` are mapped.
- **⌘ cURL** copies the request as a cURL command, **Copy** copies the response body.
- Delete and Clear can be undone from the toast.
- Drag the dividers to resize; double-click resets. Layout, filter and tabs are remembered.

### Shortcuts

| Keys | Action |
|---|---|
| `Enter` (in the URL field) / `⌘/Ctrl + Enter` | Send |
| `⌘/Ctrl + F` | Search the response body or headers (DevTools' search bar; Enter / Shift+Enter step through matches) |
| `⌘/Ctrl + S` | Save to collection |
| `↑` / `↓` | Move through the list |
| `/` | Focus the filter |
| `Del` / `Backspace` | Delete (undo in the toast) |
| `Esc` | Leave the current input |

## How sending works (and its limits)

Requests are sent from the extension's service worker, not from the page:

- No CORS restrictions (the extension has `<all_urls>` host permission).
- `Cookie`, `Origin`, `Referer`, `User-Agent` can't be set via `fetch()`; Postcat sets them
  with a short-lived `declarativeNetRequest` session rule instead.
- Only `http(s)` URLs are sent. Credentials in the URL (`user:pw@host`) become Basic auth.
- Repeated headers are merged (`Cookie: a=1` + `Cookie: b=2` → `a=1; b=2`).
- **Cookies are exactly what's in the editor** (`credentials: 'omit'`). The browser's
  cookie jar is neither used nor changed by responses. Delete the `Cookie` line to send
  without a session.
- `Origin` is stripped unless you set it (servers often reject `chrome-extension://…`).
- Not sent: HTTP/2 pseudo headers (`:authority` …), `Host`, `Content-Length`,
  `Connection`, `Accept-Encoding`, `Sec-*` — the browser manages those.
- `Set-Cookie` never shows in replay responses (the Fetch spec hides it).
- CSRF tokens / short-lived auth tokens may be stale when you replay an old request.
- Binary request bodies (file uploads) aren't captured by DevTools as text and can't be replayed.
- If a page reads a response with `fetch(…).blob()` or streams it, Chrome keeps no copy for
  DevTools. Postcat says so and offers **Send again** to load it.
- Replayed binary responses over 25 MB aren't transferred to the panel; reading stops at 50 MB.
- Saved requests (tab "Saved") live in `chrome.storage.local` **in plain text**, including any
  `Cookie` / `Authorization` header you keep in them — unlike Chrome's own cookie jar, which is
  OS-encrypted. Delete headers you don't need before saving a request on a shared machine.
- Header values must be Latin-1; anything else fails with "Invalid header".
- Recording only works while DevTools is open on that tab.
- Recorded response bodies are kept in memory up to 20 M characters each (base64 for binary);
  larger ones aren't kept.

## Develop

```bash
npm i
npm run lint        # eslint
npm test            # unit tests for src/lib (node:test)
npm run test:e2e    # loads the extension in headless Chromium (Playwright), stubbed DevTools API
npm run test:real   # real Chrome + real DevTools: opens the panel, imports, navigates, ⌘F
npm run check       # all of the above
npm run pack        # dist/postcat-<version>.zip (manifest + src + icons)
```

Layout: `manifest.json` in the root (keeps the unpacked extension's id stable), code in `src/`
as ES modules (`src/panel/*` UI, `src/lib/*` pure helpers, `src/background.js` service worker),
tests in `test/`. See `AGENTS.md` for the file map and the hard rules.

Set `CHROME=/path/to/chromium` if Playwright's bundled browser isn't installed,
`SCREENSHOT=out.png` to save a screenshot of the panel from the e2e run.

## License

MIT — see `LICENSE`.
