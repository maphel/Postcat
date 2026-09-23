# Postcat

[![check](https://github.com/maphel/Postcat/actions/workflows/check.yml/badge.svg)](https://github.com/maphel/Postcat/actions/workflows/check.yml)

A small Postman inside Chrome DevTools. Postcat records the requests of the page you are
inspecting, lets you edit and resend them, and keeps the ones you need in a collection.

- **Capture** – every request of the inspected tab, with its response body. "Import log" adds
  what DevTools recorded before the panel was opened.
- **Edit** – method, URL, query params (table), headers (table or bulk text), body with live
  JSON validation. Paste a cURL command to import it; copy any request as cURL.
- **Send** – from the extension, so CORS does not apply and headers like `Cookie`, `Origin` or
  `User-Agent` can be set. Compare the recorded response with the new one.
- **Inspect** – JSON with syntax colours, images, SVG, video, audio, PDF, fonts, HTML (sandboxed),
  hex for anything else. Search with ⌘F, save the body as a file.
- **Keep** – a saved collection with autosave and undo.

Works in Chrome, Brave and other Chromium browsers (version 116 or newer).

## Install

1. Download `postcat-<version>.zip` from the [latest release](https://github.com/maphel/Postcat/releases)
   and unzip it, or clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and pick the
   folder that contains `manifest.json`.
3. Open DevTools on any page and switch to the **Postcat** tab.

After updating the code, reload the extension on `chrome://extensions`, then close and reopen DevTools.

## Usage

**Recording** is on by default; the **XHR/Fetch** switch limits it to API calls (turn it off to
record images, fonts and documents). The **filter** matches `METHOD url` as plain text or `/regex/`.

**Editing** a captured request marks it with ● in the list; **Reset** restores the recorded
version. **Save** copies it into the collection (tab "Saved"), where changes are saved automatically.

**Sending** shows the status, timing and size. While a request runs, the button turns into
**Cancel**. Failures explain the cause (unreachable host, timeout, invalid header, offline).
For captured requests, **Recorded / Sent** switches between the original and the replay.

**Responses** are shown by type; **Preview / Raw** switches between the rendered view and the
source or hex dump. The type is taken from the `Content-Type` header, or sniffed from the first
bytes when the header is missing or generic.

| Keys | Action |
|---|---|
| `Enter` in the URL field, `⌘/Ctrl + Enter` | Send |
| `⌘/Ctrl + S` | Save to collection |
| `⌘/Ctrl + F` | Search the response (DevTools' search bar) |
| `↑` `↓` | Move through the list |
| `/` | Focus the filter |
| `Del` | Delete (undo from the toast) |

## How replay works

Requests are sent by the extension's service worker with `<all_urls>` host permission.
Headers that `fetch()` refuses to set (`Cookie`, `Origin`, `Referer`, `User-Agent`,
`Accept-Encoding`) are applied through a short-lived `declarativeNetRequest` rule that is
scoped to the exact target origin and removed after the request.

- Cookies are exactly what is in the editor. The browser's cookie jar is neither read nor
  changed; delete the `Cookie` line to send without a session.
- `Origin` is removed unless you set it, because servers often reject `chrome-extension://`.
- `Host`, `Content-Length`, `Connection`, `Sec-*` and HTTP/2 pseudo headers are managed by the
  browser and ignored. Header values must be Latin-1.
- Only `http(s)` URLs are sent. Credentials in the URL become Basic auth; repeated headers are merged.
- Bodies are read up to 50 MB; binary bodies over 25 MB are not transferred to the panel.

### Limitations

- Recording works only while DevTools is open on the tab. After a navigation, "Import log"
  only finds earlier requests if "Preserve log" is enabled in the Network panel.
- Chrome keeps no copy of responses a page reads with `fetch().blob()` or streams; Postcat
  offers to send the request again instead.
- File uploads (multipart bodies) are recorded as text and may not replay byte-exact.
- Saved requests are stored in `chrome.storage.local` in plain text, including any `Cookie`
  or `Authorization` headers. Remove headers you do not need before saving on a shared machine.
- `Set-Cookie` response headers are hidden by the Fetch API and do not show in replays.

## Development

```bash
npm install
npm run lint        # eslint
npm test            # unit tests for src/lib (node:test)
npm run test:e2e    # extension in headless Chromium with a stubbed DevTools API (Playwright)
npm run test:real   # real Chrome with real DevTools, driven over CDP
npm run check       # all of the above
npm run pack        # dist/postcat-<version>.zip
```

`manifest.json` stays in the repository root so the unpacked extension keeps its id; the code
lives in `src/` as ES modules (`src/panel/` UI, `src/lib/` pure helpers, `src/background.js`
service worker). `AGENTS.md` has the file map and the rules that keep the replay path safe.

## License

[MIT](LICENSE)
